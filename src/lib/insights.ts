import type { DrugInput, MedicarePlanComparison, PharmacyPlanQuote } from "@/schemas/medicare";

export function drugsVerified(medications: DrugInput[], quote: PharmacyPlanQuote) {
  const needed = medications.filter((drug) => !drug.isSupply).flatMap((drug) => {
    const ids = drug.rxcui ? [drug.rxcui] : [];
    if (drug.compareBothForms && drug.alternate?.rxcui) ids.push(drug.alternate.rxcui);
    return ids.length ? ids : [""];
  });
  return needed.every((rxcui) => rxcui && quote.drugBreakdowns.some((drug) => drug.rxcui === rxcui));
}

export function formularyFormTip(plan: MedicarePlanComparison, quote: PharmacyPlanQuote) {
  const byStem = new Map<string, typeof quote.drugBreakdowns>();
  for (const drug of quote.drugBreakdowns) {
    const stem = drug.drugId.replace(/-alt$/, "");
    const group = byStem.get(stem) ?? [];
    group.push(drug);
    byStem.set(stem, group);
  }
  const tips: string[] = [];
  for (const group of byStem.values()) {
    if (group.length < 2) continue;
    const [left, right] = group;
    if (left.tier === right.tier) continue;
    tips.push(
      `Formulary tip: On ${plan.planName}, ${left.drugName} is ${left.tier ? `tier ${left.tier}` : "not covered"} and ${right.drugName} is ${right.tier ? `tier ${right.tier}` : "not covered"}.`,
    );
  }
  return tips;
}

export function splitPharmacyTip(plan: MedicarePlanComparison) {
  const inNetwork = plan.pharmacyQuotes.filter((quote) => quote.networkStatus !== "OUT_OF_NETWORK");
  if (inNetwork.length < 2) return null;
  const drugIds = inNetwork[0]?.drugBreakdowns.map((drug) => drug.drugId) ?? [];
  if (drugIds.length === 0) return null;

  const assignments = drugIds.map((drugId) => {
    let best = inNetwork[0];
    let bestCost = Number.POSITIVE_INFINITY;
    for (const quote of inNetwork) {
      const drug = quote.drugBreakdowns.find((item) => item.drugId === drugId);
      const cost = drug?.annualOutOfPocketForDrug ?? Number.POSITIVE_INFINITY;
      if (cost < bestCost) {
        best = quote;
        bestCost = cost;
      }
    }
    const drug = best.drugBreakdowns.find((item) => item.drugId === drugId);
    return { pharmacy: best.pharmacyName, drug: drug?.drugName ?? "Drug", cost: bestCost };
  });

  const pharmacies = new Set(assignments.map((item) => item.pharmacy));
  if (pharmacies.size < 2) return null;

  const splitTotal = assignments.reduce((sum, item) => sum + item.cost, 0);
  const single = inNetwork.map((quote) => ({
    name: quote.pharmacyName,
    total: quote.drugBreakdowns.reduce((sum, drug) => sum + drug.annualOutOfPocketForDrug, 0),
  }));
  const baseline = single.reduce((best, item) => (item.total < best.total ? item : best));
  const savings = Math.round((baseline.total - splitTotal) * 100) / 100;
  if (savings < 1) return null;

  const grouped = new Map<string, string[]>();
  for (const item of assignments) {
    const names = grouped.get(item.pharmacy) ?? [];
    names.push(item.drug);
    grouped.set(item.pharmacy, names);
  }
  const pieces = [...grouped.entries()].map(([pharmacy, names]) => `${names.join(", ")} at ${pharmacy}`);
  return `Split-pharmacy tip: Filling ${pieces.join(" and ")} saves about ${savings.toLocaleString("en-US", { style: "currency", currency: "USD" })} a year versus filling every drug at ${baseline.name} on ${plan.planName}.`;
}

export function isCostCulprit(drugAnnual: number, planAnnual: number, covered: boolean) {
  if (!covered) return true;
  if (planAnnual <= 0) return false;
  return drugAnnual / planAnnual > 0.5;
}
