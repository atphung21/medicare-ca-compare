export interface CatalogDrug {
  canonicalName: string;
  strengths: string[];
  forms: string[];
  lookAlikes?: string[];
}

export interface SpellingSuggestion {
  drugName: string;
  strengths: string[];
  forms: string[];
}

export interface SpellCorrection {
  lookupKey: string;
  displayName: string;
  originalTypedName: string;
  wasSpellCorrected: boolean;
  confidenceScore: number;
  suggestions: SpellingSuggestion[];
}

export const INDIVIDUAL_DRUG_CATALOG: Record<string, CatalogDrug> = {
  metformin: {
    canonicalName: "Metformin",
    strengths: ["500 mg", "850 mg", "1000 mg"],
    forms: ["Oral Tablet", "Extended Release Oral Tablet"],
  },
  amlodipine: {
    canonicalName: "Amlodipine",
    strengths: ["2.5 mg", "5 mg", "10 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["amiloride"],
  },
  benazepril: {
    canonicalName: "Benazepril",
    strengths: ["5 mg", "10 mg", "20 mg", "40 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["lisinopril"],
  },
  ezetimibe: {
    canonicalName: "Ezetimibe",
    strengths: ["10 mg"],
    forms: ["Oral Tablet"],
  },
  rosuvastatin: {
    canonicalName: "Rosuvastatin",
    strengths: ["5 mg", "10 mg", "20 mg", "40 mg"],
    forms: ["Oral Tablet", "Oral Capsule"],
    lookAlikes: ["atorvastatin", "pravastatin"],
  },
  atorvastatin: {
    canonicalName: "Atorvastatin",
    strengths: ["10 mg", "20 mg", "40 mg", "80 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["rosuvastatin", "simvastatin"],
  },
  simvastatin: {
    canonicalName: "Simvastatin",
    strengths: ["5 mg", "10 mg", "20 mg", "40 mg", "80 mg"],
    forms: ["Oral Tablet"],
  },
  pravastatin: {
    canonicalName: "Pravastatin",
    strengths: ["10 mg", "20 mg", "40 mg", "80 mg"],
    forms: ["Oral Tablet"],
  },
  lisinopril: {
    canonicalName: "Lisinopril",
    strengths: ["2.5 mg", "5 mg", "10 mg", "20 mg", "30 mg", "40 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["benazepril"],
  },
  losartan: {
    canonicalName: "Losartan",
    strengths: ["25 mg", "50 mg", "100 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["valsartan", "olmesartan"],
  },
  valsartan: {
    canonicalName: "Valsartan",
    strengths: ["40 mg", "80 mg", "160 mg", "320 mg"],
    forms: ["Oral Tablet"],
  },
  hydrochlorothiazide: {
    canonicalName: "Hydrochlorothiazide",
    strengths: ["12.5 mg", "25 mg", "50 mg"],
    forms: ["Oral Tablet", "Oral Capsule"],
    lookAlikes: ["hydralazine", "hydroxyzine"],
  },
  hydralazine: {
    canonicalName: "Hydralazine",
    strengths: ["10 mg", "25 mg", "50 mg", "100 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["hydroxyzine", "hydrochlorothiazide"],
  },
  hydroxyzine: {
    canonicalName: "Hydroxyzine",
    strengths: ["10 mg", "25 mg", "50 mg"],
    forms: ["Oral Tablet", "Oral Capsule"],
    lookAlikes: ["hydralazine"],
  },
  glipizide: {
    canonicalName: "Glipizide",
    strengths: ["5 mg", "10 mg"],
    forms: ["Oral Tablet", "Extended Release Oral Tablet"],
    lookAlikes: ["glyburide", "glimepiride"],
  },
  glyburide: {
    canonicalName: "Glyburide",
    strengths: ["1.25 mg", "2.5 mg", "5 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["glipizide", "glimepiride"],
  },
  glimepiride: {
    canonicalName: "Glimepiride",
    strengths: ["1 mg", "2 mg", "4 mg"],
    forms: ["Oral Tablet"],
    lookAlikes: ["glipizide", "glyburide"],
  },
  eliquis: {
    canonicalName: "Eliquis",
    strengths: ["2.5 mg", "5 mg"],
    forms: ["Oral Tablet"],
  },
  jardiance: {
    canonicalName: "Jardiance",
    strengths: ["10 mg", "25 mg"],
    forms: ["Oral Tablet"],
  },
  omeprazole: {
    canonicalName: "Omeprazole",
    strengths: ["10 mg", "20 mg", "40 mg"],
    forms: ["Delayed Release Oral Capsule", "Oral Tablet"],
    lookAlikes: ["pantoprazole", "esomeprazole"],
  },
  pantoprazole: {
    canonicalName: "Pantoprazole",
    strengths: ["20 mg", "40 mg"],
    forms: ["Delayed Release Oral Tablet"],
    lookAlikes: ["omeprazole"],
  },
  gabapentin: {
    canonicalName: "Gabapentin",
    strengths: ["100 mg", "300 mg", "400 mg", "600 mg", "800 mg"],
    forms: ["Oral Capsule", "Oral Tablet"],
  },
  levothyroxine: {
    canonicalName: "Levothyroxine",
    strengths: ["25 mcg", "50 mcg", "75 mcg", "88 mcg", "100 mcg", "112 mcg", "125 mcg", "150 mcg"],
    forms: ["Oral Tablet", "Oral Capsule"],
  },
};

export async function correctDrugToken(token: string): Promise<SpellCorrection> {
  const clean = token.toLowerCase().trim();
  if (!clean || clean.includes(" ")) return unchanged(clean || token);
  const local = rankDrugNames(clean);
  const best = local[0];
  if (best && best.score >= 0.68 && Math.abs(best.key.length - clean.length) <= 3) {
    const entry = INDIVIDUAL_DRUG_CATALOG[best.key];
    const corrected = best.key !== clean;
    const suggestions = new Map<string, SpellingSuggestion>();
    suggestions.set(entry.canonicalName, catalogSuggestion(best.key));
    for (const runnerUp of local.slice(1, 3)) {
      if (runnerUp.score < 0.58 || Math.abs(runnerUp.key.length - clean.length) > 3) continue;
      suggestions.set(INDIVIDUAL_DRUG_CATALOG[runnerUp.key].canonicalName, catalogSuggestion(runnerUp.key));
    }
    if (corrected) addLookAlikes(suggestions, entry.lookAlikes);
    return {
      lookupKey: best.key,
      displayName: entry.canonicalName,
      originalTypedName: token.trim(),
      wasSpellCorrected: corrected,
      confidenceScore: Math.round(best.score * 100),
      suggestions: corrected ? [...suggestions.values()] : [],
    };
  }

  const remoteNames = await fetchRxNormSpellingSuggestions(clean);
  const primary = remoteNames[0] || token.trim();
  const corrected = primary.toLowerCase() !== clean;
  const suggestions = new Map<string, SpellingSuggestion>();
  for (const name of [...new Set([primary, ...remoteNames.slice(0, 3)])]) {
    const catalog = INDIVIDUAL_DRUG_CATALOG[name.toLowerCase()];
    if (catalog) {
      suggestions.set(catalog.canonicalName, catalogSuggestion(name.toLowerCase()));
      continue;
    }
    suggestions.set(titleCase(name), { drugName: titleCase(name), strengths: [], forms: [] });
  }
  const chosen = [...suggestions.values()][0];
  return {
    lookupKey: (chosen?.drugName || primary).toLowerCase(),
    displayName: chosen?.drugName || titleCase(primary),
    originalTypedName: token.trim(),
    wasSpellCorrected: corrected,
    confidenceScore: corrected ? 88 : 100,
    suggestions: corrected ? [...suggestions.values()] : [],
  };
}

export function rankDrugNames(input: string) {
  const clean = input.toLowerCase().trim();
  const phoneticInput = phoneticKey(clean);
  return Object.keys(INDIVIDUAL_DRUG_CATALOG)
    .map((key) => {
      if (key === clean) return { key, score: 1 };
      const written = similarity(clean, key);
      const phonetic = similarity(phoneticInput, phoneticKey(key));
      return { key, score: Math.max(written, phonetic * 0.96) };
    })
    .sort((left, right) => right.score - left.score);
}

export function catalogDrug(key: string) {
  return INDIVIDUAL_DRUG_CATALOG[key.toLowerCase()] ?? null;
}

function unchanged(token: string): SpellCorrection {
  return {
    lookupKey: token,
    displayName: titleCase(token),
    originalTypedName: token,
    wasSpellCorrected: false,
    confidenceScore: 100,
    suggestions: [],
  };
}

function catalogSuggestion(key: string): SpellingSuggestion {
  const entry = INDIVIDUAL_DRUG_CATALOG[key];
  return { drugName: entry.canonicalName, strengths: [...entry.strengths], forms: [...entry.forms] };
}

function addLookAlikes(suggestions: Map<string, SpellingSuggestion>, keys: string[] | undefined) {
  for (const key of keys ?? []) {
    if (!INDIVIDUAL_DRUG_CATALOG[key]) continue;
    suggestions.set(INDIVIDUAL_DRUG_CATALOG[key].canonicalName, catalogSuggestion(key));
  }
}

async function fetchRxNormSpellingSuggestions(word: string): Promise<string[]> {
  try {
    const spelled = await fetch(`https://rxnav.nlm.nih.gov/REST/spellingsuggestions.json?name=${encodeURIComponent(word)}`, {
      next: { revalidate: 86400 },
    });
    if (spelled.ok) {
      const body = await spelled.json();
      const suggestions = asNames(body?.suggestionGroup?.suggestionList?.suggestion);
      if (suggestions.length > 0) return suggestions.slice(0, 4);
    }
    const approximate = await fetch(
      `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(word)}&maxEntries=4`,
      { next: { revalidate: 86400 } },
    );
    if (!approximate.ok) return [] as string[];
    const body = await approximate.json();
    const candidates = body?.approximateGroup?.candidate ?? [];
    const names: string[] = candidates
      .map((candidate: { name?: string }) => candidate.name?.split(/\s+/)[0] ?? "")
      .filter((name: string) => name.length > 2);
    return [...new Set(names)].slice(0, 4);
  } catch {
    return [];
  }
}

function asNames(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function phoneticKey(word: string) {
  return word
    .toLowerCase()
    .replace(/ph/g, "f")
    .replace(/y/g, "i")
    .replace(/z/g, "s")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/(.)\1+/g, "$1");
}

export function similarity(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return (maxLength - damerauLevenshtein(left, right)) / maxLength;
}

function damerauLevenshtein(left: string, right: string) {
  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) matrix[0][column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(matrix[row - 1][column] + 1, matrix[row][column - 1] + 1, matrix[row - 1][column - 1] + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1);
      }
    }
  }
  return matrix[left.length][right.length];
}

function titleCase(value: string) {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}
