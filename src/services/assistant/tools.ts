import { cardsFromDraft, type CheckedMedication } from "@/lib/draft-cards";
import type { GeminiFunctionDeclaration } from "@/lib/gemini";
import { lookupZip, stateForFips } from "@/lib/us-location";
import {
  CompareRequestSchema,
  LisLevelSchema,
  PHARMACY_CATALOG,
  PlanCategorySchema,
  type CompareRequest,
  type DrugInput,
} from "@/schemas/medicare";
import { lisSchedule } from "@/services/lis";
import { parseMedicationList } from "@/services/med-list-parser";
import { captureMedicareProof } from "@/services/medicare-agent";
import { compareSamplePlans } from "@/services/medicare-compare";
import { therapeuticAlternatives } from "@/services/rxclass";
import { resolveDrugDosageForms, type DrugResolutionResult } from "@/services/rxnorm-resolver";
import { addRule, logRequest, readMemory, removeRule, setAlias } from "./memory";
import type { AssistantSession, ToolEvent } from "./session";

type Args = Record<string, unknown>;

export interface ToolOutcome {
  /** What Gemini reads back. Keep it compact; full objects stay in the session. */
  result: Record<string, unknown>;
  summary: string;
  ok?: boolean;
  images?: ToolEvent["images"];
  link?: string;
}

interface AssistantTool {
  declaration: GeminiFunctionDeclaration;
  run: (args: Args, session: AssistantSession) => Promise<ToolOutcome>;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const integer = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null);

function describe(item: CheckedMedication, index: number) {
  const drug = item.drug;
  return {
    number: index + 1,
    name: drug.name,
    strength: drug.strength || null,
    form: drug.dosageFormLabel ?? drug.dosageForm,
    quantity_per_fill: drug.quantityPerFill,
    refill_months: drug.refillFrequencyMonths,
    status: readiness(drug),
    typed: item.note.rawLine,
    ...(item.note.wasSpellCorrected ? { spell_corrected_from: item.note.originalTypedName } : {}),
    ...(item.note.strengthChoices.length > 0 ? { strength_choices: item.note.strengthChoices.slice(0, 12) } : {}),
    ...(item.forms.length > 1 && !drug.rxcui ? { form_choices: item.forms.map((variant) => variant.dosageForm) } : {}),
  };
}

function readiness(drug: DrugInput) {
  if (drug.isSupply) return "ready (supply, searched on Medicare.gov by name)";
  if (!drug.strength.trim()) return "needs strength";
  if (!drug.rxcui) return drug.resolutionStatus === "NOT_FOUND" ? "not found in RxNorm" : "needs form";
  return "ready";
}

function medicationList(session: AssistantSession) {
  return session.medications.map(describe);
}

function applyResolution(item: CheckedMedication, resolution: DrugResolutionResult): CheckedMedication {
  const locked = resolution.status === "AUTO_LOCKED" ? resolution.selectedVariant : null;
  return {
    ...item,
    forms: resolution.availableFormsForStrength,
    drug: {
      ...item.drug,
      resolutionStatus: resolution.status,
      rxcui: locked?.rxcui,
      resolvedName: locked?.fullName,
      isBrand: locked?.isBrand,
      ...(locked ? { dosageForm: locked.coarseForm, dosageFormLabel: locked.dosageForm } : {}),
    },
  };
}

/** Same follow-up the workspace does after parsing: lock a single RxNorm match when strength is known. */
async function resolveCards(cards: CheckedMedication[]) {
  return Promise.all(
    cards.map(async (item) => {
      const drug = item.drug;
      if (drug.isSupply || drug.rxcui || !drug.strength.trim() || drug.resolutionStatus === "AMBIGUOUS_FORM") return item;
      try {
        return applyResolution(item, await resolveDrugDosageForms(`${drug.name} ${drug.strength}`));
      } catch {
        return item;
      }
    }),
  );
}

function pickMedication(args: Args, session: AssistantSession) {
  const number = integer(args.number);
  if (number !== null) return number >= 1 && number <= session.medications.length ? number - 1 : -1;
  const name = text(args.name).toLowerCase();
  return session.medications.findIndex((item) => item.drug.name.toLowerCase().includes(name));
}

function compareRequest(session: AssistantSession): { request?: CompareRequest; problem?: string } {
  if (!session.zipCode || !session.county) return { problem: "Set the ZIP code (and county if asked) first." };
  if (session.medications.length === 0) return { problem: "Add medications first." };
  const notReady = session.medications.find((item) => !readiness(item.drug).startsWith("ready"));
  if (notReady) {
    return { problem: `${notReady.drug.name} is not ready: ${readiness(notReady.drug)}. Fix it with update_medication.` };
  }
  const parsed = CompareRequestSchema.safeParse({
    zipCode: session.zipCode,
    countyFips: session.county.fips,
    countyName: session.county.name,
    state: session.county.state || undefined,
    contractYear: session.contractYear,
    lisLevel: session.lisLevel,
    medications: session.medications.map((item) => item.drug),
    pharmacies: PHARMACY_CATALOG.filter((pharmacy) => session.pharmacyIds.includes(pharmacy.id)),
  });
  if (!parsed.success) return { problem: parsed.error.issues[0]?.message ?? "The comparison request is incomplete." };
  return { request: parsed.data };
}

const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

const tools: AssistantTool[] = [
  {
    declaration: {
      name: "parse_medications",
      description:
        "Read a medication list in any format (pharmacy labels, sig codes, eye drops, insulin, supplies) and add the medications to the session. Use replace=true when the user gives a new list for a new client.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The medication lines exactly as the user typed them." },
          replace: { type: "boolean", description: "Replace the current list instead of adding to it." },
        },
        required: ["text"],
      },
    },
    async run(args, session) {
      const drafts = await parseMedicationList(text(args.text));
      if (drafts.length === 0) return { ok: false, result: { error: "No medications were found." }, summary: "No medications found" };
      const cards = await resolveCards(drafts.flatMap(cardsFromDraft));
      session.medications = args.replace === true ? cards : [...session.medications, ...cards];
      return {
        result: { medications: medicationList(session) },
        summary: `Read ${cards.length} medication${cards.length === 1 ? "" : "s"}: ${cards.map((item) => item.drug.name).join(", ")}`,
      };
    },
  },
  {
    declaration: {
      name: "list_medications",
      description: "Show the medications in the session with their status and any strength or form choices still needed.",
    },
    async run(_args, session) {
      return { result: { medications: medicationList(session) }, summary: `${session.medications.length} medications in the list` };
    },
  },
  {
    declaration: {
      name: "update_medication",
      description:
        "Change one medication: pick a strength or form from its choices, change the monthly quantity or refill length, or remove it. Identify it by number (from the list) or name.",
      parameters: {
        type: "object",
        properties: {
          number: { type: "integer", description: "1-based number from the medication list." },
          name: { type: "string", description: "Drug name, if no number is given." },
          strength: { type: "string", description: "Strength such as 20 mg or 2%." },
          form: { type: "string", description: "Dosage form such as tablet, extended release, solution, pen." },
          quantity_per_fill: { type: "integer", description: "Units per fill (tablets, mL, packages)." },
          refill_months: { type: "string", enum: ["1", "3"] },
          remove: { type: "boolean" },
        },
      },
    },
    async run(args, session) {
      const index = pickMedication(args, session);
      if (index < 0) return { ok: false, result: { error: "No medication matches that.", medications: medicationList(session) }, summary: "Medication not found" };
      let item = session.medications[index];
      if (args.remove === true) {
        session.medications.splice(index, 1);
        return { result: { medications: medicationList(session) }, summary: `Removed ${item.drug.name}` };
      }
      const strength = text(args.strength);
      const form = text(args.form).toLowerCase();
      if (strength) {
        const line = [item.drug.name, strength, form || item.drug.dosageFormLabel || ""].join(" ");
        const [card] = await resolveCards((await parseMedicationList(line)).flatMap(cardsFromDraft));
        if (card) item = { ...card, drug: { ...card.drug, quantityPerFill: item.drug.quantityPerFill, refillFrequencyMonths: item.drug.refillFrequencyMonths } };
      } else if (form) {
        const variant = item.forms.find((option) => option.dosageForm.toLowerCase().includes(form));
        if (variant) {
          item = {
            ...item,
            drug: {
              ...item.drug,
              rxcui: variant.rxcui,
              resolvedName: variant.fullName,
              dosageForm: variant.coarseForm,
              dosageFormLabel: variant.dosageForm,
              isBrand: variant.isBrand,
              strength: item.drug.strength || variant.strength,
              resolutionStatus: "AUTO_LOCKED",
            },
          };
        } else {
          item = applyResolution(item, await resolveDrugDosageForms(`${item.drug.name} ${item.drug.strength} ${form}`));
        }
      }
      const quantity = integer(args.quantity_per_fill);
      if (quantity && quantity > 0) item = { ...item, drug: { ...item.drug, quantityPerFill: quantity } };
      if (args.refill_months === "1" || args.refill_months === "3") {
        item = { ...item, drug: { ...item.drug, refillFrequencyMonths: args.refill_months } };
      }
      session.medications[index] = item;
      return { result: { updated: describe(item, index) }, summary: `Updated ${item.drug.name}: ${readiness(item.drug)}` };
    },
  },
  {
    declaration: {
      name: "set_location",
      description: "Set the client's ZIP code. If the ZIP spans several counties and none is given, the choices are returned; ask the user which one.",
      parameters: {
        type: "object",
        properties: {
          zip: { type: "string", description: "5-digit US ZIP code." },
          county: { type: "string", description: "County name, when the ZIP spans several counties." },
        },
        required: ["zip"],
      },
    },
    async run(args, session) {
      const zip = text(args.zip);
      const location = await lookupZip(zip);
      if (!location || location.counties.length === 0) return { ok: false, result: { error: `ZIP ${zip} was not found.` }, summary: `ZIP ${zip} not found` };
      const wanted = text(args.county).toLowerCase();
      const county = wanted
        ? location.counties.find((choice) => choice.name.toLowerCase().includes(wanted))
        : location.counties.length === 1
          ? location.counties[0]
          : undefined;
      if (!county) {
        return {
          result: { needs_county: true, choices: location.counties.map((choice) => `${choice.name}, ${choice.state}`) },
          summary: `ZIP ${zip} spans ${location.counties.length} counties`,
        };
      }
      session.zipCode = zip;
      session.county = county;
      return { result: { zip, county: county.name, state: county.state }, summary: `ZIP ${zip}: ${county.name}, ${county.state}` };
    },
  },
  {
    declaration: {
      name: "set_options",
      description: `Change comparison options. Pharmacy ids: ${PHARMACY_CATALOG.map((pharmacy) => pharmacy.id).join(", ")} (at most five retail plus mail-order).`,
      parameters: {
        type: "object",
        properties: {
          pharmacies: { type: "array", items: { type: "string" } },
          contract_year: { type: "string", enum: ["2026", "2027"] },
          extra_help: { type: "string", enum: LisLevelSchema.options, description: "Extra Help (LIS) level." },
          plan_type: { type: "string", enum: PlanCategorySchema.options },
        },
      },
    },
    async run(args, session) {
      if (Array.isArray(args.pharmacies)) {
        const ids = args.pharmacies.map(text).filter((id) => PHARMACY_CATALOG.some((pharmacy) => pharmacy.id === id));
        if (ids.length > 0) session.pharmacyIds = ids;
      }
      if (args.contract_year === "2026" || args.contract_year === "2027") session.contractYear = args.contract_year;
      const lis = LisLevelSchema.safeParse(args.extra_help);
      if (lis.success) session.lisLevel = lis.data;
      const planType = PlanCategorySchema.safeParse(args.plan_type);
      if (planType.success) session.planType = planType.data;
      const options = {
        pharmacies: session.pharmacyIds,
        contract_year: session.contractYear,
        extra_help: session.lisLevel,
        plan_type: session.planType,
      };
      return { result: options, summary: `Options: ${session.pharmacyIds.join(", ")} · ${session.contractYear} · ${session.lisLevel} · ${session.planType}` };
    },
  },
  {
    declaration: {
      name: "resolve_drug",
      description: "Look up a drug in RxNorm and list its strengths and dosage forms. Use for questions like 'what strengths does Eliquis come in'.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    async run(args) {
      const resolution = await resolveDrugDosageForms(text(args.name));
      const variants = resolution.allVariants.slice(0, 40).map((variant) => `${variant.strength} ${variant.dosageForm}${variant.isBrand ? " (brand)" : ""}`);
      return {
        ok: resolution.status !== "NOT_FOUND",
        result: { status: resolution.status, matched: resolution.selectedVariant?.fullName ?? null, variants },
        summary: resolution.status === "NOT_FOUND" ? `${text(args.name)} not found in RxNorm` : `${text(args.name)}: ${resolution.allVariants.length} RxNorm products`,
      };
    },
  },
  {
    declaration: {
      name: "find_alternatives",
      description: "List drugs in the same therapeutic class as the given drug, for cheaper or covered alternatives.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    async run(args) {
      const resolution = await resolveDrugDosageForms(text(args.name));
      const rxcui = resolution.selectedVariant?.rxcui ?? resolution.allVariants[0]?.rxcui;
      if (!rxcui) return { ok: false, result: { error: "Drug not found in RxNorm." }, summary: `${text(args.name)} not found` };
      const alternatives = (await therapeuticAlternatives(rxcui)).slice(0, 20);
      return {
        result: { alternatives: alternatives.map((item) => `${item.name} (${item.className})`) },
        summary: `${alternatives.length} alternatives for ${text(args.name)}`,
      };
    },
  },
  {
    declaration: {
      name: "compare_plans",
      description:
        "Compare the sample plans for the session's medications, ZIP and pharmacies. These are sample planning estimates, not live Medicare.gov prices; say so.",
    },
    async run(_args, session) {
      const { request, problem } = compareRequest(session);
      if (!request) return { ok: false, result: { error: problem }, summary: problem ?? "Not ready" };
      const state = request.state ?? (stateForFips(request.countyFips) || undefined);
      const plans = compareSamplePlans({ ...request, state });
      const rows = plans
        .map((plan) => {
          const best = [...plan.pharmacyQuotes].sort((left, right) => left.totalAnnualCost - right.totalAnnualCost)[0];
          const uncovered = best?.drugBreakdowns.filter((drug) => !drug.coveredOnFormulary).map((drug) => drug.drugName) ?? [];
          return {
            plan: plan.planName,
            type: plan.planType,
            stars: plan.starRating,
            monthly_premium: money(plan.monthlyPremium),
            best_pharmacy: best?.pharmacyName,
            yearly_total: best ? best.totalAnnualCost : null,
            by_pharmacy: plan.pharmacyQuotes.map((quote) => `${quote.pharmacyName}: ${money(quote.totalAnnualCost)} (${quote.networkStatus.toLowerCase()})`),
            not_covered: uncovered,
          };
        })
        .sort((left, right) => (left.yearly_total ?? Infinity) - (right.yearly_total ?? Infinity));
      return {
        result: { sample: true, extra_help: lisSchedule(request.contractYear, request.lisLevel)?.label ?? "None", plans: rows },
        summary: `Compared ${rows.length} sample plans for ${request.countyName}, ${state ?? ""}`,
      };
    },
  },
  {
    declaration: {
      name: "run_medicare_proof",
      description:
        "Open Medicare.gov in a real browser, enter the session's ZIP, medications and pharmacies, and capture screenshots of the live plan results. Takes one to three minutes. Ask the user before running it.",
    },
    async run(_args, session) {
      const { request, problem } = compareRequest(session);
      if (!request) return { ok: false, result: { error: problem }, summary: problem ?? "Not ready" };
      const proof = await captureMedicareProof({ ...request, planTypeFilter: session.planType });
      if (!proof.ok) {
        return {
          ok: false,
          result: { error: proof.error, step: proof.step },
          summary: `Medicare.gov stopped at ${proof.step}: ${proof.error}`,
          images: proof.imageFile ? [{ label: "Where it stopped", src: `/api/medicare/proof/${proof.proofId}/${proof.imageFile}` }] : undefined,
          link: proof.medicareGovUrl,
        };
      }
      const images = proof.images.length > 0
        ? proof.images.map((image) => ({ label: image.label, src: `/api/medicare/proof/${proof.proofId}/${image.file}` }))
        : [{ label: "Medicare.gov results", src: `/api/medicare/proof/${proof.proofId}/${proof.imageFile}` }];
      return {
        result: { captured: images.map((image) => image.label), medicare_gov_url: proof.medicareGovUrl, skipped_supplies: proof.skipped ?? [] },
        summary: `Captured ${images.length} Medicare.gov screenshot${images.length === 1 ? "" : "s"}${proof.skipped?.length ? `; skipped ${proof.skipped.join(", ")} (not listed, likely Part B)` : ""}`,
        images,
        link: proof.medicareGovUrl,
      };
    },
  },
  {
    declaration: {
      name: "remember_rule",
      description: "Save an instruction to follow in every future chat, such as a default pharmacy or how to phrase answers. Use when the user says remember, always, never, or from now on.",
      parameters: { type: "object", properties: { rule: { type: "string" } }, required: ["rule"] },
    },
    async run(args) {
      const rules = await addRule(text(args.rule));
      return { result: { rules }, summary: `Remembered: ${text(args.rule)}` };
    },
  },
  {
    declaration: {
      name: "list_memory",
      description: "Show saved rules and taught medication phrases.",
    },
    async run() {
      const memory = await readMemory();
      return {
        result: { rules: memory.rules.map((rule, index) => `${index + 1}. ${rule}`), taught_phrases: memory.aliases },
        summary: `${memory.rules.length} rules, ${Object.keys(memory.aliases).length} taught phrases`,
      };
    },
  },
  {
    declaration: {
      name: "forget_rule",
      description: "Delete a saved rule by its number from list_memory or by words it contains.",
      parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
    },
    async run(args) {
      const { removed, rules } = await removeRule(text(args.match));
      return { ok: removed > 0, result: { removed, rules }, summary: removed > 0 ? `Forgot ${removed} rule${removed === 1 ? "" : "s"}` : "No rule matched" };
    },
  },
  {
    declaration: {
      name: "teach_phrase",
      description:
        "Teach the medication reader what a phrase means, so future lists read it correctly. Example: phrase 'eliquis starter' means 'apixaban 5 mg tablet'. An empty meaning removes the phrase. After teaching, re-run parse_medications on the affected line.",
      parameters: {
        type: "object",
        properties: { phrase: { type: "string" }, meaning: { type: "string" } },
        required: ["phrase", "meaning"],
      },
    },
    async run(args) {
      await setAlias(text(args.phrase), text(args.meaning));
      return { result: { phrase: text(args.phrase), meaning: text(args.meaning) }, summary: `Taught "${text(args.phrase)}" = "${text(args.meaning)}"` };
    },
  },
  {
    declaration: {
      name: "log_enhancement_request",
      description:
        "Record something the app cannot do yet or got wrong, for the developer to build. Include a real example line when there is one.",
      parameters: {
        type: "object",
        properties: { request: { type: "string" }, example: { type: "string" } },
        required: ["request"],
      },
    },
    async run(args) {
      await logRequest(text(args.request), text(args.example));
      return { result: { logged: true }, summary: `Logged for the developer: ${text(args.request)}` };
    },
  },
];

export const toolDeclarations = tools.map((tool) => tool.declaration);

export async function runTool(name: string, args: Args, session: AssistantSession): Promise<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.declaration.name === name);
  if (!tool) return { ok: false, result: { error: `Unknown tool ${name}.` }, summary: `Unknown tool ${name}` };
  try {
    return await tool.run(args ?? {}, session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The tool failed.";
    return { ok: false, result: { error: message }, summary: `${name} failed: ${message}` };
  }
}
