import { canonicalUnit, STRENGTH_UNIT } from "@/lib/strength";

export interface FormHints {
  extended: boolean;
  delayed: boolean;
  disintegrating: boolean;
  capsule: boolean;
  tablet: boolean;
  pen: boolean;
  inhaler: boolean;
  metered: boolean;
  powder: boolean;
  solution: boolean;
  patch: boolean;
  cream: boolean;
  ointment: boolean;
  drops: boolean;
  spray: boolean;
  sublingual: boolean;
  injection: boolean;
  supply: boolean;
}

export type QuantityUnit = "each" | "ml" | "package";

export interface NormalizedMedication {
  rawLine: string;
  /** Drug words as typed, after instructions and salt words are removed. */
  typedName: string;
  /** Drug words with abbreviations expanded, such as hctz to hydrochlorothiazide. */
  name: string;
  tokens: string[];
  explicitCombo: boolean;
  strengths: string[];
  dailyFrequency: number;
  unitsPerDose: number;
  /** 2 for both eyes, both ears, or each nostril. */
  sites: number;
  /** Liquid dose, such as "5 ml tid". */
  mlPerDose: number;
  /** Insulin dose, such as "20 units qhs". */
  insulinUnitsPerDose: number;
  insulin: boolean;
  monthlyQuantity: number;
  quantityUnit: QuantityUnit;
  hints: FormHints;
  /** Instruction and form words, kept so a split line can be parsed again per drug. */
  sigText: string;
}

const COUNT_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  half: 0.5,
  "1/2": 0.5,
};

const DOSE_UNIT =
  "(tabs?|tablets?|caps?|capsules?|pills?|puffs?|sprays?|drops?|gtts?|pens?|patch(?:es)?|softgels?|strips?|tests?|injections?|applications?|suppositor(?:y|ies)|lozenges?|vials?|ampules?)";

const SITES =
  /\b(?:(?:in|into|to)\s+)?(?:both|each|all)\s+(?:eyes?|ears?|nostrils?|nares)\b|\b(?:ou|au)\b|\bper\s+nostril\b/;

const INSULIN =
  /\b(?:insulin|lantus|levemir|humalog|novolog|basaglar|toujeo|tresiba|admelog|lyumjev|fiasp|humulin|novolin|semglee|apidra|rezvoglar|glargine|lispro|aspart|detemir|degludec)\b/;

const SUPPLY =
  /\b(?:test\s*strips?|strips?|lancets?|lancing|pen\s*needles?|needles?|syringes?|sensors?|meters?|glucometers?|free\s*style|one\s*touch|accu\s*chek|accu\s*check|contour|true\s*metrix|dexcom|libre|alcohol\s*(?:pads?|swabs?|prep))\b/;
const COUNT = "(\\d+(?:\\.\\d+)?|one|two|three|four|half|1\\/2)";

const FREQUENCIES: [RegExp, (match: RegExpMatchArray) => number][] = [
  [
    /\b(?:q|every)\s*(\d+)\s*(?:-|to)?\s*(\d+)?\s*(?:h|hrs?|hours?)\b/,
    (match) => 24 / Number(match[2] ?? match[1]),
  ],
  [
    /\b(\d+)\s*(?:x|times?)\s*(?:a|per|\/|each)?\s*(?:day|daily|d)\b/,
    (match) => Number(match[1]),
  ],
  [/\b(\d+)\s*(?:\/|per)\s*(?:day|d)\b/, (match) => Number(match[1])],
  [/\b(?:qid|four times(?: (?:a|per) day| daily)?)\b/, () => 4],
  [/\b(?:tid|thrice|three times(?: (?:a|per) day| daily)?)\b/, () => 3],
  [
    /\b(?:bid|twice(?: (?:a|per) day| daily)?|two times(?: (?:a|per) day| daily)?)\b/,
    () => 2,
  ],
  [
    /\b(?:(?:once|one time|1 x|1)\s+)?(?:a|per|every|each)\s+week\b|\bweekly\b|\bqw(?:k|eek)?\b/,
    () => 1 / 7,
  ],
  [/\b(?:every other day|qod|alternate days)\b/, () => 0.5],
  [/\b(?:with meals|before meals|after meals|ac|pc|sliding scale|ss)\b/, () => 3],
  [
    /\b(?:once(?: (?:a|per) day| daily)?|daily|every day|each day|per day|a day|qd|qday|qam|qpm|qhs|hs|nightly|at night|at bedtime|bedtime|every (?:morning|evening|night)|in the (?:morning|evening))\b/,
    () => 1,
  ],
  [/\b(\d)\s*x\b/, (match) => Number(match[1])],
];

const HINTS: [keyof FormHints, RegExp][] = [
  [
    "extended",
    /\b(?:er|xr|sr|xl|cr|la|cd|ext(?:ended)?(?:[- ]release)?|sustained(?:[- ]release)?|controlled(?:[- ]release)?|(?:24|12)\s*h(?:r|our)?s?)\b/g,
  ],
  [
    "delayed",
    /\b(?:dr|ec|delayed(?:[- ]release)?|enteric(?:[- ]coated)?)\b/g,
  ],
  [
    "disintegrating",
    /\b(?:odt|orally disintegrating|disintegrating|dissolving|dissolvable)\b/g,
  ],
  ["capsule", /\b(?:caps?|capsules?|gelcaps?|softgels?)\b/g],
  ["tablet", /\b(?:tabs?|tablets?|pills?|caplets?)\b/g],
  [
    "pen",
    /\b(?:pens?|flex ?pen|kwik ?pen|solostar|auto[- ]?injectors?|prefilled syringes?)\b/g,
  ],
  ["metered", /\b(?:hfa|mdi|aerosol|metered)\b/g],
  ["powder", /\b(?:diskus|ellipta|dpi|respiclick|inhub|twisthaler|pressair|powder)\b/g],
  [
    "inhaler",
    /\b(?:inhalers?|puffs?|inhal\w*|respimat|nebuli\w*)\b/g,
  ],
  ["drops", /\b(?:eye\s+drops?|ear\s+drops?|drops?|gtts?|ophth?|ophthalmic|otic)\b/g],
  ["spray", /\b(?:nasal(?:\s+spray)?|sprays?|nostrils?|nares)\b/g],
  [
    "solution",
    /\b(?:solution|soln|sol|liquid|syrup|elixir|suspension|susp|oral\s+solution)\b/g,
  ],
  ["patch", /\b(?:patch(?:es)?|transdermal)\b/g],
  ["cream", /\b(?:cream|lotion)\b/g],
  ["ointment", /\b(?:ointment|oint)\b/g],
  ["sublingual", /\b(?:sl|sublingual|under (?:the )?tongue)\b/g],
  [
    "injection",
    /\b(?:inj|injections?|injectable|vials?|subq|sub-q|sq|subcutaneous(?:ly)?|intramuscular(?:ly)?|im)\b/g,
  ],
];

const STOP_WORDS = new Set(
  `take takes taking use using give by mouth po oral orally route sig rx qty quantity disp dispense refill refills
  at in on the a an of for to with without and or then as needed prn if when per each every daily day days
  once twice times time morning evening night nightly bedtime noon week weekly month monthly hour hours
  food meals meal before after breakfast lunch dinner supper empty stomach water
  pain sleep anxiety blood pressure sugar cholesterol diabetes nausea
  apply inject inhale instill insert place chew swallow dissolve under tongue
  eye eyes ear ears both left right affected area skin
  generic brand name strength dose doses dosage medication medications med meds drug drugs pill pills
  tab tabs tablet tablets cap caps capsule capsules unit units mg mcg ml
  start stop continue new old current currently also plus about approx approximately
  regular extra into onto from up over both ou od os au ad
  topically topical externally external thin layer film rinse gargle shake well
  iv sq subq units sliding scale ss times
  bottle bottles tube tubes box boxes pack packs package kit supply supplies
  sugar sugars glucose check checks test testing tests
  nostril nostrils nares spray sprays
  chest headache headaches angina heart swelling edema itch itching rash cough wheezing wheeze breath shortness
  constipation diarrhea allergy allergies infection insomnia depression mood thyroid gout arthritis migraine
  migraines seizure seizures vomiting fever inflammation glaucoma heartburn reflux muscle spasm spasms back joint`
    .split(/\s+/)
    .filter(Boolean),
);

const SALT_WORDS = new Set([
  "potassium",
  "sodium",
  "hcl",
  "hydrochloride",
  "hyclate",
  "succinate",
  "tartrate",
  "besylate",
  "maleate",
  "mesylate",
  "calcium",
  "magnesium",
  "citrate",
  "fumarate",
  "bromide",
  "sulfate",
  "acetate",
  "phosphate",
  "monohydrate",
  "dihydrate",
  "trihydrate",
  "hydrobromide",
  "bitartrate",
  "propionate",
  "furoate",
  "dipropionate",
  "xinafoate",
  "valerate",
]);

const COMPOUND_NAMES = new Set([
  "potassium chloride",
  "potassium citrate",
  "magnesium oxide",
  "magnesium citrate",
  "calcium carbonate",
  "calcium acetate",
  "calcium citrate",
  "sodium bicarbonate",
  "sodium chloride",
  "ferrous sulfate",
]);

const ABBREVIATIONS: Record<string, string> = {
  hctz: "hydrochlorothiazide",
  asa: "aspirin",
  apap: "acetaminophen",
  ntg: "nitroglycerin",
  kcl: "potassium chloride",
  mtx: "methotrexate",
  levo: "levothyroxine",
  synthyroid: "synthroid",
  nitro: "nitroglycerin",
  ppi: "omeprazole",
  mvi: "multivitamin",
  mvit: "multivitamin",
  fe: "ferrous sulfate",
  cyanocobalamine: "cyanocobalamin",
  tmp: "trimethoprim",
  smx: "sulfamethoxazole",
  pcn: "penicillin",
  amox: "amoxicillin",
};

export function normalizeMedicationLine(line: string): NormalizedMedication {
  let text = ` ${prepare(line)} `;
  const sig: string[] = [];
  const remove = (pattern: RegExp) => {
    const match = text.match(pattern);
    if (!match) return null;
    sig.push(match[0].trim());
    text = text.replace(match[0], " ");
    return match;
  };

  const supply = SUPPLY.test(text) && !/\bprefilled\b/.test(text);
  const insulin = INSULIN.test(text);
  const sites = remove(SITES) ? 2 : 1;

  let insulinUnitsPerDose = 0;
  if (insulin) {
    const units = remove(/\b(?:inject\s+)?(\d+(?:\.\d+)?)\s*(?:units?|u|iu)\b(?!\s*\/)/);
    if (units) insulinUnitsPerDose = Number(units[1]);
  }

  let unitsPerDose = 1;
  const countMatch = text.match(
    new RegExp(
      `\\b(?:take|takes|use|inhale|apply|instill|inject)?\\s*${COUNT}\\s*${DOSE_UNIT}\\b`,
    ),
  );
  if (countMatch) {
    const count = COUNT_WORDS[countMatch[1]] ?? Number(countMatch[1]);
    if (count > 0 && count <= 10) {
      unitsPerDose = count;
      sig.push(countMatch[0].trim());
      text = text.replace(countMatch[0], ` ${countMatch[2]} `);
    }
  } else {
    const take = remove(
      /\b(?:take|takes|use)\s+(\d|one|two|three|half)\b(?!\s*(?:\.\d|mg|mcg|g\b|ml|units?|%|\/|-))/,
    );
    if (take) unitsPerDose = COUNT_WORDS[take[1]] ?? Number(take[1]);
  }

  let dailyFrequency: number | null = null;
  for (const [pattern, value] of FREQUENCIES) {
    let match = remove(pattern);
    while (match) {
      dailyFrequency ??= value(match);
      match = remove(pattern);
    }
  }
  remove(/\b(?:prn|as needed|if needed|when needed)\b/);

  const hints = {} as FormHints;
  for (const [key, pattern] of HINTS) {
    const found = text.match(pattern);
    hints[key] = Boolean(found);
    if (found) {
      sig.push(...found.map((word) => word.trim()));
      text = text.replace(pattern, " ");
    }
  }
  if (/\bsuccinate\b/.test(text)) hints.extended = true;
  if (hints.metered || (hints.powder && hints.inhaler)) hints.inhaler = true;
  hints.supply = supply;

  const strengths: string[] = [];
  const perVolume = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*(mg|mcg|g|units?|unt|iu|meq)\\s*\\/\\s*(\\d+(?:\\.\\d+)?)?\\s*ml\\b`,
  );
  let volumeMatch = text.match(perVolume);
  while (volumeMatch) {
    const per = volumeMatch[3] ? `/${Number(volumeMatch[3])} ml` : "/ml";
    strengths.push(formatStrength(volumeMatch[1], canonicalUnit(volumeMatch[2])) + per);
    const typedForm = Object.entries(hints).some(([key, on]) => on && key !== "extended" && key !== "delayed");
    if (!insulin && !typedForm && /^(?:mg|mcg|g)$/.test(volumeMatch[2])) hints.solution = true;
    text = text.replace(volumeMatch[0], " ");
    volumeMatch = text.match(perVolume);
  }

  let mlPerDose = 0;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*ml\b(\s*(?:bottles?|vials?|tubes?|pens?|containers?))?/g)) {
    if (!match[2] && mlPerDose === 0) mlPerDose = Number(match[1]);
    sig.push(match[0].trim());
  }
  text = text.replace(/(\d+(?:\.\d+)?)\s*ml\b/g, " ");

  const combo = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*(?:${STRENGTH_UNIT}(?![a-z]))?\\s*(?:-|\\/|\\+|and)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${STRENGTH_UNIT}(?![a-z]))?`,
  );
  let comboMatch = text.match(combo);
  while (comboMatch) {
    const second = canonicalUnit(comboMatch[4]);
    const first = canonicalUnit(comboMatch[2]) || second;
    strengths.push(
      formatStrength(comboMatch[1], first) +
        " / " +
        formatStrength(comboMatch[3], second || first),
    );
    text = text.replace(comboMatch[0], " ");
    comboMatch = text.match(combo);
  }
  const single = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*(?:${STRENGTH_UNIT}(?![a-z]))?(?:\\s*\\/\\s*(ml|actuat|dose))?`,
    "g",
  );
  for (const match of text.matchAll(single)) {
    const per = match[3] ? `/${match[3]}` : "";
    strengths.push(formatStrength(match[1], canonicalUnit(match[2])) + per);
  }
  text = text.replace(single, " ");

  const groups = text
    .replace(/\s*(?:\+|&|\band\b)\s*/g, " / ")
    .replace(/([a-z])\s*[-/]\s*(?=[a-z])/g, "$1 / ")
    .replace(/[^a-z/\s]/g, " ")
    .split("/")
    .map((group) => cleanWords(group))
    .filter((group) => group.typed.length > 0);

  const typedName = groups.map((group) => group.typed.join(" ")).join(" ");
  const tokens = groups.flatMap((group) => group.expanded);
  const normalized: NormalizedMedication = {
    rawLine: line.trim(),
    typedName,
    name: tokens.join(" "),
    tokens,
    explicitCombo: groups.length >= 2,
    strengths: supply ? [] : strengths,
    dailyFrequency: dailyFrequency ?? 1,
    unitsPerDose,
    sites,
    mlPerDose,
    insulinUnitsPerDose,
    insulin,
    monthlyQuantity: 1,
    quantityUnit: "each",
    hints,
    sigText: sig.join(" "),
  };
  const { quantity, unit } = monthlyQuantityFor(normalized, hintedFormLabel(hints));
  normalized.monthlyQuantity = quantity;
  normalized.quantityUnit = unit;
  return normalized;
}

const DROPS_PER_ML = 20;
const BOTTLE_SIZES_ML = [5, 10, 15];
const UNITS_PER_ML = 100;

/** A 30-day supply in the unit Medicare.gov asks for: drops and insulin in mL, inhalers and tubes as one package. */
export function monthlyQuantityFor(
  norm: NormalizedMedication,
  formLabel: string,
): { quantity: number; unit: QuantityUnit } {
  const form = formLabel.toLowerCase();
  const perDay = norm.dailyFrequency * norm.unitsPerDose * norm.sites;
  if (norm.hints.supply) return { quantity: Math.max(1, Math.ceil(perDay * 30)), unit: "each" };
  if (/ophthalmic|otic|drop/.test(form)) {
    const ml = (perDay * 30) / DROPS_PER_ML;
    const bottle = BOTTLE_SIZES_ML.find((size) => size >= ml) ?? Math.ceil(ml / 5) * 5;
    return { quantity: bottle, unit: "ml" };
  }
  if (norm.insulin) {
    const packageMl = /\bpen\b|injector|prefilled|cartridge/.test(form) ? 3 : 10;
    if (norm.insulinUnitsPerDose === 0) {
      return { quantity: packageMl === 3 ? 15 : 10, unit: "ml" };
    }
    const ml = (norm.insulinUnitsPerDose * norm.dailyFrequency * 30) / UNITS_PER_ML;
    return { quantity: Math.max(packageMl, Math.ceil(ml / packageMl) * packageMl), unit: "ml" };
  }
  if (/inhal|aerosol|cream|ointment|\bgel\b|lotion|nasal|spray|\bpen\b|injector|prefilled/.test(form)) {
    return { quantity: 1, unit: "package" };
  }
  if (norm.mlPerDose > 0 && /solution|suspension|syrup|elixir|liquid/.test(form)) {
    return { quantity: Math.max(1, Math.ceil(norm.mlPerDose * norm.dailyFrequency * 30)), unit: "ml" };
  }
  return { quantity: Math.max(1, Math.round(perDay * 30)), unit: "each" };
}

function hintedFormLabel(hints: FormHints) {
  if (hints.drops) return "ophthalmic solution";
  if (hints.spray) return "nasal spray";
  if (hints.inhaler) return "inhaler";
  if (hints.pen) return "pen injector";
  if (hints.cream) return "cream";
  if (hints.ointment) return "ointment";
  if (hints.solution) return "oral solution";
  if (hints.injection) return "injection";
  return "oral tablet";
}

function prepare(line: string) {
  return line
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/µg/g, "mcg")
    .replace(/\b(?:vitamin|vit)\s*b\s*-?\s*12\b|\bb\s*-?12\b/g, " cyanocobalamin ")
    .replace(/\b(?:vitamin|vit)\s*d\s*-?\s*3\b|\bd3\b/g, " cholecalciferol ")
    .replace(/\bvit\b/g, "vitamin")
    .replace(/\bfree\s+style\b/g, "freestyle")
    .replace(/\baccu[\s-]*che(?:c)?k\b/g, "accuchek")
    .replace(/\b(?:[a-z]\.){2,}[a-z]?\.?/g, (match) => match.replace(/\./g, ""))
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/(^|[^\d.])\.(\d)/g, (_, before: string, digit: string) => `${before}0.${digit}`)
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[(),;:]/g, " ");
}

function cleanWords(group: string) {
  const words = group.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const [index, word] of words.entries()) {
    const pair = `${word} ${words[index + 1] ?? ""}`;
    const previousPair = `${words[index - 1] ?? ""} ${word}`;
    if (COMPOUND_NAMES.has(pair) || COMPOUND_NAMES.has(previousPair)) {
      kept.push(word);
      continue;
    }
    if (word.length === 1 && words[index - 1] !== "vitamin") continue;
    if (STOP_WORDS.has(word) || SALT_WORDS.has(word)) continue;
    kept.push(word);
  }
  const expanded = kept.flatMap((word) => (ABBREVIATIONS[word] ?? word).split(" "));
  return { typed: kept, expanded };
}

function formatStrength(amount: string, unit: string) {
  const value = Number(amount);
  return unit ? `${value} ${unit === "unt" ? "units" : unit}` : `${value}`;
}
