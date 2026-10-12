import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CompareRequest, DrugInput, PharmacyInput, PlanCategory } from "@/schemas/medicare";
import type { Browser, Locator, Page } from "playwright";

export type WizardStep = "zip" | "plan-type" | "extra-help" | "drug-costs" | "drugs" | "pharmacies" | "results";

export interface ProofCaptureInput extends CompareRequest {
  contractId?: string;
  planId?: string;
  proofId?: string;
  planTypeFilter?: PlanCategory;
}

export type ProofCaptureResult =
  | {
      ok: true;
      proofId: string;
      medicareGovUrl: string;
      imageFile: string;
      pdf: boolean;
      step?: WizardStep;
    }
  | {
      ok: false;
      proofId: string;
      medicareGovUrl: string;
      error: string;
      step: WizardStep;
      imageFile: string;
    };

function planFinderUrl(contractYear: "2026" | "2027") {
  return `https://www.medicare.gov/plan-compare/#/?lang=en&year=${contractYear}`;
}

let proofBrowser: Browser | null = null;

export function proofDirectory(proofId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(proofId)) {
    throw new Error("Unknown proof.");
  }
  return path.join(process.cwd(), "data", "proofs", proofId);
}

export async function captureMedicareProof(input: ProofCaptureInput): Promise<ProofCaptureResult> {
  const proofId = input.proofId && /^[0-9a-f-]{36}$/i.test(input.proofId) ? input.proofId : randomUUID();
  const dir = proofDirectory(proofId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "request.json"), JSON.stringify(input, null, 2));

  const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
  const { chromium } = await import("playwright");
  if (proofBrowser) await proofBrowser.close().catch(() => undefined);
  const browser = await chromium.launch({ headless });
  proofBrowser = browser;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  let step: WizardStep = "zip";
  try {
    await page.goto(planFinderUrl(input.contractYear), { waitUntil: "domcontentloaded", timeout: 45000 });

    step = "zip";
    if (!(await submitZipAndYear(page, input))) {
      return await stop(page, dir, proofId, "zip", "Continue did not open the plan type page after the ZIP code.");
    }

    step = "plan-type";
    const planType =
      input.planTypeFilter === "PDP"
        ? /Medicare drug plan \(Part D\)/i
        : input.planTypeFilter === "MEDIGAP"
          ? /Medigap policy/i
          : /Medicare Advantage Plan \(Part C\)/i;
    const planChoice = page.locator("label").filter({ hasText: planType });
    if (!(await clickIfVisible(page, planChoice, 8000))) {
      return await stop(page, dir, proofId, "plan-type", "The Medicare Advantage, Part D, or Medigap choice was not on the page.");
    }
    if (!(await clickIfVisible(page, page.getByRole("button", { name: /find plans|start|continue/i }), 5000))) {
      return await stop(page, dir, proofId, "plan-type", "Find Plans was not on the page after the plan type choice.");
    }
    if (input.planTypeFilter === "MEDIGAP") {
      const reached = await page
        .waitForURL(/medigap/i, { timeout: 15000 })
        .then(() => true)
        .catch(async () => isVisible(page.getByRole("heading", { name: /medigap/i }), 4000));
      if (!reached) {
        return await stop(page, dir, proofId, "plan-type", "The Medigap plans page did not appear.");
      }
      const imageFile = "summary.png";
      await writeFile(path.join(dir, imageFile), await page.screenshot({ type: "png", fullPage: false }));
      let pdf = false;
      try {
        await page.pdf({ path: path.join(dir, "page.pdf"), printBackground: true });
        pdf = true;
      } catch {
        pdf = false;
      }
      await writeMeta(dir, page.url());
      return { ok: true, proofId, medicareGovUrl: page.url(), imageFile, pdf, step: "results" };
    }

    step = "extra-help";
    const helpPattern = input.lisLevel === "NONE" ? /i don't get help|none of these|do not get help/i : input.lisLevel === "PARTIAL" ? /extra help|partial|low.income subsidy/i : /medicaid|medi-cal|full extra help/i;
    const helpChoice = page.getByLabel(helpPattern).or(page.locator("label").filter({ hasText: helpPattern }));
    if (!(await clickIfVisible(page, helpChoice, 10000))) {
      return await stop(page, dir, proofId, "extra-help", "The Extra Help choice was not on the page.");
    }
    if (!(await clickIfVisible(page, page.getByRole("button", { name: /continue|next/i }), 4000))) {
      return await stop(page, dir, proofId, "extra-help", "Continue was not on the Extra Help page.");
    }

    step = "drug-costs";
    const yes = page.getByLabel(/^yes$/i).or(page.locator("label").filter({ hasText: /^yes/i }));
    if (!(await clickIfVisible(page, yes, 8000))) {
      return await stop(page, dir, proofId, "drug-costs", "The drug-cost question was not on the page.");
    }
    if (!(await clickIfVisible(page, page.getByRole("button", { name: /next|continue/i }), 4000))) {
      return await stop(page, dir, proofId, "drug-costs", "Next was not on the drug-cost question.");
    }

    step = "drugs";
    for (const medication of input.medications) {
      const added = await addMedication(page, medication);
      if (!added) {
        return await stop(page, dir, proofId, "drugs", `Could not add ${medication.name} with its resolved strength and form.`);
      }
    }
    const finishedDrugs =
      (await clickIfVisible(page, page.getByRole("button", { name: /done adding drugs/i }), 2500)) ||
      (await clickIfVisible(page, page.getByRole("button", { name: /^continue$/i }), 5000));
    if (!finishedDrugs) {
      return await stop(page, dir, proofId, "drugs", "Done adding drugs was not on the page.");
    }

    step = "pharmacies";
    if (!(await confirmPharmacyLocation(page, input))) {
      return await stop(page, dir, proofId, "pharmacies", "The pharmacy location prompt did not accept the ZIP code.");
    }
    const selected = await selectPharmacies(page, input.pharmacies);
    if (!selected) {
      return await stop(page, dir, proofId, "pharmacies", "None of the selected pharmacies were on the page.");
    }
    if (!(await clickIfVisible(page, page.getByRole("button", { name: /continue to view plans|view plans|^continue$|^done$/i }), 8000))) {
      return await stop(page, dir, proofId, "pharmacies", "Continue to view plans was not on the page.");
    }
    const providers = page.getByRole("button", { name: /skip adding providers/i }).or(page.getByRole("link", { name: /skip adding providers/i }));
    if (!(await page.waitForURL(/search-results/i, { timeout: 4000 }).then(() => true).catch(() => false))) {
      await clickIfVisible(page, providers, 8000);
    }

    step = "results";
    const reached = await page.waitForURL(/search-results/i, { timeout: 25000 }).then(() => true).catch(async () => isVisible(page.getByRole("button", { name: /plan details/i }).or(page.getByRole("link", { name: /plan details/i })), 8000));
    if (!reached) {
      return await stop(page, dir, proofId, "results", "The plan results page did not appear.");
    }
    await page.getByRole("button", { name: /plan details/i }).or(page.getByRole("link", { name: /plan details/i })).first().waitFor({ state: "visible", timeout: 25000 }).catch(() => undefined);
    await page.waitForTimeout(500);

    if (input.contractId && input.planId) {
      const label = `${input.contractId}-${input.planId}`;
      const card = page.getByText(label, { exact: false }).first();
      if (!(await isVisible(card, 5000))) {
        return await stop(page, dir, proofId, "results", `The results page did not show plan ${label}.`);
      }
      await card.scrollIntoViewIfNeeded();
      const imageFile = `${input.contractId}-${input.planId}.png`;
      await writeFile(path.join(dir, imageFile), await card.screenshot({ type: "png" }));
      await writeMeta(dir, page.url());
      return { ok: true, proofId, medicareGovUrl: page.url(), imageFile, pdf: false, step: "results" };
    }

    const imageFile = "summary.png";
    await writeFile(path.join(dir, imageFile), await page.screenshot({ type: "png", fullPage: false }));
    let pdf = false;
    try {
      await page.pdf({ path: path.join(dir, "page.pdf"), printBackground: true });
      pdf = true;
    } catch {
      pdf = false;
    }
    await writeMeta(dir, page.url());
    return { ok: true, proofId, medicareGovUrl: page.url(), imageFile, pdf, step: "results" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Medicare.gov wizard stopped.";
    return await stop(page, dir, proofId, step, message);
  }
}

async function submitZipAndYear(page: Page, input: ProofCaptureInput) {
  const zipField = page.locator('input[name="zipcode"]').or(page.getByRole("textbox", { name: /zip code/i })).first();
  if (!(await isVisible(zipField, 15000))) {
    await clickIfVisible(page, page.getByRole("button", { name: /continue without logging in/i }).or(page.getByRole("link", { name: /continue without logging in/i })), 800);
    if (!(await isVisible(zipField, 4000))) return false;
  }
  await zipField.fill(input.zipCode);
  if (!new RegExp(`[?&]year=${input.contractYear}(?:&|$)`).test(page.url())) {
    const yearLabel = input.contractYear === "2026" ? /^2026$/ : /^2027$/;
    const year = page.getByRole("radio", { name: yearLabel }).or(page.getByLabel(yearLabel));
    await clickIfVisible(page, year, 400);
  }
  const county = page.getByRole("radio", { name: new RegExp(input.countyName, "i") }).or(page.getByLabel(new RegExp(input.countyName, "i")));
  const continueButton = page.getByRole("button", { name: /^continue$/i }).filter({ visible: true }).last();
  const planChoices = page.locator("label").filter({ hasText: /Medicare Advantage Plan \(Part C\)|Medicare drug plan \(Part D\)|Medigap policy/i });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await county.first().isVisible().catch(() => false)) await county.first().click({ timeout: 400 }).catch(() => undefined);
    await continueButton.click({ timeout: 1500 }).catch(() => undefined);
    if (await isVisible(planChoices, attempt === 0 ? 2000 : 4000)) return true;
  }
  return false;
}

async function addMedication(page: Page, medication: DrugInput) {
  let search = page.getByRole("combobox").last();
  if (!(await isVisible(search, 800))) {
    if (!(await clickIfVisible(page, page.getByRole("button", { name: /add another drug/i }), 2500))) return false;
    search = page.getByRole("combobox").last();
  }
  if (!(await isVisible(search, 4000))) return false;
  await search.click();
  await search.fill(medication.name);
  const menuId = await search.getAttribute("aria-controls");
  const options = page.locator(menuId ? `[id="${menuId}"] [role="option"]` : '[role="option"]');
  const token = medication.name.trim().split(/[\s/]+/).find((word) => word.length > 2) ?? medication.name.trim();
  const ready = options.filter({ hasText: new RegExp(escapeRegExp(token), "i") });
  if (!(await isVisible(ready, 1200))) {
    await search.fill("");
    await search.pressSequentially(medication.name, { delay: 0 });
  }
  if (!(await isVisible(ready, 3500))) return false;
  const wantedName = compactName(medication.name);
  const texts = (await options.allInnerTexts()).map((text) => text.trim()).slice(0, 12);
  let match = texts.findIndex((text) => compactName(text) === wantedName);
  if (match < 0 && !/[/-]/.test(medication.name)) match = texts.findIndex((text) => compactName(text).includes(wantedName) && !/[/-]/.test(text));
  if (match < 0) match = texts.findIndex((text) => compactName(text).includes(wantedName));
  if (match < 0) return false;
  await options.nth(match).click();
  const addDrug = page.locator(".e2e-add-drug-button");
  if (!(await isVisible(addDrug, 2500))) return false;
  await addDrug.click({ timeout: 5000 });

  const dosage = page.locator('select[name="dosage"]');
  if (!(await isVisible(dosage, 5000))) return false;
  const labels = (await dosage.locator("option").allInnerTexts()).map((label) => label.trim()).filter(Boolean);
  const chosen = chooseDosageLabel(labels, medication);
  if (!chosen) return false;
  await dosage.selectOption({ label: chosen });
  const quantity = page.locator('input[name="quantity"]');
  if (await isVisible(quantity, 400)) await quantity.fill(String(medication.quantityPerFill));
  const frequency = page.locator('select[name="frequency"]');
  if (await isVisible(frequency, 400)) {
    const label = medication.refillFrequencyMonths === "3" ? "Every 3 months" : "Every month";
    await frequency.selectOption({ label }).catch(() => undefined);
  }
  return clickIfVisible(page, page.getByRole("button", { name: /add to my drug list/i }), 6000);
}

async function confirmPharmacyLocation(page: Page, input: ProofCaptureInput) {
  const dialog = page.locator("#state-validator-dialog");
  if (!(await isVisible(dialog, 700))) return true;
  const zip = dialog.locator('input[type="text"]').first();
  await zip.fill(input.zipCode, { timeout: 1500 });
  await dialog.getByRole("button", { name: /^add$/i }).click({ timeout: 1500 });
  const countyName = input.countyName.split(",")[0];
  const county = dialog.locator("label").filter({ hasText: new RegExp(escapeRegExp(countyName), "i") });
  const continueButton = dialog.locator(".e2e-state-validator-continue");
  if (await isVisible(county, 300)) await county.first().click({ timeout: 800 }).catch(() => undefined);
  await continueButton.click({ timeout: 2500 });
  return true;
}

async function selectPharmacies(page: Page, pharmacies: PharmacyInput[]) {
  const distance = page.locator('select[name="distance-filter"]');
  const name = page.locator('input[name="pharm-name"]').or(page.getByRole("textbox", { name: /pharmacy name/i })).or(page.getByPlaceholder(/pharmacy name/i)).first();
  await distance.first().waitFor({ state: "attached", timeout: 1500 }).then(() => distance.selectOption({ label: "5 miles" })).catch(() => undefined);
  if (!(await isVisible(name, 8000))) return false;
  const mailSelected = pharmacies.some((pharmacy) => pharmacy.isMailOrder) && (await selectMailOrder(page));
  let retail = 0;
  for (const pharmacy of pharmacies) {
    if (pharmacy.isMailOrder || retail >= 5) continue;
    if (await searchAndSelectFirst(page, name, pharmacy.chain)) retail += 1;
  }
  return mailSelected || retail > 0;
}

async function selectMailOrder(page: Page) {
  try {
    const box = page.locator('input[name="include-mail-order-pharmacy"]').first();
    if ((await box.count()) > 0) {
      if (await box.isChecked().catch(() => false)) return true;
      const id = await box.getAttribute("id");
      if (id) {
        await page.locator(`label[for="${id}"]`).click({ timeout: 1200 });
        return true;
      }
    }
    return await clickIfVisible(page, page.getByRole("checkbox", { name: /mail-order/i }).or(page.getByLabel(/mail-order/i)), 1200);
  } catch {
    return false;
  }
}

async function searchAndSelectFirst(page: Page, name: Locator, chain: string) {
  await name.click({ timeout: 2000 });
  await name.fill(chain);
  await page.getByRole("button", { name: /find pharmacies|^search$/i }).first().click({ timeout: 3000 });
  const results = page.locator("li, [role='listitem'], [role='option']").filter({ hasText: /\d+(?:\.\d+)?\s*miles\b/i });
  const radios = page.getByRole("radio", { name: /\d+(?:\.\d+)?\s*miles\b/i });
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (await radios.first().isVisible().catch(() => false)) {
      await clickIfVisible(page, radios.first(), 1000);
      return true;
    }
    if (await results.first().isVisible().catch(() => false)) {
      const option = results
        .first()
        .getByRole("button", { name: /^add$|^select$/i })
        .or(results.first().getByRole("radio"))
        .or(results.first().locator("label, button, a"))
        .first();
      await option.click({ timeout: 2000 });
      return true;
    }
    await page.waitForTimeout(80);
  }
  return false;
}

async function stop(page: Page, dir: string, proofId: string, step: WizardStep, detail: string): Promise<ProofCaptureResult> {
  try {
    await writeFile(path.join(dir, "failure.png"), await page.screenshot({ type: "png", fullPage: false }));
  } catch {
    // The page can close before a screenshot is available. The step name is still returned.
  }
  const medicareGovUrl = page.url();
  await writeMeta(dir, medicareGovUrl, step);
  return {
    ok: false,
    proofId,
    medicareGovUrl,
    step,
    imageFile: "failure.png",
    error: `Stopped at ${step}. ${detail} Landed on ${medicareGovUrl}. The sample comparison is still available.`,
  };
}

async function clickIfVisible(page: Page, locator: Locator, timeout: number) {
  if (!(await isVisible(locator, timeout))) return false;
  const target = locator.first();
  const id = await target.evaluate((element) => (element instanceof HTMLInputElement ? element.id : "")).catch(() => "");
  if (id) {
    const label = page.locator(`label[for="${id}"]`);
    if ((await label.count()) > 0) {
      await label.first().click({ timeout: 5000 });
      return true;
    }
  }
  await target.click({ timeout: 5000 });
  return true;
}

async function isVisible(locator: Locator, timeout: number) {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function strengthTokens(value: string) {
  const text = value.toLowerCase();
  const range = text.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|ml|unt|meq|g|%)?\s*[/-]\s*(\d+(?:\.\d+)?)\s*(mg|mcg|ml|unt|meq|g|%)/);
  if (range) {
    const unit = range[4] || range[2] || "mg";
    return [`${Number(range[1])}-${Number(range[3])}${unit}`];
  }
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mg|mcg|ml|unt|meq|g|%)/g)].map((match) => `${Number(match[1])}${match[2]}`);
}

function chooseDosageLabel(labels: string[], medication: DrugInput) {
  const wantedStrength = strengthTokens(medication.strength);
  if (wantedStrength.length === 0) return undefined;
  const rules = dosageRules(medication);
  const matches = labels.filter((label) => {
    const text = label.toLowerCase();
    const sameStrength = strengthTokens(text).join("|") === wantedStrength.join("|");
    return sameStrength && rules.required.every((pattern) => pattern.test(text)) && rules.blocked.every((pattern) => !pattern.test(text));
  });
  return matches.sort((left, right) => left.length - right.length)[0];
}

function dosageRules(medication: DrugInput) {
  const label = `${medication.dosageFormLabel ?? ""} ${medication.dosageForm}`.toLowerCase();
  const extended = /extended release|24\s*hr|\ber\b|modified/.test(label);
  const disintegrating = /disintegrat/.test(label);
  const capsule = medication.dosageForm === "CAPSULE" || /capsule/.test(medication.dosageFormLabel ?? "");
  const tablet = !capsule && (medication.dosageForm === "TABLET" || /tablet/.test(medication.dosageFormLabel ?? ""));
  const required: RegExp[] = [];
  const blocked: RegExp[] = [];
  if (extended) required.push(/extended release|24\s*hr|\ber\b/);
  else blocked.push(/extended release|24\s*hr/);
  if (disintegrating) required.push(/disintegrat/);
  else if (tablet) blocked.push(/disintegrat/);
  if (/powder/.test(label)) required.push(/powder/);
  if (/solution/.test(label) && !/tablet|capsule/.test(label)) required.push(/solution/);
  if (/suspension/.test(label)) required.push(/suspension/);
  if (capsule) {
    required.push(/capsule/);
    blocked.push(/tablet/);
  } else if (tablet) {
    required.push(/tablet/);
    blocked.push(/capsule/);
  } else if (medication.dosageForm === "INJECTABLE_PEN") required.push(/pen|injector/);
  else if (medication.dosageForm === "INHALER") required.push(/inhal/);
  else if (medication.dosageForm === "CREAM") required.push(/cream|ointment|gel/);
  else if (medication.dosageForm === "DROPS") required.push(/drop|ophthalmic|otic/);
  else if (medication.dosageForm === "VIAL") required.push(/inject|vial|solution/);
  return { required, blocked };
}

async function writeMeta(dir: string, medicareGovUrl: string, step?: WizardStep) {
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ capturedAt: new Date().toISOString(), medicareGovUrl, step: step ?? "results" }, null, 2),
  );
}
