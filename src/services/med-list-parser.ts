import { geminiGenerateUrl } from "@/lib/gemini";
import { hasStrengthUnit, matchStrengthLabel, strengthKey } from "@/lib/strength";
import { coarseDosageForm, type DosageForm, type ResolvedVariant } from "@/schemas/medicare";
import { applyAliases, readMemory } from "@/services/assistant/memory";
import { catalogDrug, correctDrugToken, similarity, type SpellingSuggestion } from "@/services/drug-spellcheck";
import {
  monthlyQuantityFor,
  normalizeMedicationLine,
  type FormHints,
  type NormalizedMedication,
} from "@/services/med-line-normalizer";
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
  originalTypedName: string;
  wasSpellCorrected: boolean;
  confidenceScore: number;
  spellingSuggestions: SpellingSuggestion[];
  typedStrength: string | null;
  dailyFrequency: number;
  monthlyQuantity: number;
  isSupply: boolean;
  status: DraftStatus;
  strengths: StagingOption[];
  forms: StagingOption[];
}

export type { SpellingSuggestion };

interface NameResolution {
  key: string;
  typed: string;
  variants: StagingVariant[];
  corrected: boolean;
  confidence: number;
  suggestions: SpellingSuggestion[];
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

const HEADER = /^(?:current\s+)?(?:medications?|meds|med list|rx|drug list|prescriptions?)\s*:?\s*/i;

export async function parseMedicationList(text: string): Promise<MedicationDraft[]> {
  const taught = process.env.SKIP_TAUGHT_PHRASES === "1" ? {} : (await readMemory()).aliases;
  const lines = (await medicationLines(text)).map((line) => applyAliases(line, taught));
  const perLine = await mapLimit(lines, 4, draftsForLine);
  return perLine.flat().map((draft, index) => ({ ...draft, id: `draft-${index}-${draft.id}` }));
}

async function medicationLines(text: string) {
  const split = splitLines(text);
  if (split.length > 1 || text.trim().length < 80 || !process.env.GEMINI_API_KEY) return split;
  const fromGemini = await splitParagraphWithGemini(text);
  return fromGemini.length > 0 ? fromGemini : split;
}

function splitLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, "")
        .replace(HEADER, "")
        .trim(),
    )
    .filter((line) => line.length > 1)
    .flatMap(splitSegments);
}

/** Splits "metformin 500, lisinopril 10" but keeps "metformin 500, take 2 tabs" together. */
function splitSegments(line: string) {
  const segments: string[] = [];
  for (const part of line.split(/;|,(?!\d{3}\b)/)) {
    const piece = part.trim();
    if (!piece) continue;
    if (segments.length > 0 && normalizeMedicationLine(piece).tokens.length === 0) {
      segments[segments.length - 1] += `, ${piece}`;
    } else {
      segments.push(piece);
    }
  }
  return segments;
}

async function splitParagraphWithGemini(text: string) {
  const parsed = await askGemini<{ lines?: string[] }>(
    `Split this medication note into one drug per line. Keep the strength and frequency words that are already written. Do not invent a strength or a drug. Return JSON {"lines":["..."]}.\n\n${text}`,
  );
  return (parsed?.lines ?? []).map((line) => line.trim()).filter((line) => line.length > 1);
}

async function draftsForLine(line: string): Promise<MedicationDraft[]> {
  const norm = normalizeMedicationLine(line);
  if (norm.hints.supply) return [supplyDraft(norm)];
  if (norm.tokens.length === 0) return [];

  const whole = await resolveName(norm.name, norm.typedName);
  if (whole) return [buildDraft(norm, whole)];

  if (norm.tokens.length > 1) {
    const found = await separateDrugs(norm.tokens);
    if (found.length === 1) return [buildDraft(norm, found[0])];
    if (found.length > 1) {
      const byIndex = norm.strengths.length === found.length;
      return found.map((resolution, index) =>
        buildDraft({ ...norm, strengths: byIndex ? [norm.strengths[index]] : [] }, resolution),
      );
    }
  }

  const guesses = await guessDrugNamesWithGemini(norm.rawLine);
  const guessed: NameResolution[] = [];
  for (const guess of guesses.slice(0, norm.tokens.length)) {
    const resolution = await resolveName(normalizeMedicationLine(guess).name, norm.typedName);
    if (resolution) guessed.push({ ...resolution, corrected: true, confidence: Math.min(resolution.confidence, 80) });
  }
  if (guessed.length === 1) return [buildDraft(norm, guessed[0])];
  if (guessed.length > 1) {
    const byIndex = norm.strengths.length === guessed.length;
    return guessed.map((resolution, index) =>
      buildDraft({ ...norm, strengths: byIndex ? [norm.strengths[index]] : [] }, resolution),
    );
  }

  return [
    buildDraft(norm, {
      key: norm.name,
      typed: norm.typedName,
      variants: [],
      corrected: false,
      confidence: 0,
      suggestions: [],
    }),
  ];
}

async function separateDrugs(tokens: string[]) {
  const candidates = [...new Set(tokens.filter((token) => token.length >= 4))].slice(0, 5);
  const resolved = await Promise.all(candidates.map((token) => resolveName(token, token)));
  const seen = new Set<string>();
  return resolved.filter((resolution): resolution is NameResolution => {
    if (!resolution || seen.has(resolution.key)) return false;
    seen.add(resolution.key);
    return true;
  });
}

async function resolveName(name: string, typed: string): Promise<NameResolution | null> {
  const key = name.trim();
  if (key.length < 3) return null;
  const tokens = key.split(/\s+/);

  const live = await listRxNormVariants(key);
  if (live.length > 0 || (tokens.length === 1 && catalogDrug(key))) {
    const expanded = compact(key) !== compact(typed);
    return {
      key,
      typed,
      variants: live.map(toStagingVariant),
      corrected: expanded,
      confidence: expanded ? 95 : 100,
      suggestions: [],
    };
  }

  const corrections = await Promise.all(tokens.map((token) => correctDrugToken(token)));
  const plausible = corrections.every(
    (correction, index) =>
      !correction.wasSpellCorrected ||
      correction.confidenceScore >= 68 && similarity(tokens[index], correction.lookupKey) >= 0.6,
  );
  const correctedKey = corrections.map((correction, index) => correction.lookupKey || tokens[index]).join(" ");
  if (!plausible || correctedKey === key) return null;

  const fixed = await listRxNormVariants(correctedKey);
  if (fixed.length === 0 && !(tokens.length === 1 && catalogDrug(correctedKey))) return null;
  return {
    key: correctedKey,
    typed,
    variants: fixed.map(toStagingVariant),
    corrected: true,
    confidence: Math.min(...corrections.map((correction) => correction.confidenceScore)),
    suggestions: tokens.length === 1 ? corrections[0].suggestions : [],
  };
}

function buildDraft(norm: NormalizedMedication, resolution: NameResolution): MedicationDraft {
  const variants = resolution.variants.length > 0 ? resolution.variants : fallbackVariants(resolution.key);

  const strengthGroups = groupBy(
    variants,
    (variant) => displayStrength(variant.strength),
    (variant) => strengthKey(variant.strength) || variant.strength,
  );
  strengthGroups.sort((left, right) => strengthRank(left.label) - strengthRank(right.label));
  const typedStrength = norm.strengths[0];
  let selectedStrength = typedStrength
    ? matchStrengthLabel(
        strengthGroups.map((group) => group.label),
        typedStrength,
      )
    : undefined;
  if (!selectedStrength && typedStrength && variants.length === 0) {
    selectedStrength = displayStrength(hasStrengthUnit(typedStrength) ? typedStrength : `${typedStrength} mg`);
    strengthGroups.unshift({ label: selectedStrength, variants: [] });
  }
  if (!typedStrength && strengthGroups.length === 1) selectedStrength = strengthGroups[0].label;

  const formGroups = groupBy(variants, (variant) => variant.dosageForm);
  formGroups.sort((left, right) => formRank(left.label) - formRank(right.label));
  if (formGroups.length === 0) formGroups.push({ label: "Oral Tablet", variants: [] });
  const strengthForms = new Set(
    strengthGroups
      .find((group) => group.label === selectedStrength)
      ?.variants.map((variant) => variant.dosageForm) ?? [],
  );
  const formLabels = formGroups.map((group) => group.label);
  const fitting = formLabels.filter((label) => strengthForms.has(label));
  const selectedForms = chooseForms(fitting.length > 0 ? fitting : formLabels, norm.hints);

  const strengths = strengthGroups.map((group) => ({
    label: group.label,
    selected: group.label === selectedStrength,
    variants: group.variants,
  }));
  const forms = formGroups.map((group) => ({
    label: group.label,
    selected: selectedForms.includes(group.label),
    variants: group.variants,
  }));
  const explicitForm = Object.values(norm.hints).some(Boolean);
  const quantityForm = selectedForms[0] ?? formGroups[0]?.label ?? "";

  return {
    id: resolution.key.replace(/\s+/g, "-") || "drug",
    rawLine: norm.rawLine,
    drugName: displayName(resolution.key, variants),
    originalTypedName: resolution.typed || norm.rawLine,
    wasSpellCorrected: resolution.corrected,
    confidenceScore: resolution.confidence,
    spellingSuggestions: resolution.suggestions,
    typedStrength: typedStrength ? (hasStrengthUnit(typedStrength) ? typedStrength : `${typedStrength} mg`) : null,
    dailyFrequency: norm.dailyFrequency,
    monthlyQuantity: monthlyQuantityFor(norm, quantityForm).quantity,
    isSupply: false,
    status: draftStatus(strengths, forms, explicitForm),
    strengths,
    forms,
  };
}

const SUPPLY_BRANDS: [RegExp, string][] = [
  [/\bfreestyle\s+libre\s*3\b/, "FreeStyle Libre 3"],
  [/\bfreestyle\s+libre\b|\blibre\b/, "FreeStyle Libre 2"],
  [/\bfreestyle\b/, "FreeStyle Lite"],
  [/\bone\s*touch\s+verio\b/, "OneTouch Verio"],
  [/\bone\s*touch\b/, "OneTouch Ultra"],
  [/\baccuchek\b/, "Accu-Chek Guide"],
  [/\bcontour\b/, "Contour Next"],
  [/\btrue\s*metrix\b/, "True Metrix"],
  [/\bdexcom\s+g\s*6\b/, "Dexcom G6"],
  [/\bdexcom\b/, "Dexcom G7"],
];

const SUPPLY_KINDS: [RegExp, string][] = [
  [/\blancets?\b|\blancing\b/, "Lancets"],
  [/\bpen\s*needles?\b|\bneedles?\b/, "Pen Needles"],
  [/\bsyringes?\b/, "Insulin Syringes"],
  [/\bsensors?\b|\blibre\b|\bdexcom\b/, "Sensor"],
  [/\bmeters?\b|\bglucometers?\b/, "Meter"],
  [/\balcohol\b/, "Alcohol Prep Pads"],
];

function supplyName(rawLine: string) {
  const text = rawLine
    .toLowerCase()
    .replace(/\bfree\s+style\b/g, "freestyle")
    .replace(/\baccu[\s-]*che(?:c)?k\b/g, "accuchek");
  const brand = SUPPLY_BRANDS.find(([pattern]) => pattern.test(text))?.[1] ?? "";
  const kind =
    SUPPLY_KINDS.find(([pattern]) => pattern.test(text))?.[1] ??
    (/libre|dexcom/i.test(brand) ? "Sensor" : "Test Strips");
  if (!brand) return kind === "Test Strips" ? "Glucose Test Strips" : kind;
  return `${brand} ${kind}`;
}

function supplyDraft(norm: NormalizedMedication): MedicationDraft {
  const name = supplyName(norm.rawLine);
  return {
    id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    rawLine: norm.rawLine,
    drugName: name,
    originalTypedName: norm.rawLine,
    wasSpellCorrected: name.toLowerCase() !== norm.rawLine.toLowerCase(),
    confidenceScore: 90,
    spellingSuggestions: [],
    typedStrength: null,
    dailyFrequency: norm.dailyFrequency,
    monthlyQuantity: norm.monthlyQuantity,
    isSupply: true,
    status: "READY",
    strengths: [],
    forms: [{ label: "Diabetic supply", selected: true, variants: [] }],
  };
}

function draftStatus(strengths: StagingOption[], forms: StagingOption[], explicitForm: boolean): DraftStatus {
  if (!strengths.some((option) => option.selected)) return "MISSING_STRENGTH";
  if (forms.length > 1 && !explicitForm) return "MULTIPLE_FORMS";
  return "READY";
}

const FORM_RULES: [keyof FormHints, RegExp][] = [
  ["pen", /\bpen\b|injector|prefilled/i],
  ["inhaler", /inhal|aerosol|powder/i],
  ["metered", /metered|aerosol/i],
  ["powder", /powder/i],
  ["patch", /patch|transdermal/i],
  ["cream", /cream/i],
  ["ointment", /ointment/i],
  ["drops", /ophthalmic|otic|drop/i],
  ["spray", /nasal|spray/i],
  ["solution", /solution|suspension|syrup|elixir/i],
  ["injection", /inject|vial/i],
  ["sublingual", /sublingual/i],
  ["disintegrating", /disintegrating/i],
  ["extended", /extended|24 hr|12 hr/i],
  ["delayed", /delayed/i],
  ["capsule", /capsule/i],
];

function chooseForms(labels: string[], hints: FormHints) {
  let pool = labels;
  for (const [hint, pattern] of FORM_RULES) {
    if (!hints[hint]) continue;
    const narrowed = pool.filter((label) => pattern.test(label));
    if (narrowed.length > 0) pool = narrowed;
  }
  if (pool !== labels && !hints.powder) {
    const solid = pool.filter((label) => !/powder|granule/i.test(label));
    if (solid.length > 0) pool = solid;
  }
  if (hints.tablet && !hints.capsule) {
    const tablets = pool.filter(
      (label) =>
        /tablet/i.test(label) &&
        (hints.extended || !/extended/i.test(label)) &&
        (hints.delayed || !/delayed/i.test(label)) &&
        (hints.disintegrating || !/disintegrating/i.test(label)) &&
        (hints.sublingual || !/sublingual/i.test(label)) &&
        !/chewable|buccal/i.test(label),
    );
    if (tablets.length > 0) pool = tablets;
  }
  if (pool !== labels) return pool;
  const primary = [...labels].sort((left, right) => formRank(left) - formRank(right))[0];
  return primary ? [primary] : [];
}

function groupBy(
  variants: StagingVariant[],
  labelFor: (variant: StagingVariant) => string,
  keyFor: (variant: StagingVariant) => string = labelFor,
) {
  const groups = new Map<string, { label: string; variants: StagingVariant[] }>();
  for (const variant of variants) {
    const key = keyFor(variant);
    const current = groups.get(key) ?? { label: labelFor(variant), variants: [] };
    current.variants.push(variant);
    groups.set(key, current);
  }
  return [...groups.values()];
}

function fallbackVariants(drugKey: string): StagingVariant[] {
  const individual = catalogDrug(drugKey);
  const catalog = FALLBACK_CATALOG[drugKey] ?? (individual
    ? {
        name: individual.canonicalName,
        strengths: individual.strengths,
        forms: individual.forms.map((label) => ({ label, extended: /extended/i.test(label) })),
      }
    : null);
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

function displayName(drugKey: string, variants: StagingVariant[]) {
  const known = FALLBACK_CATALOG[drugKey]?.name ?? catalogDrug(drugKey)?.canonicalName;
  if (known) return known;
  const titled = drugKey.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const combo = variants.length > 0 && variants.every((variant) => variant.fullName.includes(" / "));
  return combo && !titled.includes("/") ? titled.split(/\s+/).join(" / ") : titled;
}

function displayStrength(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bUNT\b/g, "units")
    .replace(/\b(mg|mcg|ml|g|meq)\b/gi, (unit) => unit.toLowerCase());
}

function strengthRank(label: string) {
  return Number(label.match(/\d+(?:\.\d+)?/)?.[0] ?? 0);
}

function formRank(label: string) {
  const text = label.toLowerCase();
  if (text === "oral tablet") return 0;
  if (text === "oral capsule") return 1;
  if (text.includes("tablet") && !/extended|delayed|chewable|sublingual|disintegrating/.test(text)) return 2;
  if (text.includes("extended")) return 3;
  if (text.includes("capsule")) return 4;
  if (text.includes("tablet")) return 5;
  return 6;
}

function compact(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
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

async function guessDrugNamesWithGemini(text: string) {
  const parsed = await askGemini<{ drugs?: string[] }>(
    `This text was typed into a Medicare drug list. It may be misspelled, abbreviated, or mixed with directions: "${text}". Return the drug names it most likely refers to, one name per drug mentioned (keep a brand name as the brand, do not also list its generic), as US names found in RxNorm, without strength or directions. Do not add drugs that are not mentioned. Return JSON {"drugs":["..."]}, or {"drugs":[]} if it is not a medication.`,
  );
  return (parsed?.drugs ?? []).map((name) => name.trim()).filter((name) => name.length > 2);
}

async function askGemini<T>(prompt: string): Promise<T | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  try {
    const response = await fetch(
      geminiGenerateUrl(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) return null;
    const body = await response.json();
    const raw = body?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
