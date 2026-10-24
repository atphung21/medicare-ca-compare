import type {
  CompareRequest,
  DrugInput,
  PharmacyInput,
  PlanCategory,
} from "@/schemas/medicare";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright";

export type WizardStep =
  | "zip"
  | "plan-type"
  | "extra-help"
  | "drug-costs"
  | "drugs"
  | "pharmacies"
  | "results";

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
      images: { label: string; file: string }[];
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

async function loadPlaywright() {
  // A direct import("playwright") is bundled into the Worker. A variable import()
  // makes the Next dev server throw "expression is too dynamic".
  const specifier = "playwright";
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("playwright")>;
  return importer(specifier);
}

export function proofDirectory(proofId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(proofId)) {
    throw new Error("Unknown proof.");
  }
  return path.join(process.cwd(), "data", "proofs", proofId);
}

export async function captureMedicareProof(
  input: ProofCaptureInput,
): Promise<ProofCaptureResult> {
  const proofId =
    input.proofId && /^[0-9a-f-]{36}$/i.test(input.proofId)
      ? input.proofId
      : randomUUID();
  const dir = proofDirectory(proofId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "request.json"),
    JSON.stringify(input, null, 2),
  );

  const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
  const { chromium } = await loadPlaywright();
  if (proofBrowser) await proofBrowser.close().catch(() => undefined);
  const browser = await chromium.launch({ headless });
  proofBrowser = browser;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  let step: WizardStep = "zip";
  try {
    await page.goto(planFinderUrl(input.contractYear), {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    step = "zip";
    if (!(await submitZipAndYear(page, input))) {
      return await stop(
        page,
        dir,
        proofId,
        "zip",
        "Continue did not open the plan type page after the ZIP code.",
      );
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
      return await stop(
        page,
        dir,
        proofId,
        "plan-type",
        "The Medicare Advantage, Part D, or Medigap choice was not on the page.",
      );
    }
    if (
      !(await clickIfVisible(
        page,
        page.getByRole("button", { name: /find plans|start|continue/i }),
        5000,
      ))
    ) {
      return await stop(
        page,
        dir,
        proofId,
        "plan-type",
        "Find Plans was not on the page after the plan type choice.",
      );
    }
    if (input.planTypeFilter === "MEDIGAP") {
      const reached = await page
        .waitForURL(/medigap/i, { timeout: 15000 })
        .then(() => true)
        .catch(async () =>
          isVisible(page.getByRole("heading", { name: /medigap/i }), 4000),
        );
      if (!reached) {
        return await stop(
          page,
          dir,
          proofId,
          "plan-type",
          "The Medigap plans page did not appear.",
        );
      }
      const imageFile = "summary.png";
      await writeFile(
        path.join(dir, imageFile),
        await page.screenshot({ type: "png", fullPage: false }),
      );
      let pdf = false;
      try {
        await page.pdf({
          path: path.join(dir, "page.pdf"),
          printBackground: true,
        });
        pdf = true;
      } catch {
        pdf = false;
      }
      await writeMeta(dir, page.url());
      return {
        ok: true,
        proofId,
        medicareGovUrl: page.url(),
        imageFile,
        images: [{ label: "Medigap plans", file: imageFile }],
        pdf,
        step: "results",
      };
    }

    step = "extra-help";
    const helpChoice = page.locator(
      `input[name="helpType"][value="${input.lisLevel}"]`,
    );
    if (!(await clickIfVisible(page, helpChoice, 10000))) {
      return await stop(
        page,
        dir,
        proofId,
        "extra-help",
        "The Extra Help choice was not on the page.",
      );
    }
    if (
      !(await clickIfVisible(
        page,
        page.getByRole("button", { name: /continue|next/i }),
        4000,
      ))
    ) {
      return await stop(
        page,
        dir,
        proofId,
        "extra-help",
        "Continue was not on the Extra Help page.",
      );
    }

    step = "drug-costs";
    const yes = page
      .getByLabel(/^yes$/i)
      .or(page.locator("label").filter({ hasText: /^yes/i }));
    if (!(await clickIfVisible(page, yes, 8000))) {
      return await stop(
        page,
        dir,
        proofId,
        "drug-costs",
        "The drug-cost question was not on the page.",
      );
    }
    if (
      !(await clickIfVisible(
        page,
        page.getByRole("button", { name: /next|continue/i }),
        4000,
      ))
    ) {
      return await stop(
        page,
        dir,
        proofId,
        "drug-costs",
        "Next was not on the drug-cost question.",
      );
    }

    step = "drugs";
    for (const medication of input.medications) {
      const added = await addMedication(page, medication);
      if (!added) {
        return await stop(
          page,
          dir,
          proofId,
          "drugs",
          `Could not add ${medication.name} with its resolved strength and form.`,
        );
      }
    }
    const lastDrug = input.medications.at(-1)?.name;
    const drugList = lastDrug
      ? page.getByText(lastDrug, { exact: false }).last()
      : page.getByRole("heading", { name: /your drugs|drug list/i }).first();
    if (await isVisible(drugList, 1500))
      await drugList.scrollIntoViewIfNeeded().catch(() => undefined);
    await saveProofShot(page, dir, "drugs.png", false);
    const finishedDrugs =
      (await clickIfVisible(
        page,
        page.getByRole("button", { name: /done adding drugs/i }),
        2500,
      )) ||
      (await clickIfVisible(
        page,
        page.getByRole("button", { name: /^continue$/i }),
        5000,
      ));
    if (!finishedDrugs) {
      return await stop(
        page,
        dir,
        proofId,
        "drugs",
        "Done adding drugs was not on the page.",
      );
    }

    step = "pharmacies";
    if (!(await confirmPharmacyLocation(page, input))) {
      return await stop(
        page,
        dir,
        proofId,
        "pharmacies",
        "The pharmacy location prompt did not accept the ZIP code.",
      );
    }
    const selected = await selectPharmacies(page, input.pharmacies);
    if (!selected) {
      return await stop(
        page,
        dir,
        proofId,
        "pharmacies",
        "None of the selected pharmacies were on the page.",
      );
    }
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await page.waitForTimeout(400);
    await saveProofShot(page, dir, "pharmacies.png", true);
    if (
      !(await clickIfVisible(
        page,
        page.getByRole("button", {
          name: /continue to view plans|view plans|^continue$|^done$/i,
        }),
        8000,
      ))
    ) {
      return await stop(
        page,
        dir,
        proofId,
        "pharmacies",
        "Continue to view plans was not on the page.",
      );
    }
    const providers = page
      .getByRole("button", { name: /skip adding providers/i })
      .or(page.getByRole("link", { name: /skip adding providers/i }));
    if (
      !(await page
        .waitForURL(/search-results/i, { timeout: 4000 })
        .then(() => true)
        .catch(() => false))
    ) {
      await clickIfVisible(page, providers, 8000);
    }

    step = "results";
    const reached = await page
      .waitForURL(/search-results/i, { timeout: 25000 })
      .then(() => true)
      .catch(async () =>
        isVisible(
          page
            .getByRole("button", { name: /plan details/i })
            .or(page.getByRole("link", { name: /plan details/i })),
          8000,
        ),
      );
    if (!reached) {
      return await stop(
        page,
        dir,
        proofId,
        "results",
        "The plan results page did not appear.",
      );
    }
    await page
      .getByRole("button", { name: /plan details/i })
      .or(page.getByRole("link", { name: /plan details/i }))
      .first()
      .waitFor({ state: "visible", timeout: 25000 })
      .catch(() => undefined);
    await page.waitForTimeout(500);

    if (input.contractId && input.planId) {
      const label = `${input.contractId}-${input.planId}`;
      const card = page.getByText(label, { exact: false }).first();
      if (!(await isVisible(card, 5000))) {
        return await stop(
          page,
          dir,
          proofId,
          "results",
          `The results page did not show plan ${label}.`,
        );
      }
      await card.scrollIntoViewIfNeeded();
      const imageFile = `${input.contractId}-${input.planId}.png`;
      await writeFile(
        path.join(dir, imageFile),
        await card.screenshot({ type: "png" }),
      );
      await writeMeta(dir, page.url());
      return {
        ok: true,
        proofId,
        medicareGovUrl: page.url(),
        imageFile,
        images: proofListImages(),
        pdf: false,
        step: "results",
      };
    }

    const imageFile = "drugs.png";
    let pdf = false;
    try {
      await page.pdf({
        path: path.join(dir, "page.pdf"),
        printBackground: true,
      });
      pdf = true;
    } catch {
      pdf = false;
    }
    await writeMeta(dir, page.url());
    return {
      ok: true,
      proofId,
      medicareGovUrl: page.url(),
      imageFile,
      images: proofListImages(),
      pdf,
      step: "results",
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Medicare.gov wizard stopped.";
    return await stop(page, dir, proofId, step, message);
  }
}

async function submitZipAndYear(page: Page, input: ProofCaptureInput) {
  const zipField = page
    .locator('input[name="zipcode"]')
    .or(page.getByRole("textbox", { name: /zip code/i }))
    .first();
  if (!(await isVisible(zipField, 15000))) {
    await clickIfVisible(
      page,
      page
        .getByRole("button", { name: /continue without logging in/i })
        .or(page.getByRole("link", { name: /continue without logging in/i })),
      800,
    );
    if (!(await isVisible(zipField, 4000))) return false;
  }
  await zipField.fill(input.zipCode);
  if (!new RegExp(`[?&]year=${input.contractYear}(?:&|$)`).test(page.url())) {
    const yearLabel = input.contractYear === "2026" ? /^2026$/ : /^2027$/;
    const year = page
      .getByRole("radio", { name: yearLabel })
      .or(page.getByLabel(yearLabel));
    await clickIfVisible(page, year, 400);
  }
  const county = page
    .getByRole("radio", { name: new RegExp(input.countyName, "i") })
    .or(page.getByLabel(new RegExp(input.countyName, "i")));
  const continueButton = page
    .getByRole("button", { name: /^continue$/i })
    .filter({ visible: true })
    .last();
  const planChoices = page
    .locator("label")
    .filter({
      hasText:
        /Medicare Advantage Plan \(Part C\)|Medicare drug plan \(Part D\)|Medigap policy/i,
    });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      await county
        .first()
        .isVisible()
        .catch(() => false)
    )
      await county
        .first()
        .click({ timeout: 400 })
        .catch(() => undefined);
    await continueButton.click({ timeout: 1500 }).catch(() => undefined);
    if (await isVisible(planChoices, attempt === 0 ? 2000 : 4000)) return true;
  }
  return false;
}

async function addMedication(page: Page, medication: DrugInput) {
  let search = page.getByRole("combobox").last();
  if (!(await isVisible(search, 800))) {
    if (
      !(await clickIfVisible(
        page,
        page.getByRole("button", { name: /add another drug/i }),
        2500,
      ))
    )
      return false;
    search = page.getByRole("combobox").last();
  }
  if (!(await isVisible(search, 4000))) return false;
  await search.click();
  await search.fill(medication.name);
  const menuId = await search.getAttribute("aria-controls");
  const options = page.locator(
    menuId ? `[id="${menuId}"] [role="option"]` : '[role="option"]',
  );
  const token =
    medication.name
      .trim()
      .split(/[\s/]+/)
      .find((word) => word.length > 2) ?? medication.name.trim();
  const ready = options.filter({
    hasText: new RegExp(escapeRegExp(token), "i"),
  });
  if (!(await isVisible(ready, 700))) {
    await search.fill("");
    await search.pressSequentially(medication.name, { delay: 0 });
  }
  if (!(await isVisible(ready, 2500))) return false;
  const wantedName = compactName(medication.name);
  const texts = await options.evaluateAll((nodes) =>
    nodes.slice(0, 12).map((node) => (node.textContent ?? "").trim()),
  );
  let match = texts.findIndex((text) => compactName(text) === wantedName);
  if (match < 0 && !/[/-]/.test(medication.name))
    match = texts.findIndex(
      (text) => compactName(text).includes(wantedName) && !/[/-]/.test(text),
    );
  if (match < 0)
    match = texts.findIndex((text) => compactName(text).includes(wantedName));
  if (match < 0) return false;
  await options.nth(match).click();
  const addDrug = page.locator(".e2e-add-drug-button");
  if (!(await isVisible(addDrug, 2500))) return false;
  await addDrug.click({ timeout: 4000 });

  const dosage = page.locator('select[name="dosage"]');
  const prompt = genericPromptButtons(page).prompt;
  const deadline = Date.now() + 15000;
  while (!(await dosage.isVisible().catch(() => false))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await dosage
      .or(prompt)
      .first()
      .waitFor({ state: "visible", timeout: remaining })
      .catch(() => undefined);
    await answerGenericPrompt(page, medication.acceptGeneric, 300);
  }
  const labels = await dosage
    .locator("option")
    .evaluateAll((nodes) =>
      nodes.map((node) => (node.textContent ?? "").trim()).filter(Boolean),
    );
  const chosen = chooseDosageLabel(labels, medication);
  if (!chosen) return false;
  await dosage.selectOption({ label: chosen });
  const quantity = page.locator('input[name="quantity"]');
  if (await quantity.isVisible().catch(() => false))
    await quantity.fill(String(medication.quantityPerFill));
  const frequency = page.locator('select[name="frequency"]');
  if (await frequency.isVisible().catch(() => false)) {
    const label =
      medication.refillFrequencyMonths === "3"
        ? "Every 3 months"
        : "Every month";
    await frequency.selectOption({ label }).catch(() => undefined);
  }
  const added = await clickIfVisible(
    page,
    page.getByRole("button", { name: /add to my drug list/i }),
    4000,
  );
  if (!added) return false;
  await answerGenericPrompt(page, medication.acceptGeneric, 400);
  return true;
}

function genericPromptButtons(page: Page) {
  const generic = page
    .locator(".e2e-add-generic-drug-btn")
    .or(page.getByRole("button", { name: /add generic/i }))
    .filter({ visible: true });
  const brand = page
    .locator(".e2e-add-brand-name-drug-btn")
    .or(page.getByRole("button", { name: /continue with brand/i }))
    .filter({ visible: true });
  return { generic, brand, prompt: generic.or(brand) };
}

async function answerGenericPrompt(
  page: Page,
  acceptGeneric: boolean | undefined,
  timeout: number,
) {
  const { generic, brand, prompt } = genericPromptButtons(page);
  if (!(await isVisible(prompt, timeout))) return;
  const choice = acceptGeneric === false ? brand : generic;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await choice
      .first()
      .click({ timeout: 3000, force: attempt > 0 })
      .catch(() => undefined);
    const closed = await prompt
      .first()
      .waitFor({ state: "hidden", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (closed) return;
  }
}

async function confirmPharmacyLocation(page: Page, input: ProofCaptureInput) {
  const dialog = page.locator("#state-validator-dialog");
  if (!(await isVisible(dialog, 700))) return true;
  const zip = dialog.locator('input[type="text"]').first();
  await zip.fill(input.zipCode, { timeout: 1500 });
  await dialog.getByRole("button", { name: /^add$/i }).click({ timeout: 1500 });
  const countyName = input.countyName.split(",")[0];
  const county = dialog
    .locator("label")
    .filter({ hasText: new RegExp(escapeRegExp(countyName), "i") });
  const continueButton = dialog.locator(".e2e-state-validator-continue");
  if (await isVisible(county, 300))
    await county
      .first()
      .click({ timeout: 800 })
      .catch(() => undefined);
  await continueButton.click({ timeout: 2500 });
  return true;
}

async function selectPharmacies(page: Page, pharmacies: PharmacyInput[]) {
  const distance = page.locator('select[name="distance-filter"]');
  const name = page
    .locator('input[name="pharm-name"]')
    .or(page.getByRole("textbox", { name: /pharmacy name/i }))
    .or(page.getByPlaceholder(/pharmacy name/i))
    .first();
  await distance
    .first()
    .waitFor({ state: "attached", timeout: 1500 })
    .then(() => distance.selectOption({ label: "5 miles" }))
    .catch(() => undefined);
  if (!(await isVisible(name, 8000))) return false;
  const mailSelected =
    pharmacies.some((pharmacy) => pharmacy.isMailOrder) &&
    (await selectMailOrder(page));
  let retail = 0;
  for (const pharmacy of pharmacies) {
    if (pharmacy.isMailOrder || retail >= 5) continue;
    const picked = pharmacy.id.startsWith("custom-")
      ? await searchAndSelectNamed(page, name, distance, pharmacy.name)
      : await searchAndSelectFirst(page, name, pharmacy.chain);
    if (picked) retail += 1;
  }
  return mailSelected || retail > 0;
}

async function selectMailOrder(page: Page) {
  try {
    const box = page
      .locator('input[name="include-mail-order-pharmacy"]')
      .first();
    if ((await box.count()) > 0) {
      if (await box.isChecked().catch(() => false)) return true;
      const id = await box.getAttribute("id");
      if (id) {
        await page.locator(`label[for="${id}"]`).click({ timeout: 1200 });
        return true;
      }
    }
    return await clickIfVisible(
      page,
      page
        .getByRole("checkbox", { name: /mail-order/i })
        .or(page.getByLabel(/mail-order/i)),
      1200,
    );
  } catch {
    return false;
  }
}

async function searchAndSelectNamed(
  page: Page,
  name: Locator,
  distance: Locator,
  query: string,
) {
  const labels = (
    await distance
      .locator("option")
      .allInnerTexts()
      .catch(() => [] as string[])
  )
    .map((label) => label.trim())
    .filter(Boolean);
  const widest = [...labels].reverse().find((label) => /mile/i.test(label));
  if (widest)
    await distance.selectOption({ label: widest }).catch(() => undefined);
  await name.click({ timeout: 2000 });
  await name.fill("");
  await name.fill(query);
  const search = page
    .getByRole("button", { name: /find pharmacies|^search$/i })
    .first();
  if (await search.isVisible().catch(() => false))
    await search.click({ timeout: 3000 });
  else await name.press("Enter");
  const pattern = new RegExp(escapeRegExp(query), "i");
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const named = page.getByRole("checkbox", { name: pattern });
    if (await checkMatchingBox(named)) return true;
    const boxes = page.locator(
      'input[type="checkbox"]:not([name="include-mail-order-pharmacy"])',
    );
    const count = await boxes.count();
    for (let index = 0; index < count; index += 1) {
      const box = boxes.nth(index);
      const text = await box
        .evaluate((element) => {
          const input = element as HTMLInputElement;
          const label = input.id
            ? document.querySelector(`label[for="${input.id}"]`)
            : input.closest("label");
          const row =
            input.closest("li, tr, article") ?? label ?? input.parentElement;
          return (row?.textContent ?? "").replace(/\s+/g, " ").trim();
        })
        .catch(() => "");
      if (!pattern.test(text)) continue;
      if (await box.isChecked().catch(() => false)) return true;
      const id = await box.getAttribute("id");
      if (id)
        await page
          .locator(`label[for="${id}"]`)
          .click({ timeout: 1500 })
          .catch(() => undefined);
      else await box.check({ timeout: 1500 }).catch(() => undefined);
      if (await box.isChecked().catch(() => false)) return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

async function checkMatchingBox(boxes: Locator) {
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) {
    const box = boxes.nth(index);
    if (!(await box.isVisible().catch(() => false))) continue;
    if (await box.isChecked().catch(() => false)) return true;
    const id = await box.getAttribute("id");
    if (id) {
      const label = box.page().locator(`label[for="${id}"]`);
      if ((await label.count()) > 0)
        await label
          .first()
          .click({ timeout: 1500 })
          .catch(() => undefined);
      else await box.check({ timeout: 1500 }).catch(() => undefined);
    } else {
      await box.check({ timeout: 1500 }).catch(() => undefined);
    }
    if (await box.isChecked().catch(() => false)) return true;
  }
  return false;
}

async function searchAndSelectFirst(page: Page, name: Locator, chain: string) {
  const boxes = page.locator(
    'input[type="checkbox"]:not([name="include-mail-order-pharmacy"])',
  );
  await name.click({ timeout: 2000 });
  await name.fill("");
  await name.fill(chain);
  await page
    .getByRole("button", { name: /find pharmacies|^search$/i })
    .first()
    .click({ timeout: 3000 });
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if ((await boxes.count()) >= 1) {
      const box = boxes.nth(0);
      const id = await box.getAttribute("id");
      const label = id ? page.locator(`label[for="${id}"]`) : null;
      if (label && (await label.isVisible().catch(() => false))) {
        if (!(await box.isChecked().catch(() => false)))
          await label.click({ timeout: 1500 });
        return true;
      }
      if (await box.isVisible().catch(() => false)) {
        if (!(await box.isChecked().catch(() => false)))
          await box.check({ timeout: 1500 });
        return true;
      }
    }
    await page.waitForTimeout(80);
  }
  return false;
}

async function stop(
  page: Page,
  dir: string,
  proofId: string,
  step: WizardStep,
  detail: string,
): Promise<ProofCaptureResult> {
  try {
    await writeFile(
      path.join(dir, "failure.png"),
      await page.screenshot({ type: "png", fullPage: false }),
    );
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
  const id = await target
    .evaluate((element) =>
      element instanceof HTMLInputElement ? element.id : "",
    )
    .catch(() => "");
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

function proofListImages() {
  return [
    { label: "Added drugs", file: "drugs.png" },
    { label: "Added pharmacies", file: "pharmacies.png" },
  ];
}

async function saveProofShot(
  page: Page,
  dir: string,
  file: string,
  viewportOnly: boolean,
) {
  const image = await page.screenshot({ type: "png", fullPage: !viewportOnly });
  await writeFile(path.join(dir, file), image);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function strengthTokens(value: string) {
  const text = value.toLowerCase();
  const range = text.match(
    /(\d+(?:\.\d+)?)\s*(mg|mcg|ml|unt|meq|g|%)?\s*[/-]\s*(\d+(?:\.\d+)?)\s*(mg|mcg|ml|unt|meq|g|%)/,
  );
  if (range) {
    const unit = range[4] || range[2] || "mg";
    return [
      `${inMg(Number(range[1]), range[2] || unit)}-${inMg(Number(range[3]), unit)}`,
    ];
  }
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(mg|mcg|ml|unt|meq|g|%)/g)].map(
    (match) => inMg(Number(match[1]), match[2]),
  );
}

function inMg(value: number, unit: string) {
  if (unit === "mcg") return `${Number((value / 1000).toFixed(6))}mg`;
  if (unit === "g") return `${Number((value * 1000).toFixed(6))}mg`;
  return `${value}${unit}`;
}

function chooseDosageLabel(labels: string[], medication: DrugInput) {
  const wantedStrength = strengthTokens(medication.strength);
  if (wantedStrength.length === 0) return undefined;
  const rules = dosageRules(medication);
  const matches = labels.filter((label) => {
    const text = label.toLowerCase();
    const sameStrength =
      strengthTokens(text).join("|") === wantedStrength.join("|");
    return (
      sameStrength &&
      rules.required.every((pattern) => pattern.test(text)) &&
      rules.blocked.every((pattern) => !pattern.test(text))
    );
  });
  return matches.sort((left, right) => left.length - right.length)[0];
}

function dosageRules(medication: DrugInput) {
  const label =
    `${medication.dosageFormLabel ?? ""} ${medication.dosageForm}`.toLowerCase();
  const extended = /extended release|24\s*hr|\ber\b|modified/.test(label);
  const disintegrating = /disintegrat/.test(label);
  const capsule =
    medication.dosageForm === "CAPSULE" ||
    /capsule/.test(medication.dosageFormLabel ?? "");
  const tablet =
    !capsule &&
    (medication.dosageForm === "TABLET" ||
      /tablet/.test(medication.dosageFormLabel ?? ""));
  const required: RegExp[] = [];
  const blocked: RegExp[] = [];
  if (extended) required.push(/extended release|24\s*hr|\ber\b|\bxr\b/);
  else blocked.push(/extended release|24\s*hr/);
  if (disintegrating) required.push(/disintegrat/);
  else if (tablet) blocked.push(/disintegrat/);
  if (/powder/.test(label)) required.push(/powder/);
  if (/solution/.test(label) && !/tablet|capsule/.test(label))
    required.push(/solution/);
  if (/suspension/.test(label)) required.push(/suspension/);
  if (capsule) {
    required.push(/capsule/);
    blocked.push(/tablet/);
  } else if (tablet) {
    required.push(/tablet/);
    blocked.push(/capsule/);
  } else if (medication.dosageForm === "INJECTABLE_PEN")
    required.push(/pen|injector/);
  else if (medication.dosageForm === "INHALER") required.push(/inhal/);
  else if (medication.dosageForm === "CREAM")
    required.push(/cream|ointment|gel/);
  else if (medication.dosageForm === "DROPS")
    required.push(/drop|ophthalmic|otic/);
  else if (medication.dosageForm === "VIAL")
    required.push(/inject|vial|solution/);
  return { required, blocked };
}

async function writeMeta(
  dir: string,
  medicareGovUrl: string,
  step?: WizardStep,
) {
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        medicareGovUrl,
        step: step ?? "results",
      },
      null,
      2,
    ),
  );
}
