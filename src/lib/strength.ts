const UNIT_ALIASES: Record<string, string> = {
  mg: "mg",
  mgs: "mg",
  mcg: "mcg",
  mcgs: "mcg",
  ug: "mcg",
  g: "g",
  gm: "g",
  gram: "g",
  grams: "g",
  ml: "ml",
  unt: "unt",
  unit: "unt",
  units: "unt",
  iu: "unt",
  meq: "meq",
  "%": "%",
};

export const STRENGTH_UNIT =
  "(mg|mgs|mcg|mcgs|ug|grams?|gm|g|ml|units?|unt|iu|meq|%)";

export function canonicalUnit(unit: string | undefined) {
  return unit ? (UNIT_ALIASES[unit.toLowerCase()] ?? unit.toLowerCase()) : "";
}

/** "2%" is 20 mg/mL and "250 mg/5 mL" is 50 mg/mL, so labels written either way compare equal. */
function amountKey(value: number, unit: string, per: string, perAmount: number) {
  if (unit === "%") {
    value *= 10;
    unit = "mg";
    per = "/ml";
  } else if (per === "/ml" && perAmount > 0) {
    value /= perAmount;
  }
  if (unit === "mcg") return `${Number((value / 1000).toFixed(6))}mg${per}`;
  if (unit === "g") return `${Number((value * 1000).toFixed(6))}mg${per}`;
  return `${Number(value.toFixed(6))}${unit}${per}`;
}

/** Unit-aware key, so "50 mcg", "0.05 MG" and "0.05mg" compare equal. */
export function strengthKey(text: string, defaultUnit = "") {
  const pattern = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*(?:${STRENGTH_UNIT}(?![a-z]))?(?:\\s*\\/\\s*(\\d+(?:\\.\\d+)?)?\\s*(ml|actuat|hr|dose)\\b)?`,
    "gi",
  );
  const parts: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const unit = canonicalUnit(match[2]) || defaultUnit;
    const per = match[4] ? `/${match[4].toLowerCase()}` : "";
    parts.push(amountKey(Number(match[1]), unit, per, Number(match[3] ?? 0)));
  }
  return parts.join("|");
}

export function sameStrength(left: string, right: string) {
  const key = strengthKey(left);
  return key.length > 0 && key === strengthKey(right);
}

export function hasStrengthUnit(text: string) {
  return new RegExp(`\\d\\s*${STRENGTH_UNIT}(?![a-z])`, "i").test(text);
}

/** Finds the label that matches a typed strength. A typed number without a unit tries mg, then mcg. */
export function matchStrengthLabel(labels: string[], typed: string) {
  const units = hasStrengthUnit(typed) ? [""] : ["mg", "mcg"];
  for (const unit of units) {
    const key = strengthKey(typed, unit);
    const found = labels.find((label) => strengthKey(label) === key);
    if (found) return found;
  }
  for (const unit of units) {
    const key = sortedKey(strengthKey(typed, unit));
    const found = labels.find((label) => sortedKey(strengthKey(label)) === key);
    if (found) return found;
  }
  // Multi-dose pens are labeled "0.25 MG, 0.5 MG", so a typed 0.5 mg matches one of the listed doses.
  for (const unit of units) {
    const key = strengthKey(typed, unit);
    if (key.includes("|")) continue;
    const found = labels.find((label) => label.includes(",") && strengthKey(label).split("|").includes(key));
    if (found) return found;
  }
  return undefined;
}

function sortedKey(key: string) {
  return key.split("|").sort().join("|");
}
