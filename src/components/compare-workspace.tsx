"use client";

import {
  countiesForZip,
  PHARMACY_CATALOG,
  type CompareRequest,
  type DosageForm,
  type DrugInput,
  type MedicarePlanComparison,
  type PharmacyInput,
  type PharmacyPlanQuote,
} from "@/schemas/medicare";
import { Fragment, useMemo, useState, type FormEvent } from "react";

const FORMS: { value: DosageForm; label: string }[] = [
  { value: "TABLET", label: "Tablet" },
  { value: "CAPSULE", label: "Capsule" },
  { value: "INJECTABLE_PEN", label: "Injectable pen" },
  { value: "VIAL", label: "Vial" },
  { value: "INHALER", label: "Inhaler" },
  { value: "CREAM", label: "Cream" },
  { value: "DROPS", label: "Drops" },
];

type SortKey = "total" | "drug" | "premium";
type DeductibleFilter = "any" | "zero";
type NetworkFilter = "any" | "preferred" | "all-in-network";

function money(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function newDrug(): DrugInput {
  return {
    id: crypto.randomUUID(),
    name: "",
    strength: "",
    dosageForm: "TABLET",
    quantityPerFill: 30,
    refillFrequencyMonths: "1",
    acceptGeneric: true,
  };
}

function coversFormulary(plan: MedicarePlanComparison) {
  const quote = plan.pharmacyQuotes[0];
  return quote.drugBreakdowns.every((drug) => drug.tier !== null);
}

function inNetwork(quote: PharmacyPlanQuote) {
  return quote.networkStatus !== "OUT_OF_NETWORK";
}

function comparisonQuote(plan: MedicarePlanComparison, pharmacyId: string) {
  if (pharmacyId !== "cheapest") {
    return plan.pharmacyQuotes.find((quote) => quote.pharmacyId === pharmacyId) ?? plan.pharmacyQuotes[0];
  }
  const eligible = plan.pharmacyQuotes.filter(inNetwork);
  const pool = eligible.length ? eligible : plan.pharmacyQuotes;
  return pool.reduce((best, quote) => (quote.totalAnnualCost < best.totalAnnualCost ? quote : best));
}

function networkLabel(status: PharmacyPlanQuote["networkStatus"]) {
  if (status === "PREFERRED") return "Preferred";
  if (status === "STANDARD") return "Standard";
  return "Out of network";
}

export function CompareWorkspace() {
  const [zipCode, setZipCode] = useState("92704");
  const [countyFips, setCountyFips] = useState("06059");
  const [contractYear, setContractYear] = useState<"2026" | "2027">("2027");
  const [medications, setMedications] = useState<DrugInput[]>([
    {
      id: "atorvastatin",
      name: "Atorvastatin",
      strength: "20mg",
      dosageForm: "TABLET",
      quantityPerFill: 30,
      refillFrequencyMonths: "1",
      acceptGeneric: true,
    },
    {
      id: "eliquis",
      name: "Eliquis",
      strength: "5mg",
      dosageForm: "TABLET",
      quantityPerFill: 60,
      refillFrequencyMonths: "1",
      acceptGeneric: false,
    },
  ]);
  const [selectedPharmacyIds, setSelectedPharmacyIds] = useState<string[]>([
    "cvs-bristol",
    "walgreens-17th",
    "mail-order",
  ]);
  const [plans, setPlans] = useState<MedicarePlanComparison[]>([]);
  const [context, setContext] = useState<{ zipCode: string; countyName: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [planType, setPlanType] = useState<"ALL" | "MAPD" | "PDP">("ALL");
  const [carrier, setCarrier] = useState("ALL");
  const [minStars, setMinStars] = useState(0);
  const [maxPremium, setMaxPremium] = useState("");
  const [deductible, setDeductible] = useState<DeductibleFilter>("any");
  const [network, setNetwork] = useState<NetworkFilter>("any");
  const [preferredPharmacyId, setPreferredPharmacyId] = useState("cvs-bristol");
  const [coveredOnly, setCoveredOnly] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [comparePharmacyId, setComparePharmacyId] = useState("cheapest");
  const [openPlan, setOpenPlan] = useState<string | null>(null);

  const counties = countiesForZip(zipCode);
  const selectedPharmacies = PHARMACY_CATALOG.filter((pharmacy) => selectedPharmacyIds.includes(pharmacy.id));
  const retailCount = selectedPharmacies.filter((pharmacy) => !pharmacy.isMailOrder).length;

  const filtered = useMemo(() => {
    const premiumCap = maxPremium === "" ? null : Number(maxPremium);
    const rows = plans.filter((plan) => {
      if (planType !== "ALL" && plan.planType !== planType) return false;
      if (carrier !== "ALL" && plan.carrierName !== carrier) return false;
      if (plan.starRating < minStars) return false;
      if (premiumCap !== null && !Number.isNaN(premiumCap) && plan.monthlyPremium > premiumCap) return false;
      if (deductible === "zero" && plan.annualDrugDeductible !== 0) return false;
      if (coveredOnly && !coversFormulary(plan)) return false;
      if (network === "preferred") {
        const quote = plan.pharmacyQuotes.find((item) => item.pharmacyId === preferredPharmacyId);
        if (!quote || quote.networkStatus !== "PREFERRED") return false;
      }
      if (network === "all-in-network" && plan.pharmacyQuotes.some((quote) => !inNetwork(quote))) return false;
      return true;
    });
    rows.sort((a, b) => {
      const left = comparisonQuote(a, comparePharmacyId);
      const right = comparisonQuote(b, comparePharmacyId);
      if (sortKey === "premium") return a.monthlyPremium - b.monthlyPremium;
      if (sortKey === "drug") return left.annualDrugCostOop - right.annualDrugCostOop;
      return left.totalAnnualCost - right.totalAnnualCost;
    });
    return rows;
  }, [plans, planType, carrier, minStars, maxPremium, deductible, coveredOnly, network, preferredPharmacyId, sortKey, comparePharmacyId]);

  const cheapest = useMemo(() => {
    let best: { planId: string; pharmacyId: string; cost: number } | null = null;
    for (const plan of filtered) {
      for (const quote of plan.pharmacyQuotes) {
        if (!inNetwork(quote)) continue;
        if (!best || quote.annualDrugCostOop < best.cost) {
          best = { planId: `${plan.contractId}-${plan.planId}`, pharmacyId: quote.pharmacyId, cost: quote.annualDrugCostOop };
        }
      }
    }
    return best;
  }, [filtered]);

  const carriers = [...new Set(plans.map((plan) => plan.carrierName))];

  function updateDrug(id: string, patch: Partial<DrugInput>) {
    setMedications((current) => current.map((drug) => (drug.id === id ? { ...drug, ...patch } : drug)));
  }

  function togglePharmacy(pharmacy: PharmacyInput) {
    setSelectedPharmacyIds((current) => {
      if (current.includes(pharmacy.id)) return current.filter((id) => id !== pharmacy.id);
      const next = [...current, pharmacy.id];
      const retail = PHARMACY_CATALOG.filter((item) => next.includes(item.id) && !item.isMailOrder);
      if (retail.length > 5) return current;
      return next;
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const county = counties.find((item) => item.fips === countyFips) ?? counties[0];
    if (!county) {
      setError("Choose a county.");
      return;
    }
    const incomplete = medications.find((drug) => drug.name.trim().length < 2 || !drug.strength.trim() || !drug.dosageForm);
    if (incomplete) {
      setError("Each drug needs a name, strength, and dosage form. The form will not guess a missing form.");
      return;
    }
    if (selectedPharmacies.length === 0) {
      setError("Select at least one pharmacy.");
      return;
    }
    const payload: CompareRequest = {
      zipCode,
      countyFips: county.fips,
      countyName: county.name,
      contractYear,
      medications,
      pharmacies: selectedPharmacies,
    };
    setLoading(true);
    try {
      const response = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not compare plans.");
        return;
      }
      setPlans(data.plans);
      setContext({ zipCode: data.zipCode, countyName: data.countyName });
      setPreferredPharmacyId(selectedPharmacies[0]?.id ?? "cvs-bristol");
      setComparePharmacyId("cheapest");
      setOpenPlan(null);
    } catch {
      setError("Could not reach the comparison service.");
    } finally {
      setLoading(false);
    }
  }

  function exportCsv() {
    const pharmacyHeaders = (plans[0]?.pharmacyQuotes ?? []).flatMap((quote) => [
      `${quote.pharmacyName} network`,
      `${quote.pharmacyName} annual drug cost`,
    ]);
    const header = ["Plan", "Carrier", "Type", "Stars", "Monthly premium", "Deductible", "Comparison pharmacy", "Drug cost", "Total annual", ...pharmacyHeaders];
    const lines = filtered.map((plan) => {
      const quote = comparisonQuote(plan, comparePharmacyId);
      const cells = [
        plan.planName,
        plan.carrierName,
        plan.planType,
        String(plan.starRating),
        String(plan.monthlyPremium),
        String(plan.annualDrugDeductible),
        quote.pharmacyName,
        String(quote.annualDrugCostOop),
        String(quote.totalAnnualCost),
        ...plan.pharmacyQuotes.flatMap((item) => [networkLabel(item.networkStatus), String(item.annualDrugCostOop)]),
      ];
      return cells.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",");
    });
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "california-medicare-comparison.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
      <header className="mb-6 max-w-3xl">
        <p className="text-sm font-medium tracking-wide text-[var(--accent)]">Licensed agent planning tool</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">California Medicare drug comparison</h1>
        <p className="mt-3 text-sm leading-6 text-stone-700">
          These figures are sample planning estimates, not a beneficiary quote. Confirm the final one or two plans in
          Medicare.gov or the agency quoting tool. Annual out-of-pocket drug costs in this sample stop at the{" "}
          {money(2100)} Part D cap.
        </p>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-[380px_1fr]">
        <form onSubmit={onSubmit} className="space-y-5 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4 shadow-sm">
          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Location</legend>
            <label className="block text-sm">
              California ZIP
              <input
                value={zipCode}
                onChange={(event) => {
                  const next = event.target.value.replace(/\D/g, "").slice(0, 5);
                  setZipCode(next);
                  const nextCounties = countiesForZip(next);
                  if (!nextCounties.some((county) => county.fips === countyFips)) {
                    setCountyFips(nextCounties[0]?.fips ?? "");
                  }
                }}
                inputMode="numeric"
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              />
            </label>
            <label className="block text-sm">
              County
              <select
                value={countyFips}
                onChange={(event) => setCountyFips(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                {counties.map((county) => (
                  <option key={county.fips} value={county.fips}>
                    {county.name}
                  </option>
                ))}
              </select>
            </label>
            {zipCode === "91361" ? (
              <p className="text-xs text-[var(--warn)]">This ZIP spans Ventura and Los Angeles. Pick the county before comparing.</p>
            ) : null}
            <label className="block text-sm">
              Contract year
              <select
                value={contractYear}
                onChange={(event) => setContractYear(event.target.value as "2026" | "2027")}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                <option value="2026">2026</option>
                <option value="2027">2027</option>
              </select>
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Medications</legend>
            {medications.map((drug, index) => (
              <div key={drug.id} className="space-y-2 rounded-xl border border-[var(--line)] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-stone-500">Drug {index + 1}</p>
                  {medications.length > 1 ? (
                    <button
                      type="button"
                      className="text-xs text-stone-600 underline"
                      onClick={() => setMedications((current) => current.filter((item) => item.id !== drug.id))}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  aria-label={`Drug ${index + 1} name`}
                  placeholder="Name, such as Eliquis"
                  value={drug.name}
                  onChange={(event) => updateDrug(drug.id, { name: event.target.value })}
                  className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    aria-label={`Drug ${index + 1} strength`}
                    placeholder="Strength"
                    value={drug.strength}
                    onChange={(event) => updateDrug(drug.id, { strength: event.target.value })}
                    className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                  />
                  <select
                    aria-label={`Drug ${index + 1} form`}
                    value={drug.dosageForm}
                    onChange={(event) => updateDrug(drug.id, { dosageForm: event.target.value as DosageForm })}
                    className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                  >
                    {FORMS.map((form) => (
                      <option key={form.value} value={form.value}>
                        {form.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-stone-600">
                    Quantity per fill
                    <input
                      type="number"
                      min={1}
                      value={drug.quantityPerFill}
                      onChange={(event) => updateDrug(drug.id, { quantityPerFill: Number(event.target.value) })}
                      className="mt-1 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="text-xs text-stone-600">
                    Fill
                    <select
                      value={drug.refillFrequencyMonths}
                      onChange={(event) => updateDrug(drug.id, { refillFrequencyMonths: event.target.value as "1" | "3" })}
                      className="mt-1 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                    >
                      <option value="1">30-day</option>
                      <option value="3">90-day</option>
                    </select>
                  </label>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={drug.acceptGeneric}
                    onChange={(event) => updateDrug(drug.id, { acceptGeneric: event.target.checked })}
                  />
                  Accept a generic if one exists
                </label>
              </div>
            ))}
            <button
              type="button"
              className="text-sm font-medium text-[var(--accent)]"
              onClick={() => setMedications((current) => [...current, newDrug()])}
            >
              Add a drug
            </button>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Pharmacies</legend>
            <p className="text-xs text-stone-600">Up to five retail pharmacies, plus mail order. {retailCount} retail selected.</p>
            {PHARMACY_CATALOG.map((pharmacy) => (
              <label key={pharmacy.id} className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedPharmacyIds.includes(pharmacy.id)}
                  onChange={() => togglePharmacy(pharmacy)}
                />
                <span>
                  <span className="font-medium">{pharmacy.name}</span>
                  <span className="block text-xs text-stone-500">{pharmacy.address}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {error ? <p className="text-sm text-[var(--warn)]">{error}</p> : null}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {loading ? "Comparing…" : "Compare plans"}
          </button>
        </form>

        <section className="min-w-0 space-y-4">
          {plans.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--line)] bg-[var(--card)] p-8 text-sm text-stone-600">
              Run a comparison to see MAPD and PDP plans side by side. Pharmacy columns show preferred, standard, or
              out-of-network status and the estimated annual drug cost.
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {context?.countyName} County · {context?.zipCode}
                    </h2>
                    <p className="text-sm text-stone-600">
                      {filtered.length} of {plans.length} sample plans. Highlighted cell is the lowest in-network drug cost
                      in this filter.
                    </p>
                  </div>
                  <button type="button" onClick={exportCsv} className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-medium">
                    Export filtered CSV
                  </button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <label className="text-xs text-stone-600">
                    Plan type
                    <select value={planType} onChange={(event) => setPlanType(event.target.value as "ALL" | "MAPD" | "PDP")} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value="ALL">All plans</option>
                      <option value="MAPD">Medicare Advantage + drug</option>
                      <option value="PDP">Stand-alone Part D</option>
                    </select>
                  </label>
                  <label className="text-xs text-stone-600">
                    Carrier
                    <select value={carrier} onChange={(event) => setCarrier(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value="ALL">All carriers</option>
                      {carriers.map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-stone-600">
                    Minimum stars
                    <select value={minStars} onChange={(event) => setMinStars(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value={0}>Any</option>
                      <option value={3.5}>3.5</option>
                      <option value={4}>4.0</option>
                      <option value={4.5}>4.5</option>
                    </select>
                  </label>
                  <label className="text-xs text-stone-600">
                    Max monthly premium
                    <input value={maxPremium} onChange={(event) => setMaxPremium(event.target.value)} inputMode="decimal" placeholder="Any" className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm" />
                  </label>
                  <label className="text-xs text-stone-600">
                    Deductible
                    <select value={deductible} onChange={(event) => setDeductible(event.target.value as DeductibleFilter)} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value="any">Any</option>
                      <option value="zero">$0 only</option>
                    </select>
                  </label>
                  <label className="text-xs text-stone-600">
                    Network
                    <select value={network} onChange={(event) => setNetwork(event.target.value as NetworkFilter)} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value="any">Any network status</option>
                      <option value="preferred">Preferred at one pharmacy</option>
                      <option value="all-in-network">Every selected pharmacy in network</option>
                    </select>
                  </label>
                  <label className="text-xs text-stone-600">
                    Preferred pharmacy
                    <select value={preferredPharmacyId} onChange={(event) => setPreferredPharmacyId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      {plans[0]?.pharmacyQuotes.map((quote) => (
                        <option key={quote.pharmacyId} value={quote.pharmacyId}>
                          {quote.pharmacyName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-stone-600">
                    Sort and cost column
                    <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value="total">Lowest total annual cost</option>
                      <option value="drug">Lowest drug cost only</option>
                      <option value="premium">Lowest monthly premium</option>
                    </select>
                  </label>
                  <label className="text-xs text-stone-600">
                    Comparison pharmacy
                    <select value={comparePharmacyId} onChange={(event) => setComparePharmacyId(event.target.value)} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value="cheapest">Cheapest in-network</option>
                      {plans[0]?.pharmacyQuotes.map((quote) => (
                        <option key={quote.pharmacyId} value={quote.pharmacyId}>
                          {quote.pharmacyName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input type="checkbox" checked={coveredOnly} onChange={(event) => setCoveredOnly(event.target.checked)} />
                    Hide plans missing a drug
                  </label>
                </div>
              </div>

              <div className="overflow-x-auto rounded-2xl border border-[var(--line)] bg-[var(--card)]">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-stone-100 text-xs uppercase tracking-wide text-stone-600">
                    <tr>
                      <th className="px-3 py-3">Plan</th>
                      <th className="px-3 py-3">Premium</th>
                      <th className="px-3 py-3">Total</th>
                      {plans[0]?.pharmacyQuotes.map((quote) => (
                        <th key={quote.pharmacyId} className="px-3 py-3">
                          {quote.pharmacyName}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((plan) => {
                      const key = `${plan.contractId}-${plan.planId}`;
                      const headline = comparisonQuote(plan, comparePharmacyId);
                      const open = openPlan === key;
                      return (
                        <Fragment key={key}>
                          <tr className="border-t border-[var(--line)] align-top">
                            <td className="px-3 py-3">
                              <button type="button" className="text-left" onClick={() => setOpenPlan(open ? null : key)}>
                                <span className="font-medium">{plan.planName}</span>
                                <span className="mt-1 block text-xs text-stone-500">
                                  {plan.carrierName} · {plan.planType} · {plan.starRating} stars · deductible {money(plan.annualDrugDeductible)}
                                </span>
                                <span className="mt-1 block text-xs text-[var(--accent)]">{open ? "Hide drugs" : "Show drugs"}</span>
                              </button>
                            </td>
                            <td className="px-3 py-3">{money(plan.monthlyPremium)}</td>
                            <td className="px-3 py-3">
                              <span className="font-semibold">{money(headline.totalAnnualCost)}</span>
                              <span className="mt-1 block text-xs text-stone-500">at {headline.pharmacyName}</span>
                            </td>
                            {plan.pharmacyQuotes.map((quote) => {
                              const marked = cheapest?.planId === key && cheapest.pharmacyId === quote.pharmacyId;
                              return (
                                <td key={quote.pharmacyId} className={`px-3 py-3 ${marked ? "bg-[var(--accent-soft)]" : ""}`}>
                                  <span className="block text-xs font-medium">{networkLabel(quote.networkStatus)}</span>
                                  <span className="font-medium">{money(quote.annualDrugCostOop)}</span>
                                  {quote.hitsCatastrophicCap ? (
                                    <span className="mt-1 block text-xs text-stone-500">Hits the annual cap</span>
                                  ) : null}
                                </td>
                              );
                            })}
                          </tr>
                          {open ? (
                            <tr className="border-t border-[var(--line)] bg-stone-50">
                              <td colSpan={3 + plan.pharmacyQuotes.length} className="px-3 py-3">
                                <DrugDetail quote={headline} />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                    {filtered.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-stone-600">
                          No plans match these filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function DrugDetail({ quote }: { quote: PharmacyPlanQuote }) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-stone-500">Drug detail at {quote.pharmacyName}</p>
      <div className="grid gap-2 md:grid-cols-2">
        {quote.drugBreakdowns.map((drug) => (
          <article key={drug.drugId} className="rounded-xl border border-[var(--line)] bg-white p-3">
            <h3 className="font-medium">{drug.drugName}</h3>
            <p className="mt-1 text-xs text-stone-600">
              {drug.coveredOnFormulary ? `Tier ${drug.tier}` : "Not covered on this formulary"}
              {drug.usedGeneric ? " · priced as generic" : ""}
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-1 text-xs">
              <div>Monthly negotiated</div>
              <div>{money(drug.negotiatedRetailMonthlyCost)}</div>
              <div>Est. monthly share</div>
              <div>{money(drug.initialCoverageMonthlyCopay)}</div>
              <div>Annual for this drug</div>
              <div>{money(drug.annualOutOfPocketForDrug)}</div>
            </dl>
            <p className="mt-2 text-xs text-stone-600">
              {[
                drug.priorAuth ? "Prior authorization" : null,
                drug.stepTherapy ? "Step therapy" : null,
                drug.quantityLimit ? `Quantity limit ${drug.quantityLimit}` : null,
                drug.deductibleApplies ? "Deductible applies" : "Deductible does not apply",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
