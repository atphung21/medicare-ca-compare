import { geminiJson } from "@/lib/gemini";

interface RepairAnswer {
  notDrug?: boolean;
  drugs?: { name?: string; strength?: string; form?: string; extended?: boolean }[];
}

/**
 * Asks Gemini how a confusing medication line should be read, as one "name strength form" per drug
 * joined by "; ". Returns null when Gemini is unavailable, slow, or unsure. The caller checks the
 * reading against RxNorm before trusting it.
 */
export async function repairLineWithGemini(line: string): Promise<string | null> {
  const answer = await geminiJson<RepairAnswer>(
    [
      "A Medicare agent pasted this line from a client's medication list. Our parser could not read it with confidence.",
      `Line: "${line}"`,
      "Return the drugs it lists. Rules:",
      "- A name in parentheses after a drug is usually the same drug's brand or a repeat (\"Furosemide (Lasix)\" is one drug). Never list a brand and its generic as two drugs.",
      "- A combination product written with a dash (\"Sacubitril-Valsartan\", \"Docusate - Senna\") is one drug; put the ingredients in name joined by \" / \".",
      "- Use the US generic name found in RxNorm when the line names one, otherwise the brand.",
      "- strength: as written, such as \"20 mEq\" or \"24 mg / 26 mg\". Ignore unit equivalents in parentheses such as \"(2,000 U)\".",
      "- form: tablet, capsule, solution, sublingual tablet, patch, inhaler, eye drops, pen, cream and so on, or \"\".",
      "- extended: true for ER, XR, XL, SR, CR, LA, 24 hr or extended release.",
      "- Do not add drugs that are not on the line. If it is not a medication at all, set notDrug true.",
      'Return JSON {"notDrug":false,"drugs":[{"name":"","strength":"","form":"","extended":false}]}.',
    ].join("\n"),
    { model: process.env.GEMINI_REPAIR_MODEL || "gemini-flash-lite-latest", timeoutMs: 15000 },
  );
  if (!answer) return null;
  if (answer.notDrug) return null;
  const readings = (answer.drugs ?? [])
    .map((drug) =>
      [drug.name, drug.strength, drug.extended ? "extended release" : "", drug.form]
        .map((part) => (part ?? "").replace(/[;()]/g, " ").trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter((reading) => reading.length > 2);
  return readings.length > 0 ? readings.join("; ") : null;
}
