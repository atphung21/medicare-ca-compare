import { coarseDosageForm, type DosageForm, type ResolvedVariant } from "@/schemas/medicare";
import { listRxNormVariants } from "@/services/rxnorm-resolver";

export type DraftStatus = "READY" | "MISSING_STRENGTH" | "MULTIPLE_FORMS";

export interface StagingVariant {
  rxcui: string;
  fullName: string;
  strength: string;
  dosageForm: string;
  coarseForm: DosageForm;
  isExtendedRelease: boolean;
  isBrand: boolean;
}

export interface StagingOption {
  label: string;
  selected: boolean;
  variants: StagingVariant[];
}

export interface MedicationDraft {
  id: string;
  rawLine: string;
  drugName: string;
  dailyFrequency: number;
  monthlyQuantity: number;
  status: DraftStatus;
  strengths: StagingOption[];
  forms: StagingOption[];
}

const FALLBACK_CATALOG: Record<string, { name: string; strengths: string[]; forms: { label: string; extended: boolean }[] }> = {
  metformin: {
    name: "Metformin",
    strengths: ["500 mg", "850 mg", "1000 mg"],
    forms: [
      { label: "Oral Tablet", extended: false },
      { label: "Extended Release Oral Tablet", extended: true },
    ],
  },
  "amlodipine benazepril": {
    name: "Amlodipine / Benazepril",
    strengths: ["2.5 mg / 10 mg", "5 mg / 10 mg", "5 mg / 20 mg", "5 mg / 40 mg", "10 mg / 20 mg", "10 mg / 40 mg"],
    forms: [{ label: "Oral Capsule", extended: false }],
  },
  ezetimibe: {
    name: "Ezetimibe",
    strengths: ["10 mg"],
    forms: [{ label: "Oral Tablet", extended: false }],
  },
  rosuvastatin: {
    name: "Rosuvastatin",
    strengths: ["5 mg", "10 mg", "20 mg", "40 mg"],
    forms: [
      { label: "Oral Tablet", extended: false },
      { label: "Oral Capsule", extended: false },
    ],
  },
};

export async function parseMedicationList(text: string): Promise<MedicationDraft[]> {
  const lines = await medicationLines(text);
  const drafts: MedicationDraft[] = [];
  for (const [index, line] of lines.entries()) {
    drafts.push(await parseLine(line, index));
  }
  return drafts;
}

async function medicationLines(text: string) {
  const split = splitLines(text);
  if (split.length > 1 || !process.env.GEMINI_API_KEY) return split;
  const fromGemini = await splitParagraphWithGemini(text);
  return fromGemini.length > 0 ? fromGemini : split;
}

function splitLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((line) => line.length > 1 && !/^(medications?|meds|rx|drug list)\s*:?\s*$/i.test(line));
}

async function splitParagraphWithGemini(text: string) {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: `Split this medication note into one drug per line. Keep the strength and frequency words that are already written. Do not invent a strength or a drug. Return JSON {"lines":["..."]}.\n\n${text}`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      },
    );
    if (!response.ok) return [];
    const body = await response.json();
    const raw = body?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
    const parsed = JSON.parse(raw) as { lines?: string[] };
    return (parsed.lines ?? []).map((line) => line.trim()).filter((line) => line.length > 1);
  } catch {
    return [];
  }
}

async function parseLine(line: string, index: number): Promise<MedicationDraft> {
  let working = line.toLowerCase();
  let dailyFrequency = 1;
  const slashFrequency = working.match(/(\d+)\s*(?:\/|per|x)\s*(?:day|d|daily)\b/i);
  if (slashFrequency) {
    dailyFrequency = Number(slashFrequency[1]) || 1;
    working = working.replace(slashFrequency[0], " ");
  } else if (/\b(twice\s+daily|twice\s+a\s+day|bid|2x)\b/i.test(working)) {
    dailyFrequency = 2;
    working = working.replace(/\b(twice\s+daily|twice\s+a\s+day|bid|2x)\b/gi, " ");
  } else if (/\b(three\s+times(?:\s+daily)?|tid|3x)\b/i.test(working)) {
    dailyFrequency = 3;
    working = working.replace(/\b(three\s+times(?:\s+daily)?|tid|3x)\b/gi, " ");
  } else if (/\b(once\s+daily|daily|qd|1x)\b/i.test(working)) {
    dailyFrequency = 1;
    working = working.replace(/\b(once\s+daily|daily|qd|1x)\b/gi, " ");
  }

  let extractedStrength: string | null = null;
  const combo = working.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g)?\s*[-/]\s*(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g)?/i);
  if (combo) {
    const unit = (combo[4] || combo[2] || "mg").toLowerCase();
    extractedStrength = `${combo[1]} ${unit} / ${combo[3]} ${unit}`;
    working = working.replace(combo[0], " ");
  } else {
    const single = working.match(/\b(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g|units)?\b/i);
    if (single) {
      extractedStrength = `${single[1]} ${(single[2] || "mg").toLowerCase()}`;
      working = working.replace(single[0], " ");
    }
  }

  const explicitExtended = /\b(er|xr|sr|xl|extended)\b/i.test(working);
  const explicitCapsule = /\b(cap|caps|capsule|capsules)\b/i.test(working);
  const explicitTablet = /\b(tab|tabs|tablet|tablets)\b/i.test(working);
  const drugKey = working
    .replace(/\b(er|xr|sr|xl|extended|tab|tabs|tablet|tablets|cap|caps|capsule|capsules|oral)\b/gi, " ")
    .replace(/[^a-z\s/]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const live = drugKey.length >= 3 ? await listRxNormVariants(drugKey) : [];
  const fromRxNorm = live.length > 0;
  const variants = fromRxNorm ? live.map(toStagingVariant) : fallbackVariants(drugKey);
  const drugName = fromRxNorm ? displayDrugName(drugKey) : fallbackName(drugKey);

  const strengthGroups = groupBy(variants, (variant) => displayStrength(variant.strength));
  if (extractedStrength && !strengthGroups.some((group) => sameStrength(group.label, extractedStrength))) {
    strengthGroups.unshift({ label: displayStrength(extractedStrength), variants: [] });
  }
  strengthGroups.sort((left, right) => strengthRank(left.label) - strengthRank(right.label));

  const formGroups = groupBy(variants, (variant) => variant.dosageForm);
  formGroups.sort((left, right) => formRank(left.label) - formRank(right.label));
  if (formGroups.length === 0) {
    formGroups.push({ label: "Oral Tablet", variants: [] });
  }

  const selectedStrengthLabels = extractedStrength
    ? strengthGroups.filter((group) => sameStrength(group.label, extractedStrength)).map((group) => group.label)
    : [];
  const selectedFormLabels = chooseForms(formGroups.map((group) => group.label), {
    extended: explicitExtended,
    capsule: explicitCapsule,
    tablet: explicitTablet,
  });

  const strengths = strengthGroups.map((group) => ({
    label: group.label,
    selected: selectedStrengthLabels.includes(group.label),
    variants: group.variants,
  }));
  const forms = formGroups.map((group) => ({
    label: group.label,
    selected: selectedFormLabels.includes(group.label),
    variants: group.variants,
  }));

  return {
    id: `draft-${index}-${drugKey.replace(/\s+/g, "-") || "drug"}`,
    rawLine: line,
    drugName,
    dailyFrequency,
    monthlyQuantity: dailyFrequency * 30,
    status: draftStatus(strengths, forms, explicitExtended || explicitCapsule || explicitTablet),
    strengths,
    forms,
  };
}

function draftStatus(strengths: StagingOption[], forms: StagingOption[], explicitForm: boolean): DraftStatus {
  if (!strengths.some((option) => option.selected)) return "MISSING_STRENGTH";
  if (forms.length > 1 && !explicitForm) return "MULTIPLE_FORMS";
  return "READY";
}

function chooseForms(labels: string[], hint: { extended: boolean; capsule: boolean; tablet: boolean }) {
  if (hint.extended) {
    const extended = labels.filter((label) => /extended/i.test(label));
    if (extended.length > 0) return extended;
  }
  if (hint.capsule) {
    const capsules = labels.filter((label) => /capsule/i.test(label));
    if (capsules.length > 0) return capsules;
  }
  if (hint.tablet) {
    const tablets = labels.filter((label) => /tablet/i.test(label) && !/extended/i.test(label));
    if (tablets.length > 0) return tablets;
  }
  const primary = labels.find((label) => /tablet/i.test(label) && !/extended|delayed/i.test(label)) ?? labels[0];
  return primary ? [primary] : [];
}

function groupBy(variants: StagingVariant[], labelFor: (variant: StagingVariant) => string) {
  const groups = new Map<string, StagingVariant[]>();
  for (const variant of variants) {
    const label = labelFor(variant);
    const current = groups.get(label) ?? [];
    current.push(variant);
    groups.set(label, current);
  }
  return [...groups.entries()].map(([label, grouped]) => ({ label, variants: grouped }));
}

function fallbackVariants(drugKey: string): StagingVariant[] {
  const catalog = FALLBACK_CATALOG[drugKey];
  if (!catalog) return [];
  return catalog.strengths.flatMap((strength) =>
    catalog.forms.map((form) => ({
      rxcui: "",
      fullName: `${catalog.name} ${strength} ${form.label}`,
      strength,
      dosageForm: form.label,
      coarseForm: coarseDosageForm(form.label),
      isExtendedRelease: form.extended,
      isBrand: false,
    })),
  );
}

function fallbackName(drugKey: string) {
  return FALLBACK_CATALOG[drugKey]?.name ?? displayDrugName(drugKey);
}

function displayDrugName(drugKey: string) {
  const titled = drugKey.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return drugKey.includes(" ") && !drugKey.includes("/") ? titled.replace(/\s+/, " / ") : titled;
}

function displayStrength(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/\b(mg|mcg|ml|g)\b/gi, (unit) => unit.toLowerCase());
}

function sameStrength(left: string, right: string) {
  return left.toLowerCase().replace(/\s+/g, "") === right.toLowerCase().replace(/\s+/g, "");
}

function strengthRank(label: string) {
  return Number(label.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
}

function formRank(label: string) {
  const text = label.toLowerCase();
  if (text.includes("tablet") && !text.includes("extended") && !text.includes("delayed")) return 0;
  if (text.includes("extended")) return 1;
  if (text.includes("capsule")) return 2;
  return 3;
}

function toStagingVariant(variant: ResolvedVariant): StagingVariant {
  return {
    rxcui: variant.rxcui,
    fullName: variant.fullName,
    strength: variant.strength,
    dosageForm: variant.dosageForm,
    coarseForm: variant.coarseForm,
    isExtendedRelease: variant.isExtendedRelease,
    isBrand: variant.isBrand,
  };
}
