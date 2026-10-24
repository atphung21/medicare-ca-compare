import { strengthKey } from "@/lib/strength";
import { coarseDosageForm, type DosageForm, type ResolvedVariant } from "@/schemas/medicare";

export interface DrugResolutionResult {
  query: string;
  status: "AUTO_LOCKED" | "AMBIGUOUS_FORM" | "NOT_FOUND";
  selectedVariant: ResolvedVariant | null;
  availableFormsForStrength: ResolvedVariant[];
  allVariants: ResolvedVariant[];
}

interface RxNavConceptProperty {
  rxcui: string;
  name: string;
  synonym?: string;
  tty?: string;
}

const RXNAV = "https://rxnav.nlm.nih.gov/REST";

export async function resolveDrugDosageForms(rawInput: string): Promise<DrugResolutionResult> {
  const query = rawInput.trim();
  const ndc = query.match(/\b(\d{4,5}-\d{3,4}-\d{1,2}|\d{11})\b/)?.[1];
  if (ndc) {
    const fromNdc = await resolveNdc(ndc, query);
    if (fromNdc) return fromNdc;
  }

  const comboQuery = query.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g|%)?\s*[-/]\s*(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g|%)?/i);
  const strengthMatch = comboQuery ? null : query.match(/(\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g|%|units?))/i);
  const targetStrength = comboQuery
    ? normalizeStrength(`${comboQuery[1]} ${comboQuery[2] || "mg"} / ${comboQuery[3]} ${comboQuery[4] || comboQuery[2] || "mg"}`)
    : strengthMatch
      ? normalizeStrength(strengthMatch[1])
      : null;
  const baseDrugName = query
    .replace(/\b(\d{4,5}-\d{3,4}-\d{1,2}|\d{11})\b/g, "")
    .replace(/(\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g|%|units?)).*/i, "")
    .replace(/\b(tab|tabs|tablet|tablets|cap|caps|capsule|capsules|er|xr|sr|xl|dr|ec|solostar|kwikpen|flexpen|vial|pen|ointment|cream)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (baseDrugName.length < 2) {
    return emptyResult(query);
  }

  const response = await fetch(`${RXNAV}/drugs.json?name=${encodeURIComponent(baseDrugName)}`, {
    next: { revalidate: 86400 },
  });
  if (!response.ok) return emptyResult(query);

  const data = await response.json();
  const conceptGroups = data?.drugGroup?.conceptGroup ?? [];
  const variants: ResolvedVariant[] = [];
  for (const group of conceptGroups) {
    if (group.tty !== "SCD" && group.tty !== "SBD") continue;
    const props: RxNavConceptProperty[] = group.conceptProperties ?? [];
    for (const prop of props) {
      const parsed = parseRxNormName(prop.rxcui, prop.name, group.tty === "SBD");
      if (parsed) variants.push(parsed);
    }
  }

  if (variants.length === 0) return emptyResult(query);

  let matching = targetStrength
    ? variants.filter((variant) => normalizeStrength(variant.strength) === targetStrength)
    : variants;
  if (matching.length === 0) matching = variants;
  if (!comboQuery && !query.includes("/") && !/\band\b/i.test(query)) {
    const singleIngredient = matching.filter((variant) => !isComboVariant(variant));
    if (singleIngredient.length > 0) matching = singleIngredient;
  }
  matching = preferNamedProduct(baseDrugName, matching);

  const hinted = applyHints(query, matching);
  const unique = dedupe(hinted.length > 0 ? hinted : matching);
  const distinctForms = new Set(unique.map((variant) => `${variant.dosageForm}|${variant.isBrand ? "B" : "G"}`));
  const locked = distinctForms.size === 1;

  return {
    query,
    status: locked ? "AUTO_LOCKED" : "AMBIGUOUS_FORM",
    selectedVariant: unique[0] ?? null,
    availableFormsForStrength: unique,
    allVariants: variants,
  };
}

async function resolveNdc(ndc: string, query: string): Promise<DrugResolutionResult | null> {
  const lookup = await fetch(`${RXNAV}/rxcui.json?idtype=NDC&id=${encodeURIComponent(ndc)}`, {
    next: { revalidate: 86400 },
  });
  if (!lookup.ok) return null;
  const body = await lookup.json();
  const rxcui = body?.idGroup?.rxnormId?.[0];
  if (!rxcui) return null;
  const props = await fetch(`${RXNAV}/rxcui/${rxcui}/properties.json`, { next: { revalidate: 86400 } });
  if (!props.ok) return null;
  const parsedBody = await props.json();
  const name = parsedBody?.properties?.name as string | undefined;
  const tty = parsedBody?.properties?.tty as string | undefined;
  if (!name) return null;
  const variant = parseRxNormName(String(rxcui), name, tty === "SBD");
  if (!variant) return null;
  return {
    query,
    status: "AUTO_LOCKED",
    selectedVariant: variant,
    availableFormsForStrength: [variant],
    allVariants: [variant],
  };
}

function preferNamedProduct(baseDrugName: string, variants: ResolvedVariant[]) {
  const queryName = baseDrugName.toLowerCase();
  if (!queryName) return variants;
  const generic = variants.filter((variant) => !variant.isBrand && variant.fullName.toLowerCase().includes(queryName));
  const brand = variants.filter((variant) => variant.isBrand && new RegExp(`\\[${queryName}\\b`, "i").test(variant.fullName));
  if (brand.length > 0 && generic.length === 0) return variants.filter((variant) => variant.isBrand);
  if (generic.length > 0) return variants.filter((variant) => !variant.isBrand);
  return variants;
}

function applyHints(query: string, variants: ResolvedVariant[]) {
  let narrowed = [...variants];
  const capsule = /\b(cap|caps|capsule|capsules|gelcap)\b/i.test(query);
  const tablet = /\b(tab|tabs|tablet|tablets|odt)\b/i.test(query);
  const extended = /\b(er|xr|sr|xl|24\s*hr|extended|succinate)\b/i.test(query);
  const delayed = /\b(dr|ec|delayed|enteric)\b/i.test(query);
  const pen = /\b(pen|solostar|kwikpen|flexpen|auto-?injector)\b/i.test(query);
  const vial = /\bvials?\b/i.test(query);
  const cream = /\bcream\b/i.test(query);
  const ointment = /\bointment\b/i.test(query);
  const tartrate = /\btartrate\b/i.test(query);

  if (capsule) narrowed = narrowed.filter((variant) => variant.dosageForm.toLowerCase().includes("capsule"));
  else if (tablet || tartrate) narrowed = narrowed.filter((variant) => variant.dosageForm.toLowerCase().includes("tablet"));
  if (extended) narrowed = narrowed.filter((variant) => variant.isExtendedRelease);
  else if (delayed) narrowed = narrowed.filter((variant) => /delayed|enteric/i.test(variant.dosageForm));
  if (pen) narrowed = narrowed.filter((variant) => variant.coarseForm === "INJECTABLE_PEN");
  else if (vial) narrowed = narrowed.filter((variant) => variant.coarseForm === "VIAL");
  if (cream) narrowed = narrowed.filter((variant) => variant.dosageForm.toLowerCase().includes("cream"));
  else if (ointment) narrowed = narrowed.filter((variant) => variant.dosageForm.toLowerCase().includes("ointment"));
  return narrowed;
}

function dedupe(variants: ResolvedVariant[]) {
  const unique = new Map<string, ResolvedVariant>();
  for (const variant of variants) {
    const key = `${normalizeStrength(variant.strength)}|${variant.dosageForm}|${variant.isBrand ? "B" : "G"}`;
    if (!unique.has(key)) unique.set(key, variant);
  }
  return [...unique.values()];
}

export async function listRxNormVariants(drugName: string): Promise<ResolvedVariant[]> {
  const combo = isComboDrugName(drugName);
  let variants = await fetchVariants(drugName);
  if (!combo) {
    const singles = variants.filter((variant) => !isComboVariant(variant));
    return dedupePreferGeneric(singles.length > 0 ? singles : variants);
  }

  const words = drugName.toLowerCase().split(/\s+/).filter(Boolean);
  // A multi-word single drug, such as "insulin glargine" or "potassium chloride", has no " / " in its RxNorm names.
  const single = variants.filter(
    (variant) => !isComboVariant(variant) && words.every((word) => variant.fullName.toLowerCase().includes(word)),
  );
  if (single.length > 0) return dedupePreferGeneric(single);

  // RxNorm lists combination ingredients alphabetically, such as "hydrochlorothiazide / losartan".
  for (const query of [words.join(" / "), [...words].sort().join(" / ")]) {
    if (variants.some((variant) => isComboVariant(variant) && containsAll(variant, words))) break;
    const joined = await fetchVariants(query);
    if (joined.some(isComboVariant)) variants = joined;
  }
  const combos = variants.filter((variant) => isComboVariant(variant) && containsAll(variant, words));
  return dedupePreferGeneric(combos.length > 0 ? combos : variants.filter(isComboVariant));
}

function containsAll(variant: ResolvedVariant, words: string[]) {
  const name = variant.fullName.toLowerCase();
  return words.every((word) => name.includes(word));
}

function isComboVariant(variant: ResolvedVariant) {
  return variant.fullName.includes(" / ");
}

function isComboDrugName(name: string) {
  if (name.includes("/") || /\band\b/i.test(name)) return true;
  const words = name.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  return words.length >= 2;
}

async function fetchVariants(drugName: string) {
  const response = await fetch(`${RXNAV}/drugs.json?name=${encodeURIComponent(drugName)}`, {
    next: { revalidate: 86400 },
  });
  if (!response.ok) return [];
  const data = await response.json();
  const conceptGroups = data?.drugGroup?.conceptGroup ?? [];
  const variants: ResolvedVariant[] = [];
  for (const group of conceptGroups) {
    if (group.tty !== "SCD" && group.tty !== "SBD") continue;
    const props: RxNavConceptProperty[] = group.conceptProperties ?? [];
    for (const prop of props) {
      const parsed = parseRxNormName(prop.rxcui, prop.name, group.tty === "SBD");
      if (parsed) variants.push(parsed);
    }
  }
  return variants;
}

function dedupePreferGeneric(variants: ResolvedVariant[]) {
  const unique = new Map<string, ResolvedVariant>();
  for (const variant of variants) {
    const key = `${normalizeStrength(variant.strength)}|${variant.dosageForm.toLowerCase()}`;
    const current = unique.get(key);
    if (!current || (current.isBrand && !variant.isBrand)) unique.set(key, variant);
  }
  return [...unique.values()];
}

function parseRxNormName(rxcui: string, fullName: string, isBrand: boolean): ResolvedVariant | null {
  const name = fullName.replace(/^\d+(?:\.\d+)?\s*(?:ML|ACTUAT)\s+/i, "");
  const perDose = name.match(
    /^(.*?\d\s*(?:MG|MCG|UNT))\s+Dose\s+(?:\d+(?:\.\d+)?\s*ML\s+)?.*?\d\s*(?:MG|MCG|UNT)\/ML\s+(.+)$/i,
  );
  if (perDose) {
    const dosageForm = perDose[2].replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
    if (!dosageForm) return null;
    return variantFrom(rxcui, fullName, perDose[1].replace(/\s*,\s*/g, ", ").toUpperCase(), dosageForm, isBrand);
  }
  const combo = name.match(
    /(\d+(?:\.\d+)?)\s*(MG|MCG|ML|UNT|MEQ|G|%)(\/(?:ML|ACTUAT|HR))?\s*\/\s*[a-z].+?\s+(\d+(?:\.\d+)?)\s*(MG|MCG|ML|UNT|MEQ|G|%)(\/(?:ML|ACTUAT|HR))?\s+(.+)$/i,
  );
  if (combo) {
    const dosageForm = combo[7].replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
    if (!dosageForm) return null;
    const strength = `${combo[1]} ${combo[2]}${combo[3] ?? ""} / ${combo[4]} ${combo[5]}${combo[6] ?? ""}`;
    return variantFrom(rxcui, fullName, strength.toUpperCase(), dosageForm, isBrand);
  }
  const strengthMatch = name.match(/(\d+(?:\.\d+)?\s*(?:MG|MCG|ML|UNT|MEQ|G|%)(?:\/(?:ML|ACTUAT|HR|DOSE))?)/i);
  if (!strengthMatch || strengthMatch.index === undefined) return null;
  const dosageForm = name
    .slice(strengthMatch.index + strengthMatch[0].length)
    .replace(/\[.*?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!dosageForm) return null;
  return variantFrom(rxcui, fullName, strengthMatch[1].toUpperCase(), dosageForm, isBrand);
}

function variantFrom(rxcui: string, name: string, strength: string, dosageForm: string, isBrand: boolean): ResolvedVariant {
  return {
    rxcui: rxcui.trim(),
    fullName: name,
    strength,
    dosageForm,
    coarseForm: coarseDosageForm(dosageForm) satisfies DosageForm,
    isExtendedRelease: /extended release|24 hr|12 hr|succinate/i.test(name),
    isBrand,
  };
}

function normalizeStrength(value: string) {
  return strengthKey(value) || value.toUpperCase().replace(/\s+/g, "");
}

function emptyResult(query: string): DrugResolutionResult {
  return {
    query,
    status: "NOT_FOUND",
    selectedVariant: null,
    availableFormsForStrength: [],
    allVariants: [],
  };
}
