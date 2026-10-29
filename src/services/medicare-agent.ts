import { countyBaseName } from "@/lib/us-location";
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
  /**
   * When a drug can't be added and the browser window is visible, stop on Medicare.gov's drug list
   * so the user can add it by hand, then finish with continueMedicareProof.
   */
  pauseForMissing?: boolean;
}

/** A prescription drug the proof could not add to Medicare.gov's drug list. */
export interface MissingDrug {
  name: string;
  strength: string;
  reason: string;
  /** Screenshot of what Medicare.gov showed, in the proof folder. */
  image?: string;
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
      /** Supplies Medicare.gov's drug search does not list. */
      skipped?: string[];
      missing?: MissingDrug[];
      /** Waiting on Medicare.gov's drug list for the user; finish with continueMedicareProof. */
      paused?: boolean;
    }
  | {
      ok: false;
      proofId: string;
      medicareGovUrl: string;
      error: string;
      step: WizardStep;
      imageFile: string;
      missing?: MissingDrug[];
      /** Still waiting for the user; continueMedicareProof can be tried again. */
      paused?: boolean;
    };

interface ProofSession {
  browser: Browser;
  page: Page;
  input: ProofCaptureInput;
  dir: string;
  proofId: string;
  missing: MissingDrug[];
  skipped: string[];
  timer?: ReturnType<typeof setTimeout>;
}

const PAUSE_MS = 30 * 60 * 1000;
/** Kept on globalThis so a dev-server reload doesn't lose a window the user is still working in. */
const pausedProofs: Map<string, ProofSession> = ((globalThis as { __medicarePausedProofs?: Map<string, ProofSession> })
  .__medicarePausedProofs ??= new Map());

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
  for (const [id, paused] of pausedProofs) {
    clearTimeout(paused.timer);
    pausedProofs.delete(id);
    await paused.browser.close().catch(() => undefined);
  }
  if (proofBrowser) await proofBrowser.close().catch(() => undefined);
  const browser = await chromium.launch({ headless });
  proofBrowser = browser;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  let step: WizardStep = "zip";
  const skipped: string[] = [];
  const missing: MissingDrug[] = [];
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
    const searchLog: DrugSearchLog[] = [];
    let searchLost = false;
    for (const medication of input.medications) {
      const label = [medication.name, medication.strength].filter(Boolean).join(" ");
      if (searchLost) {
        missing.push({
          name: medication.name,
          strength: medication.strength,
          reason: "Not tried: Medicare.gov's drug search did not come back after an earlier drug.",
        });
        continue;
      }
      const result = await addMedication(page, medication, searchLog);
      if (result === "added") continue;
      if (result === "not-listed" && (medication.isSupply || medication.isOtc)) {
        skipped.push(medication.name);
        await recoverDrugSearch(page);
        continue;
      }
      const image = `missing-${missing.length + 1}.png`;
      const shot = await saveProofShot(page, dir, image, true)
        .then(() => true)
        .catch(() => false);
      missing.push({
        name: medication.name,
        strength: medication.strength,
        reason: `${
          result === "not-listed"
            ? `Medicare.gov's drug search had no match for ${label}.`
            : `Medicare.gov did not take ${label} with its resolved strength and form.`
        }${offeredText(searchLog.at(-1))}`,
        ...(shot ? { image } : {}),
      });
      searchLost = !(await recoverDrugSearch(page));
    }
    await writeSearchLog(dir, searchLog);
    await returnToDrugList(page);
    const added = input.medications.length - skipped.length - missing.length;
    if (missing.length === 0 && added === 0) {
      return await stop(
        page,
        dir,
        proofId,
        "drugs",
        `${skipped.join(", ")} ${skipped.length === 1 ? "is" : "are"} not on Medicare.gov's drug list. Supplies like test strips are usually covered under Part B; vitamins and other over-the-counter items usually aren't covered by Part D.`,
      );
    }
    const session: ProofSession = { browser, page, input, dir, proofId, missing, skipped };
    if (missing.length > 0 && !headless && input.pauseForMissing) {
      return await pauseForMissingDrugs(session);
    }
    if (added === 0) {
      return {
        ...(await stop(
          page,
          dir,
          proofId,
          "drugs",
          `None of the drugs could be added automatically: ${missing.map((drug) => drug.name).join(", ")}.`,
        )),
        missing,
      };
    }
    return withLists(await finishFromDrugs(session), session);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Medicare.gov wizard stopped.";
    return { ...(await stop(page, dir, proofId, step, message)), missing };
  }
}

/** Shows the drug list, then goes through Done adding drugs, pharmacies and the plan results. */
async function finishFromDrugs(session: ProofSession): Promise<ProofCaptureResult> {
  const { page, dir, proofId, input, skipped, missing } = session;
  let step: WizardStep = "drugs";
  try {
    await returnToDrugList(page);
    const notAdded = new Set([...skipped, ...missing.map((drug) => drug.name)]);
    const lastDrug = input.medications
      .filter((medication) => !notAdded.has(medication.name))
      .at(-1)?.name;
    const drugList = lastDrug
      ? page.getByText(lastDrug, { exact: false }).last()
      : page.getByRole("heading", { name: /your drugs|drug list/i }).first();
    if (await isVisible(drugList, 1500))
      await drugList.scrollIntoViewIfNeeded().catch(() => undefined);
    await saveProofShot(page, dir, "drugs.png", false);
    const doneAdding = page.getByRole("button", { name: /done adding drugs/i });
    const continueDrugs = page.getByRole("button", { name: /^continue$/i });
    const leaveDrugs = await Promise.race([
      doneAdding
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => doneAdding)
        .catch(() => null),
      continueDrugs
        .first()
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => continueDrugs)
        .catch(() => null),
    ]);
    const finishedDrugs = leaveDrugs
      ? await clickIfVisible(page, leaveDrugs, 1000)
      : false;
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
    const resultsNow = page
      .waitForURL(/search-results/i, { timeout: 8000 })
      .then(() => "results" as const)
      .catch(() => "pending" as const);
    const skipNow = providers
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => "skip" as const)
      .catch(() => "pending" as const);
    if ((await Promise.race([resultsNow, skipNow])) === "skip") {
      await clickIfVisible(page, providers, 1000);
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
        skipped,
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
      skipped,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The Medicare.gov wizard stopped.";
    return await stop(page, dir, proofId, step, message);
  }
}

function withLists(result: ProofCaptureResult, session: ProofSession): ProofCaptureResult {
  return result.ok
    ? { ...result, skipped: session.skipped, missing: session.missing }
    : { ...result, missing: session.missing };
}

/** Leaves the visible window on Medicare.gov's drug list so the user can add the missing drugs by hand. */
async function pauseForMissingDrugs(session: ProofSession): Promise<ProofCaptureResult> {
  const { page, dir, proofId, missing, skipped } = session;
  await page
    .getByRole("heading", { name: /your drugs|drug list/i })
    .first()
    .scrollIntoViewIfNeeded({ timeout: 1500 })
    .catch(() => undefined);
  await saveProofShot(page, dir, "drugs.png", false).catch(() => undefined);
  await writeMeta(dir, page.url(), "drugs");
  await page.bringToFront().catch(() => undefined);
  keepPaused(session);
  return {
    ok: true,
    paused: true,
    proofId,
    medicareGovUrl: page.url(),
    imageFile: "drugs.png",
    images: [{ label: "Drugs added automatically", file: "drugs.png" }],
    pdf: false,
    step: "drugs",
    skipped,
    missing,
  };
}

function keepPaused(session: ProofSession) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    pausedProofs.delete(session.proofId);
    void session.browser.close().catch(() => undefined);
  }, PAUSE_MS);
  session.timer.unref?.();
  pausedProofs.set(session.proofId, session);
}

/** Finishes a paused proof after the user added drugs by hand: pharmacies, then the plan results. */
export async function continueMedicareProof(proofId: string): Promise<ProofCaptureResult> {
  const session = pausedProofs.get(proofId);
  const gone = {
    ok: false as const,
    proofId,
    medicareGovUrl: "https://www.medicare.gov/plan-compare/",
    step: "drugs" as const,
    imageFile: "",
  };
  if (!session) {
    return {
      ...gone,
      error: "That Medicare.gov window is no longer open (it closes after 30 minutes or when a new proof starts). Capture the proof again.",
    };
  }
  pausedProofs.delete(proofId);
  clearTimeout(session.timer);
  if (session.page.isClosed() || !session.browser.isConnected()) {
    return { ...gone, error: "The Medicare.gov window was closed. Capture the proof again.", missing: session.missing };
  }
  const result = withLists(await finishFromDrugs(session), session);
  if (!result.ok && result.step === "drugs" && !session.page.isClosed()) {
    keepPaused(session);
    return {
      ...result,
      paused: true,
      error: `${result.error} Go back to the drug list in the Medicare.gov window, then click Continue again.`,
    };
  }
  return result;
}

/** Leaves the add-drug search and opens the list of drugs already added. */
async function returnToDrugList(page: Page) {
  const back = page
    .getByRole("link", { name: /back to (?:your )?drug list/i })
    .or(page.getByRole("button", { name: /back to (?:your )?drug list/i }))
    .or(page.getByText(/back to (?:your )?drug list/i));
  if (await clickIfVisible(page, back, 3000)) {
    await page
      .getByRole("button", { name: /done adding drugs/i })
      .or(page.getByRole("heading", { name: /your drugs|drug list/i }))
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => undefined);
    return true;
  }
  return false;
}

/** After a drug fails, leaves the dosage page and brings back the drug search so the next drug can be added. */
async function recoverDrugSearch(page: Page) {
  const dosage = page.locator('select[name="dosage"]');
  const search = page.getByRole("combobox").and(page.locator(":not(select)"));
  const addAnother = page.getByRole("button", { name: /add another drug/i });
  const ready = async () => {
    if (await dosage.isVisible().catch(() => false)) return false;
    if (await isVisible(search, 800)) {
      await search.last().fill("").catch(() => undefined);
      return true;
    }
    return isVisible(addAnother, 500);
  };
  // The dosage page's control is a link named "Back", not a Cancel button.
  const leave = page
    .getByRole("link", { name: /^back(?: to (?:your )?drug list)?$/i })
    .or(page.getByRole("button", { name: /^(?:cancel|close|back|go back)(?: to (?:your )?drug list)?$/i }))
    .filter({ visible: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await ready()) return true;
    await page.keyboard.press("Escape").catch(() => undefined);
    if (await ready()) return true;
    await clickIfVisible(page, leave, 2000).catch(() => false);
    await page.waitForTimeout(500);
  }
  return ready();
}

/** Medicare.gov's ZIP field sometimes keeps a leftover digit after fill(); type the five digits ourselves. */
async function typeZip(zipField: Locator, zip: string) {
  await zipField.click({ timeout: 2000 }).catch(() => undefined);
  await zipField.press("ControlOrMeta+A").catch(() => undefined);
  await zipField.press("Backspace").catch(() => undefined);
  await zipField.pressSequentially(zip, { delay: 0 });
  if ((await zipField.inputValue().catch(() => "")) === zip) return;
  await zipField.evaluate((element, value) => {
    if (!(element instanceof HTMLInputElement)) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, zip);
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
  await typeZip(zipField, input.zipCode);
  if (!new RegExp(`[?&]year=${input.contractYear}(?:&|$)`).test(page.url())) {
    const yearLabel = input.contractYear === "2026" ? /^2026$/ : /^2027$/;
    const year = page
      .getByRole("radio", { name: yearLabel })
      .or(page.getByLabel(yearLabel));
    await clickIfVisible(page, year, 400);
  }
  const countyRadio = (pattern: RegExp) =>
    page.getByRole("radio", { name: pattern }).or(page.getByLabel(pattern));
  const fullCounty = countyRadio(new RegExp(escapeRegExp(input.countyName), "i"));
  const baseName = countyBaseName(input.countyName);
  const countyChoices = [fullCounty];
  if (baseName.toLowerCase() !== input.countyName.toLowerCase()) {
    countyChoices.push(
      countyRadio(new RegExp(`\\b${escapeRegExp(baseName)}\\b`, "i")),
    );
  }
  // Medicare.gov often labels the radio "Orange" while we have "Orange County".
  // Watch both at once so a short label is not stuck behind a 4s miss.
  const county = await Promise.race(
    countyChoices.map((choice) =>
      choice
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .then(() => choice)
        .catch(() => null),
    ),
  );
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
    if ((await zipField.inputValue().catch(() => "")) !== input.zipCode) {
      await typeZip(zipField, input.zipCode);
    }
    if (
      county &&
      (await county
        .first()
        .isVisible()
        .catch(() => false))
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

interface DrugSearchLog {
  name: string;
  searches: string[];
  options: string[];
  dosages: string[];
  result: AddResult;
}

type AddResult = "added" | "not-listed" | "failed";

async function addMedication(
  page: Page,
  medication: DrugInput,
  log: DrugSearchLog[],
): Promise<AddResult> {
  const entry: DrugSearchLog = {
    name: medication.name,
    searches: [],
    options: [],
    dosages: [],
    result: "failed",
  };
  log.push(entry);
  const finish = (result: AddResult) => {
    entry.result = result;
    return result;
  };

  let search = page.getByRole("combobox").last();
  if (!(await isVisible(search, 800))) {
    if (
      !(await clickIfVisible(
        page,
        page.getByRole("button", { name: /add another drug/i }),
        2500,
      ))
    )
      return finish("failed");
    search = page.getByRole("combobox").last();
  }
  if (!(await isVisible(search, 4000))) return finish("failed");

  let picked = false;
  for (const term of searchTerms(medication)) {
    entry.searches.push(term);
    const texts = await searchOptions(page, search, term);
    entry.options = texts;
    const match = medication.isSupply
      ? pickSupplyOption(texts, medication.name)
      : pickDrugOption(texts, medication.name);
    if (match < 0) continue;
    const menuId = await search.getAttribute("aria-controls");
    await page
      .locator(menuId ? `[id="${menuId}"] [role="option"]` : '[role="option"]')
      .nth(match)
      .click();
    picked = true;
    break;
  }
  if (!picked) return finish("not-listed");
  const addDrug = page.locator(".e2e-add-drug-button");
  if (!(await isVisible(addDrug, 2500))) return finish("failed");
  await addDrug.click({ timeout: 4000 });

  const dosage = page.locator('select[name="dosage"]');
  const prompt = genericPromptButtons(page).prompt;
  const deadline = Date.now() + 15000;
  while (!(await dosage.isVisible().catch(() => false))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return finish("failed");
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
  entry.dosages = labels;
  const chosen = medication.isSupply
    ? (labels.find((label) => supplyKind(label) === supplyKind(medication.name)) ?? realOptions(labels)[0])
    : chooseDosageLabel(labels, medication);
  if (!chosen) return finish("failed");
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
  if (!added) return finish("failed");
  await answerGenericPrompt(page, medication.acceptGeneric, 400);
  return finish("added");
}

/** Types a search term and returns the first dozen suggestions, or none if Medicare.gov shows no match. */
async function searchOptions(page: Page, search: Locator, term: string) {
  await search.click();
  await search.fill(term);
  const menuId = await search.getAttribute("aria-controls");
  const options = page.locator(
    menuId ? `[id="${menuId}"] [role="option"]` : '[role="option"]',
  );
  const token =
    term
      .trim()
      .split(/[\s/]+/)
      .find((word) => word.length > 2) ?? term.trim();
  const ready = options.filter({
    hasText: new RegExp(escapeRegExp(token), "i"),
  });
  if (!(await isVisible(ready, 700))) {
    await search.fill("");
    await search.pressSequentially(term, { delay: 0 });
  }
  if (!(await isVisible(ready, 2500))) return [];
  return options.evaluateAll((nodes) =>
    nodes.slice(0, 12).map((node) => (node.textContent ?? "").trim()),
  );
}

function searchTerms(medication: DrugInput) {
  if (!medication.isSupply) return [medication.name];
  const words = medication.name.split(/\s+/);
  const kindIndex = words.findIndex((word) =>
    /^(?:test|lancets|pen|insulin|sensor|meter|alcohol)$/i.test(word),
  );
  const brand = kindIndex > 0 ? words.slice(0, kindIndex).join(" ") : "";
  const terms = [medication.name, brand, brand.split(" ")[0], brand ? "" : medication.name.split(" ").at(-1) ?? ""];
  return [...new Set(terms.filter((term) => term.length > 2))];
}

function pickDrugOption(texts: string[], name: string) {
  const wantedName = compactName(name);
  let match = texts.findIndex((text) => compactName(text) === wantedName);
  if (match < 0 && !/[/-]/.test(name))
    match = texts.findIndex(
      (text) => compactName(text).includes(wantedName) && !/[/-]/.test(text),
    );
  if (match < 0)
    match = texts.findIndex((text) => compactName(text).includes(wantedName));
  return match;
}

function supplyKind(text: string) {
  const value = text.toLowerCase();
  if (/lancet/.test(value)) return "lancet";
  if (/needle/.test(value)) return "needle";
  if (/syringe/.test(value)) return "syringe";
  if (/sensor|libre|dexcom/.test(value)) return "sensor";
  if (/meter|monitor/.test(value)) return "meter";
  if (/alcohol|swab|prep pad/.test(value)) return "pad";
  return "strip";
}

function pickSupplyOption(texts: string[], name: string) {
  const brand = compactName(name.split(/\s+/)[0] ?? "");
  const kind = supplyKind(name);
  const sameBrand = (text: string) => !brand || compactName(text).includes(brand);
  const sameKind = (text: string) => supplyKind(text) === kind;
  let match = texts.findIndex((text) => sameBrand(text) && sameKind(text));
  if (match < 0 && kind === "strip")
    match = texts.findIndex((text) => sameBrand(text) && /strip/i.test(text));
  return match;
}

function realOptions(labels: string[]) {
  return labels.filter((label) => !/^(?:select|choose|--)/i.test(label));
}

function offeredText(entry: DrugSearchLog | undefined) {
  if (!entry) return "";
  if (entry.dosages.length > 0)
    return ` Medicare.gov dosages: ${realOptions(entry.dosages).slice(0, 6).join("; ")}.`;
  if (entry.options.length > 0)
    return ` Medicare.gov suggestions: ${entry.options.slice(0, 6).join("; ")}.`;
  return ` Medicare.gov had no suggestions for ${entry.searches.join(", ")}.`;
}

async function writeSearchLog(dir: string, log: DrugSearchLog[]) {
  await writeFile(path.join(dir, "drug-search.json"), JSON.stringify(log, null, 2)).catch(
    () => undefined,
  );
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
  const fullCounty = dialog
    .locator("label")
    .filter({ hasText: new RegExp(escapeRegExp(input.countyName), "i") });
  const county = (await isVisible(fullCounty, 300))
    ? fullCounty
    : dialog.locator("label").filter({
        hasText: new RegExp(`\\b${escapeRegExp(countyBaseName(input.countyName))}\\b`, "i"),
      });
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

/** Percent and per-mL strengths become one "/ml" suffix, so "2%" and "20 mg/ml" give the same tokens. */
function strengthTokens(value: string) {
  let text = value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:units?|iu)\b/g, "unt")
    .replace(/(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)\s*ml\b/g, (_, amount: string, volume: string) =>
      `${Number((Number(amount) / Number(volume)).toFixed(6))}mg/ml`,
    );
  const perMl = /%|\/\s*ml\b/.test(text);
  text = text
    .replace(/(\d+(?:\.\d+)?)\s*%/g, (_, amount: string) => `${Number((Number(amount) * 10).toFixed(6))}mg`)
    .replace(/\/\s*ml\b/g, "");
  const suffix = perMl ? "/ml" : "";
  return rawStrengthTokens(text).map((token) => token + suffix);
}

function rawStrengthTokens(text: string) {
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
  const fitsForm = (label: string) => {
    const text = label.toLowerCase();
    return (
      rules.required.every((pattern) => pattern.test(text)) &&
      rules.blocked.every((pattern) => !pattern.test(text))
    );
  };
  const matches = labels.filter(
    (label) =>
      fitsForm(label) &&
      strengthTokens(label).join("|") === wantedStrength.join("|"),
  );
  if (matches.length > 0)
    return matches.sort((left, right) => left.length - right.length)[0];
  // Medicare.gov sometimes writes the salt amount (dorzolamide HCl 22.3 mg/ml for 2%); a lone form match is that strength.
  const formOnly = realOptions(labels).filter(fitsForm);
  return formOnly.length === 1 ? formOnly[0] : undefined;
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
  const drops = medication.dosageForm === "DROPS";
  if (/powder/.test(label)) required.push(/powder/);
  if (!drops && /solution/.test(label) && !/tablet|capsule/.test(label))
    required.push(/solution/);
  if (!drops && /suspension/.test(label)) required.push(/suspension/);
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
  else if (drops) required.push(/drop|ophthalmic|otic|eye|ear|soln|solution|susp/);
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
