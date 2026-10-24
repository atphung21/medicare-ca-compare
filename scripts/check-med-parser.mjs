// Runs real-world medication lines through the smart-entry parser and checks the result.
// Usage: npm run check:meds   (needs internet for RxNorm; Gemini is turned off so results are repeatable)
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "node_modules", ".cache", "check-meds");
const sources = [
  "lib/strength.ts",
  "lib/gemini.ts",
  "schemas/medicare.ts",
  "services/drug-spellcheck.ts",
  "services/rxnorm-resolver.ts",
  "services/med-line-normalizer.ts",
  "services/assistant/memory.ts",
  "services/med-list-parser.ts",
];

for (const file of sources) {
  const code = await readFile(path.join(root, "src", file), "utf8");
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const target = path.join(out, file.replace(/\.ts$/, ".mjs"));
  const rewritten = outputText.replace(/from "@\/([^"]+)"/g, (_, spec) => {
    const absolute = path.join(out, `${spec}.mjs`);
    return `from "${pathToFileURL(absolute).href}"`;
  });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rewritten);
}

delete process.env.GEMINI_API_KEY;
process.env.SKIP_TAUGHT_PHRASES = "1";
const { parseMedicationList } = await import(pathToFileURL(path.join(out, "services/med-list-parser.mjs")).href);

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
  { line: "metoprolol succinate 25 mg daily", name: "metoprolol", strength: "25 mg", form: /extended/i, quantity: 30 },
  { line: "gabapentin 300 mg 1 cap tid", name: "gabapentin", strength: "300 mg", form: /capsule/i, quantity: 90 },
  { line: "omeprazole 20mg DR cap daily before breakfast", name: "omeprazole", strength: "20 mg", form: /delayed/i, quantity: 30 },
  { line: "prednisone 10 mg 1/2 tab daily", name: "prednisone", strength: "10 mg", quantity: 15 },
  { line: "vitamin D3 1000 units daily", name: "cholecalciferol", quantity: 30 },
  { line: "aspirin 81 mg EC daily", name: "aspirin", strength: "81 mg", quantity: 30 },
  { line: "furosemide 40 mg 2 tabs every morning", name: "furosemide", strength: "40 mg", quantity: 60 },
  { line: "Tylenol 500 mg q6h prn", name: "tylenol", strength: "500 mg", form: /tablet/i, quantity: 120 },
  { line: "fentanyl 25 mcg/hr patch every 72 hours", name: "fentanyl", form: /transdermal|patch/i },
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
    if (testCase.strength !== undefined && (selectedStrength ?? "").toLowerCase() !== (testCase.strength ?? "").toLowerCase())
      problems.push(`strength ${selectedStrength}`);
    if (testCase.form && !testCase.form.test(selectedForm)) problems.push(`form ${selectedForm || "(none)"}`);
    if (testCase.quantity !== undefined && draft.monthlyQuantity !== testCase.quantity) problems.push(`quantity ${draft.monthlyQuantity}`);
  }
  if (problems.length > 0) failures += 1;
  const summary = draft ? `${draft.drugName} | ${selectedStrength ?? "-"} | ${selectedForm || "-"} | qty ${draft.monthlyQuantity}` : "-";
  console.log(`${problems.length ? "FAIL" : "ok  "} ${testCase.line}\n     ${summary}${problems.length ? `\n     ${problems.join("; ")}` : ""}`);
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
process.exitCode = failures > 0 ? 1 : 0;
