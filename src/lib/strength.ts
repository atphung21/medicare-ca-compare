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

function amountKey(value: number, unit: string) {
  if (unit === "mcg") return `${Number((value / 1000).toFixed(6))}mg`;
  if (unit === "g") return `${Number((value * 1000).toFixed(6))}mg`;
  return `${Number(value.toFixed(6))}${unit}`;
}

/** Unit-aware key, so "50 mcg", "0.05 MG" and "0.05mg" compare equal. */
export function strengthKey(text: string, defaultUnit = "") {
  const pattern = new RegExp(
    `(\\d+(?:\\.\\d+)?)\\s*(?:${STRENGTH_UNIT}(?![a-z]))?(?:\\s*\\/\\s*(ml|actuat|hr|dose))?`,
    "gi",
  );
  const parts: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const unit = canonicalUnit(match[2]) || defaultUnit;
    const per = match[3] ? `/${match[3].toLowerCase()}` : "";
    parts.push(amountKey(Number(match[1]), unit) + per);
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
  return undefined;
}

function sortedKey(key: string) {
  return key.split("|").sort().join("|");
}
