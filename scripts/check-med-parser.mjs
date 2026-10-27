// Runs real-world medication lines through the smart-entry parser and checks the result.
// Usage: npm run check:meds   (needs internet for RxNorm; Gemini is turned off so results are repeatable)
import { transpileSources } from "./lib/transpile.mjs";

const load = await transpileSources("check-meds", [
  "lib/strength.ts",
  "lib/gemini.ts",
  "schemas/medicare.ts",
  "services/drug-spellcheck.ts",
  "services/rxnorm-resolver.ts",
  "services/med-line-normalizer.ts",
  "services/assistant/knowledge.ts",
  "services/assistant/knowledge-sync.ts",
  "services/assistant/memory.ts",
  "services/med-line-repair.ts",
  "services/med-list-parser.ts",
]);

delete process.env.GEMINI_API_KEY;
process.env.SKIP_TAUGHT_PHRASES = "1";
const { parseMedicationList } = await load("services/med-list-parser");

/**
 * name: expected drug name (case-insensitive substring)
 * strength: expected selected strength label, or null when the user must pick one
 * form: regex the selected form must match
 * quantity: expected 30-day quantity
 */
const CASES = [
  { line: "DORZOLAMIDE HCL 2% EYE DROPS INSTILL 1 DROP INTO BOTH EYES TWICE A DAY", name: "dorzolamide", strength: "20 mg/ml", form: /ophthalmic/i, quantity: 10 },
  { line: "dorzolamide-timolol 2-0.5% 1 gtt OU bid", name: "dorzolamide / timolol", strength: "20 mg/ml / 5 mg/ml", form: /ophthalmic/i, quantity: 10 },
  { line: "latanoprost 0.005% 1 drop each eye at bedtime", name: "latanoprost", strength: "0.05 mg/ml", form: /ophthalmic/i, quantity: 5 },
  { line: "timolol 0.5% ophth soln 1 gtt OU daily", name: "timolol", strength: "5 mg/ml", form: /ophthalmic/i, quantity: 5 },
  { line: "brimonidine 0.2% eye drops 1 drop both eyes tid", name: "brimonidine", strength: "2 mg/ml", form: /ophthalmic/i, quantity: 10 },
  { line: "ofloxacin 0.3% ear drops 5 drops into affected ear twice daily", name: "ofloxacin", strength: "3 mg/ml", form: /otic|ophthalmic/i, quantity: 15 },
  { line: "freestyle", name: "FreeStyle Lite Test Strips", supply: true, quantity: 30 },
  { line: "FreeStyle Lite test strips check sugar 3x daily", name: "FreeStyle Lite Test Strips", supply: true, quantity: 90 },
  { line: "freestyle lancets use to check blood sugar twice a day", name: "FreeStyle Lite Lancets", supply: true, quantity: 60 },
  { line: "OneTouch Ultra strips test 4 times daily", name: "OneTouch Ultra Test Strips", supply: true, quantity: 120 },
  { line: "insulin pen needles 32g 4mm use daily", name: "Pen Needles", supply: true, quantity: 30 },
  { line: "Dexcom G7 sensor", name: "Dexcom G7 Sensor", supply: true },
  { line: "Lantus Solostar 20 units qhs", name: "lantus", form: /pen/i, quantity: 6 },
  { line: "insulin glargine 100 units/ml inject 30 units at bedtime", name: "glargine", strength: "100 units/ml", quantity: 9 },
  { line: "albuterol HFA 2 puffs q4-6h prn", name: "albuterol", form: /metered dose inhaler/i, quantity: 1 },
  { line: "Advair Diskus 250/50 1 puff bid", name: "advair", form: /powder/i, quantity: 1 },
  { line: "Ozempic 0.25 mg once a week", name: "ozempic", strength: "0.25 mg, 0.5 mg", form: /pen/i, quantity: 1 },
  { line: "cyclobenzaprine 10 mg tid prn muscle spasm", name: "cyclobenzaprine", strength: "10 mg", quantity: 90 },
  { line: "vit b12 1000 mcg daily", name: "cyanocobalamin", quantity: 30 },
  { line: "fluticasone nasal 50 mcg 2 sprays each nostril daily", name: "fluticasone", form: /nasal/i, quantity: 1 },
  { line: "amoxicillin 250mg/5ml 5 ml tid", name: "amoxicillin", strength: "50 mg/ml", form: /suspension/i, quantity: 450 },
  { line: "triamcinolone 0.1% cream apply bid", name: "triamcinolone", strength: "1 mg/ml", form: /cream/i, quantity: 1 },
  { line: "nitroglycerin 0.4 mg SL prn chest pain", name: "nitroglycerin", strength: "0.4 mg", form: /sublingual/i },
  { line: "Ozempic 0.5 mg weekly", name: "ozempic", strength: "0.25 mg, 0.5 mg", form: /pen/i, quantity: 1 },
  { line: "lisinopril 10 mg", name: "lisinopril", strength: "10 mg", form: /^oral tablet$/i, quantity: 30 },
  { line: "hctz 25", name: "hydrochlorothiazide", strength: "25 mg", quantity: 30 },
  { line: "losartan-hctz 50-12.5 daily", name: "losartan", strength: "12.5 mg / 50 mg", quantity: 30 },
  { line: "Potassium chloride ER 20 mEq daily", name: "potassium chloride", strength: "20 meq", form: /extended/i, quantity: 30 },
  { line: "metformin ER 500 2 tabs bid", name: "metformin", strength: "500 mg", form: /extended/i, quantity: 120 },
  { line: "levothyroxine 50 mcg daily", name: "levothyroxine", strength: "0.05 mg", quantity: 30 },
  { line: "zolpidem 10 mg at bedtime", name: "zolpidem", strength: "10 mg", form: /^oral tablet$/i, quantity: 30 },
  { line: "Xanax 0.5 mg tid prn", name: "xanax", strength: "0.5 mg", quantity: 90 },
  { line: "lisinoprl 20mg qd", name: "lisinopril", strength: "20 mg", quantity: 30 },
  { line: "atorvastatin 40mg 1 tab po qhs", name: "atorvastatin", strength: "40 mg", quantity: 30 },
  { line: "Eliquis 5 mg BID", name: "eliquis", strength: "5 mg", quantity: 60 },
  { line: "metoprolol succinate 25 mg daily", name: "metoprolol succinate", strength: "25 mg", form: /extended/i, quantity: 30 },
  { line: "gabapentin 300 mg 1 cap tid", name: "gabapentin", strength: "300 mg", form: /capsule/i, quantity: 90 },
  { line: "omeprazole 20mg DR cap daily before breakfast", name: "omeprazole", strength: "20 mg", form: /delayed/i, quantity: 30 },
  { line: "prednisone 10 mg 1/2 tab daily", name: "prednisone", strength: "10 mg", quantity: 15 },
  { line: "vitamin D3 1000 units daily", name: "cholecalciferol", quantity: 30 },
  { line: "aspirin 81 mg EC daily", name: "aspirin", strength: "81 mg", quantity: 30 },
  { line: "furosemide 40 mg 2 tabs every morning", name: "furosemide", strength: "40 mg", quantity: 60 },
  { line: "Tylenol 500 mg q6h prn", name: "tylenol", strength: "500 mg", form: /tablet/i, quantity: 120 },
  { line: "fentanyl 25 mcg/hr patch every 72 hours", name: "fentanyl", form: /transdermal|patch/i },
  // A discharge list from an email: brand names in parentheses, repeated names, IU equivalents, OTC vitamins.
  { line: "Cholecalciferol (Cholecalciferol 50mcg (2,000U) Capsule – 1 Capsule by Mouth Once a Day", name: "cholecalciferol", form: /capsule/i, quantity: 30, otc: true },
  { line: "Empagliflozin (Jardiance) 10mg Tablet – 1 Tablet by Mouth Once a Day", name: "empagliflozin", strength: "10 mg", form: /tablet/i, quantity: 30, otc: false },
  { line: "Potassium Chloride (Potassium Chloride 20 mEq Extended Release) – 1 Tablet by Mouth Once a Day", name: "potassium chloride", strength: "20 meq", form: /extended/i, quantity: 30, otc: false },
  { line: "Sacubitril-Valsartan (Entresto) 24mg-26mg Tablet – 1 Tablet by Mouth Twice a Day", name: "sacubitril / valsartan", strength: "24 mg / 26 mg", form: /tablet/i, quantity: 60 },
  { line: "Spironolactone 25mg Tablet - 1 Tablet by Mouth Once a Day", name: "spironolactone", strength: "25 mg", quantity: 30 },
  { line: "Furosemide (Lasix) 40mg Tablet - 1 Tablet by Mouth Twice a Day", name: "furosemide", strength: "40 mg", quantity: 60 },
  { line: "Levothyroxine 112mcg Tablet - 1 Tablet by Mouth Once a Day", name: "levothyroxine", strength: "0.112 mg", quantity: 30 },
  { line: "Apixaban (Eliquis) 5mg Tablet - 1 Tablet by Mouth Twice a Day", name: "apixaban", strength: "5 mg", quantity: 60 },
  { line: "Atorvastatin 40mg Tablet - 1 Tablet by Mouth Once a Day", name: "atorvastatin", strength: "40 mg", quantity: 30 },
  { line: "Calcium 500mg - Vitamin D 5mcg (200 unit) Tablet - 1 Tablet by Mouth Once a Day", name: "calcium", quantity: 30, otc: true },
  { line: "Digoxin 125mcg Tablet - 1 Tablet by Mouth Once Every Other Day", name: "digoxin", strength: "0.125 mg", quantity: 15 },
  { line: "Ferrous Fumarate (Ferrets) 325mg Tablet - 1 Tablet by Mouth Once a Day", name: "ferrous fumarate", quantity: 30, otc: true },
  { line: "Metoprolol Succinate 50mg ER Tablet - 1 Tablet by Mouth Twice a Day", name: "metoprolol succinate", strength: "50 mg", form: /extended/i, quantity: 60 },
  { line: "Metoprolol Succinate 50 mg extended release tablet", name: "metoprolol succinate", strength: "50 mg", form: /extended/i, quantity: 30 },
  { line: "Thiamine 100mg Tablet – 2 Tablets by Mouth Once a Day", name: "thiamine", quantity: 60, otc: true },
  { line: "Docusate 50mg – Senna 8.6mg Tablet - 1 Tablet by Mouth Once a Day AS NEEDED", name: "docusate", quantity: 30, otc: true },
  { line: "Toprol XL (metoprolol succinate) 25 mg daily", name: "toprol", strength: "25 mg", form: /extended/i, quantity: 30 },
  { line: "Vitamin D3 (cholecalciferol, OTC) 1000 units daily", name: "cholecalciferol", quantity: 30, otc: true },
  { line: "Nitroglycerin 0.4mg Sublingual Tablet – 1 Tab Under Tongue Every 5 Minutes AS NEEDED (Do not exceed 3 doses/15 minutes).", name: "nitroglycerin", strength: "0.4 mg", form: /sublingual/i, otc: false },
];

let failures = 0;
for (const testCase of CASES) {
  const problems = [];
  let drafts = [];
  try {
    drafts = await parseMedicationList(testCase.line);
  } catch (error) {
    problems.push(`threw ${error.message}`);
  }
  const draft = drafts[0];
  const selectedStrength = draft?.strengths.find((option) => option.selected)?.label ?? null;
  const selectedForm = draft?.forms.find((option) => option.selected)?.label ?? "";
  if (!draft) problems.push("no draft");
  else {
    if (drafts.length !== 1) problems.push(`${drafts.length} drafts`);
    if (!draft.drugName.toLowerCase().includes(testCase.name.toLowerCase())) problems.push(`name ${draft.drugName}`);
    if (testCase.supply !== undefined && Boolean(draft.isSupply) !== testCase.supply) problems.push(`supply ${draft.isSupply}`);
    if (testCase.otc !== undefined && Boolean(draft.isOtc) !== testCase.otc) problems.push(`otc ${Boolean(draft.isOtc)}`);
    if (testCase.strength !== undefined && (selectedStrength ?? "").toLowerCase() !== (testCase.strength ?? "").toLowerCase())
      problems.push(`strength ${selectedStrength}`);
    if (testCase.form && !testCase.form.test(selectedForm)) problems.push(`form ${selectedForm || "(none)"}`);
    if (testCase.quantity !== undefined && draft.monthlyQuantity !== testCase.quantity) problems.push(`quantity ${draft.monthlyQuantity}`);
  }
  if (problems.length > 0) failures += 1;
  const summary = drafts.length > 0
    ? drafts.map((item) => `${item.drugName} | ${item.strengths.find((option) => option.selected)?.label ?? "-"} | ${item.forms.find((option) => option.selected)?.label || "-"} | qty ${item.monthlyQuantity}${item.isOtc ? " | OTC" : ""}`).join("\n     ")
    : "-";
  console.log(`${problems.length ? "FAIL" : "ok  "} ${testCase.line}\n     ${summary}${problems.length ? `\n     ${problems.join("; ")}` : ""}`);
}

// A fix taught on the comparison page replaces the parser's reading; the original line still sets the quantity.
{
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.KNOWLEDGE_DIR = await mkdtemp(path.join(os.tmpdir(), "check-meds-"));
  delete process.env.KNOWLEDGE_REPO;
  delete process.env.KNOWLEDGE_TOKEN;
  const memory = await load("services/assistant/memory");
  const { medicationLineKey } = await load("services/med-line-normalizer");
  const { parseTypedLine } = await load("services/med-list-parser");
  const line = "Ferrets 325 - 1 tab by mouth twice a day";
  await memory.saveLineFix(medicationLineKey(line), line, "ferrous fumarate 325 mg tablet");
  await memory.setOtc("Ferrous Fumarate", false);
  const drafts = await parseTypedLine(line);
  const draft = drafts[0];
  const problems = [];
  if (drafts.length !== 1) problems.push(`${drafts.length} drafts`);
  if (!/ferrous fumarate/i.test(draft?.drugName ?? "")) problems.push(`name ${draft?.drugName}`);
  if (draft?.monthlyQuantity !== 60) problems.push(`quantity ${draft?.monthlyQuantity}`);
  if (draft?.isOtc !== false) problems.push("OTC marking not applied");
  if (!draft?.learnedFix) problems.push("learnedFix missing");
  if (draft?.rawLine !== line) problems.push(`rawLine ${draft?.rawLine}`);
  console.log(`${problems.length ? "FAIL" : "ok  "} learned line fix: ${line}${problems.length ? `\n     ${problems.join("; ")}` : ""}`);
  if (problems.length) failures += 1;
}

console.log(`\n${CASES.length + 1 - failures}/${CASES.length + 1} passed`);
process.exitCode = failures > 0 ? 1 : 0;
