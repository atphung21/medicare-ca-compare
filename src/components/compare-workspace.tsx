"use client";

import { ChatDrugIntake } from "@/components/chat-drug-intake";
import { drugsVerified, formularyFormTip, isCostCulprit, splitPharmacyTip } from "@/lib/insights";
import {
  countiesForZip,
  PHARMACY_CATALOG,
  type CompareRequest,
  type DosageForm,
  type DrugInput,
  type DrugPlanBreakdown,
  type LisLevel,
  type PlanCategory,
  type MedicarePlanComparison,
  type PharmacyInput,
  type PharmacyPlanQuote,
  type ResolvedVariant,
} from "@/schemas/medicare";
import { partDCap } from "@/services/lis";
import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";

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
    resolutionStatus: "UNRESOLVED",
  };
}

interface ResolutionPayload {
  status: "AUTO_LOCKED" | "AMBIGUOUS_FORM" | "NOT_FOUND";
  selectedVariant: ResolvedVariant | null;
  availableFormsForStrength: ResolvedVariant[];
}

interface LisPayload {
  label: string;
  genericCopay: number;
  brandCopay: number;
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
  const [lisLevel, setLisLevel] = useState<LisLevel>("NONE");
  const [showMppp, setShowMppp] = useState(false);
  const [medications, setMedications] = useState<DrugInput[]>([
    {
      id: "atorvastatin",
      name: "Atorvastatin",
      strength: "20mg",
      dosageForm: "TABLET",
      quantityPerFill: 30,
      refillFrequencyMonths: "1",
      acceptGeneric: true,
      resolutionStatus: "UNRESOLVED",
    },
    {
      id: "eliquis",
      name: "Eliquis",
      strength: "5mg",
      dosageForm: "TABLET",
      quantityPerFill: 60,
      refillFrequencyMonths: "1",
      acceptGeneric: false,
      resolutionStatus: "UNRESOLVED",
    },
  ]);
  const [formOptions, setFormOptions] = useState<Record<string, ResolvedVariant[]>>({});
  const [selectedPharmacyIds, setSelectedPharmacyIds] = useState<string[]>([
    "cvs-bristol",
    "walgreens-17th",
    "mail-order",
  ]);
  const [plans, setPlans] = useState<MedicarePlanComparison[]>([]);
  const [context, setContext] = useState<{ zipCode: string; countyName: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [planType, setPlanType] = useState<PlanCategory>("ALL");
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
  const [lisNote, setLisNote] = useState<LisPayload | null>(null);
  const [quotedMeds, setQuotedMeds] = useState<DrugInput[]>([]);
  const [visionMessage, setVisionMessage] = useState("Checking pill-bottle intake…");
  const [extracting, setExtracting] = useState(false);
  const [proofId, setProofId] = useState<string | null>(null);
  const [proofUrl, setProofUrl] = useState("");
  const [proofError, setProofError] = useState("");
  const [proofLoading, setProofLoading] = useState(false);
  const [proofImage, setProofImage] = useState<string | null>(null);
  const [proofPdf, setProofPdf] = useState(false);
  const [alternatives, setAlternatives] = useState<Record<string, { name: string; rxcui: string; className: string }[]>>({});

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

  function applyResolution(id: string, resolution: ResolutionPayload) {
    const forms = resolution.availableFormsForStrength;
    setFormOptions((current) => ({ ...current, [id]: forms }));
    const locked = resolution.status === "AUTO_LOCKED" ? resolution.selectedVariant : null;
    updateDrug(id, locked
      ? {
          resolutionStatus: resolution.status,
          rxcui: locked.rxcui,
          resolvedName: locked.fullName,
          dosageForm: locked.coarseForm,
          dosageFormLabel: locked.dosageForm,
          isBrand: locked.isBrand,
          compareBothForms: false,
          alternate: undefined,
        }
      : {
          resolutionStatus: resolution.status,
          rxcui: undefined,
          resolvedName: undefined,
          compareBothForms: false,
          alternate: undefined,
        });
  }

  async function resolveDrug(drug: DrugInput) {
    const query = [drug.ndc, drug.name, drug.strength].filter(Boolean).join(" ");
    if (query.trim().length < 2) return;
    const response = await fetch("/api/medicare/resolve-drug", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? "Could not resolve that drug.");
      return;
    }
    applyResolution(drug.id, data);
  }

  function selectVariant(drug: DrugInput, variant: ResolvedVariant) {
    const others = (formOptions[drug.id] ?? []).filter((item) => item.dosageForm !== variant.dosageForm);
    updateDrug(drug.id, {
      rxcui: variant.rxcui,
      resolvedName: variant.fullName,
      dosageForm: variant.coarseForm,
      dosageFormLabel: variant.dosageForm,
      isBrand: variant.isBrand,
      resolutionStatus: "AMBIGUOUS_FORM",
      strength: drug.strength || variant.strength,
      alternate: drug.compareBothForms ? others[0] : undefined,
    });
  }

  useEffect(() => {
    fetch("/api/medicare/extract-meds")
      .then((response) => response.json())
      .then((data) => setVisionMessage(data.message ?? "Drop a pill-bottle photo or medication PDF."))
      .catch(() => setVisionMessage("Pill-bottle intake is unavailable. The manual drug form still works."));
  }, []);

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
    const unresolved = medications.find((drug) => drug.resolutionStatus === "UNRESOLVED" || !drug.resolutionStatus);
    if (unresolved) {
      setError(`Resolve ${unresolved.name || "each drug"} before comparing so the dosage form is not guessed.`);
      return;
    }
    const ambiguous = medications.find(
      (drug) => drug.resolutionStatus === "AMBIGUOUS_FORM" && !drug.rxcui && !drug.compareBothForms,
    );
    if (ambiguous) {
      setError(`${ambiguous.name} has more than one dosage form. Pick one, or turn on Test both forms.`);
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
      lisLevel,
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
      setQuotedMeds(medications);
      setLisNote(data.lis ?? null);
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

  async function onExtract(file: File) {
    setExtracting(true);
    setError("");
    const body = new FormData();
    body.set("file", file);
    try {
      const response = await fetch("/api/medicare/extract-meds", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not read that file.");
        return;
      }
      const imported: DrugInput[] = data.medications.map((item: {
        name: string;
        strength: string;
        dosageForm: DosageForm;
        dosageFormLabel?: string;
        quantityPerFill: number;
        refillFrequencyMonths: "1" | "3";
        resolution: ResolutionPayload;
      }) => {
        const variant = item.resolution.status === "AUTO_LOCKED" ? item.resolution.selectedVariant : null;
        const id = crypto.randomUUID();
        setFormOptions((current) => ({ ...current, [id]: item.resolution.availableFormsForStrength }));
        return {
          id,
          name: item.name,
          strength: item.strength,
          dosageForm: variant?.coarseForm ?? item.dosageForm,
          dosageFormLabel: variant?.dosageForm ?? item.dosageFormLabel,
          quantityPerFill: item.quantityPerFill,
          refillFrequencyMonths: item.refillFrequencyMonths,
          acceptGeneric: variant ? !variant.isBrand : true,
          rxcui: variant?.rxcui,
          resolvedName: variant?.fullName,
          isBrand: variant?.isBrand,
          resolutionStatus: item.resolution.status,
        } satisfies DrugInput;
      });
      setMedications((current) => [...current.filter((drug) => drug.name.trim()), ...imported]);
    } catch {
      setError("Could not read that file. The manual drug form still works.");
    } finally {
      setExtracting(false);
    }
  }

  async function captureProof(plan?: MedicarePlanComparison) {
    setProofLoading(true);
    setProofError("");
    const county = counties.find((item) => item.fips === countyFips) ?? counties[0];
    if (!county) return;
    try {
      const response = await fetch("/api/medicare/proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zipCode,
          countyFips: county.fips,
          countyName: county.name,
          contractYear,
          lisLevel,
          medications: quotedMeds.length ? quotedMeds : medications,
          pharmacies: selectedPharmacies,
          proofId: proofId ?? undefined,
          contractId: plan?.contractId,
          planId: plan?.planId,
          planTypeFilter: plan?.planType ?? planType,
        }),
      });
      const data = await response.json();
      if (!data.ok) {
        setProofId(data.proofId ?? proofId);
        setProofError(data.error ?? "Medicare.gov proof is unavailable.");
        setProofUrl(data.medicareGovUrl ?? "https://www.medicare.gov/plan-compare/");
        setProofPdf(false);
        setProofImage(data.proofId && data.imageFile ? `/api/medicare/proof/${data.proofId}/${data.imageFile}` : null);
        return;
      }
      setProofId(data.proofId);
      setProofUrl(data.medicareGovUrl);
      setProofPdf(Boolean(data.pdf));
      setProofImage(`/api/medicare/proof/${data.proofId}/${data.imageFile}`);
    } catch {
      setProofError("Medicare.gov proof could not be captured. The sample comparison is still available.");
    } finally {
      setProofLoading(false);
    }
  }

  async function loadAlternatives(drug: DrugPlanBreakdown) {
    if (!drug.rxcui) return;
    const response = await fetch("/api/medicare/alternatives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rxcui: drug.rxcui }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? "Could not load alternatives.");
      return;
    }
    setAlternatives((current) => ({ ...current, [drug.rxcui ?? drug.drugId]: data.alternatives ?? [] }));
  }

  function priceAlternative(name: string) {
    const drug = newDrug();
    drug.name = name;
    drug.strength = "see label";
    setMedications((current) => [...current, drug]);
    setError(`Added ${name}. Enter the strength, resolve the form, and compare again so the tier comes from a quote.`);
  }

  const splitTip = filtered.map((plan) => splitPharmacyTip(plan)).find(Boolean) ?? null;
  const formTips = filtered.flatMap((plan) => formularyFormTip(plan, comparisonQuote(plan, comparePharmacyId)));

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6">
      <header className="mb-6 max-w-3xl">
        <p className="text-sm font-medium tracking-wide text-[var(--accent)]">Licensed agent planning tool</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">California Medicare drug comparison</h1>
        <p className="mt-3 text-sm leading-6 text-stone-700">
          These figures are sample planning estimates, not a beneficiary quote. Confirm the final one or two plans in
          Medicare.gov or the agency quoting tool. Annual out-of-pocket drug costs in this sample stop at the{" "}
          {money(partDCap(contractYear))} Part D cap for {contractYear}.
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
            <label className="block text-sm">
              Extra Help
              <select
                value={lisLevel}
                onChange={(event) => setLisLevel(event.target.value as LisLevel)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                <option value="NONE">No Extra Help</option>
                <option value="FULL">Full Medi-Cal / full LIS</option>
                <option value="PARTIAL">Partial LIS</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={showMppp} onChange={(event) => setShowMppp(event.target.checked)} />
              Show MPPP monthly smoothed payment
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold">Medications</legend>
            <ChatDrugIntake
              onAdd={(rows) => {
                setMedications((current) => [...current.filter((drug) => drug.name.trim()), ...rows]);
                setError("");
              }}
            />
            <label className="block rounded-xl border border-dashed border-[var(--line)] p-3 text-xs text-stone-600">
              Pill bottle or medication list
              <input
                type="file"
                accept="image/*,application/pdf"
                className="mt-2 block w-full text-xs"
                disabled={extracting}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onExtract(file);
                  event.target.value = "";
                }}
              />
              <span className="mt-2 block">{extracting ? "Reading the file…" : visionMessage}</span>
            </label>
            {medications.some((drug) => drug.name.trim()) ? (
              <button
                type="button"
                className="text-sm text-stone-600 underline"
                onClick={() => {
                  setMedications([newDrug()]);
                  setFormOptions({});
                  setError("");
                }}
              >
                Remove all drugs
              </button>
            ) : null}
            {medications.map((drug, index) => (
              <div key={drug.id} className="space-y-2 rounded-xl border border-[var(--line)] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-stone-500">Drug {index + 1}</p>
                  <span className="flex gap-3">
                    <button type="button" className="text-xs text-[var(--accent)] underline" onClick={() => void resolveDrug(drug)}>
                      Resolve form
                    </button>
                    {medications.length > 1 ? (
                      <button
                        type="button"
                        className="text-xs text-stone-600 underline"
                        onClick={() => setMedications((current) => current.filter((item) => item.id !== drug.id))}
                      >
                        Remove
                      </button>
                    ) : null}
                  </span>
                </div>
                <input
                  aria-label={`Drug ${index + 1} name`}
                  placeholder="Name, such as Eliquis"
                  value={drug.name}
                  onChange={(event) =>
                    updateDrug(drug.id, {
                      name: event.target.value,
                      resolutionStatus: "UNRESOLVED",
                      rxcui: undefined,
                      resolvedName: undefined,
                    })
                  }
                  onBlur={() => void resolveDrug(drug)}
                  className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    aria-label={`Drug ${index + 1} strength`}
                    placeholder="Strength"
                    value={drug.strength}
                    onChange={(event) =>
                      updateDrug(drug.id, { strength: event.target.value, resolutionStatus: "UNRESOLVED", rxcui: undefined })
                    }
                    onBlur={() => void resolveDrug({ ...drug, strength: drug.strength })}
                    className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                  />
                  {(formOptions[drug.id]?.length ?? 0) > 1 ? (
                    <p className="self-center text-xs text-stone-500">Pick a real form below</p>
                  ) : (
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
                  )}
                </div>
                <FormResolution
                  drug={drug}
                  options={formOptions[drug.id] ?? []}
                  onSelect={(variant) => selectVariant(drug, variant)}
                  onCompareBoth={(checked) => {
                    const forms = formOptions[drug.id] ?? [];
                    const primary = forms.find((item) => item.rxcui === drug.rxcui) ?? forms[0];
                    const alternate = forms.find((item) => item.dosageForm !== primary?.dosageForm);
                    updateDrug(drug.id, {
                      compareBothForms: checked,
                      rxcui: primary?.rxcui ?? drug.rxcui,
                      resolvedName: primary?.fullName ?? drug.resolvedName,
                      dosageForm: primary?.coarseForm ?? drug.dosageForm,
                      dosageFormLabel: primary?.dosageForm ?? drug.dosageFormLabel,
                      isBrand: primary?.isBrand ?? drug.isBrand,
                      alternate: checked ? alternate : undefined,
                    });
                  }}
                />
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
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void captureProof()} disabled={proofLoading} className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-medium">
                      {proofLoading ? "Opening Medicare.gov…" : "Capture Medicare.gov proof"}
                    </button>
                    <button type="button" onClick={exportCsv} className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-medium">
                      Export filtered CSV
                    </button>
                  </div>
                </div>
                <AuditBanner medications={quotedMeds} verified={filtered[0] ? drugsVerified(quotedMeds, comparisonQuote(filtered[0], comparePharmacyId)) : false} />
                {lisNote ? <p className="mt-3 text-xs leading-5 text-stone-700">{lisNote.label}</p> : null}
                {showMppp ? (
                  <p className="mt-2 text-xs leading-5 text-stone-700">
                    The monthly figure is an even split of this sample&apos;s annual drug cost. It is a planning estimate of the
                    Medicare Prescription Payment Plan, not the CMS invoice. The January-style amount is the first fill before smoothing.
                  </p>
                ) : null}
                {splitTip ? <p className="mt-3 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-sm">{splitTip}</p> : null}
                {formTips.map((tip) => (
                  <p key={tip} className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
                    {tip}
                  </p>
                ))}
                {proofError ? <p className="mt-3 text-sm text-[var(--warn)]">{proofError}</p> : null}
                {proofUrl ? (
                  <a className="mt-2 inline-block text-sm text-[var(--accent)] underline" href={proofUrl} target="_blank" rel="noreferrer">
                    Open this Medicare.gov page
                  </a>
                ) : null}
                {proofPdf && proofId ? (
                  <a className="ml-4 mt-2 inline-block text-sm text-[var(--accent)] underline" href={`/api/medicare/proof/${proofId}/page.pdf`} target="_blank" rel="noreferrer">
                    Download PDF
                  </a>
                ) : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <label className="text-xs text-stone-600">
                    Plan type
                    <select value={planType} onChange={(event) => setPlanType(event.target.value as PlanCategory)} className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-2 py-2 text-sm">
                      <option value="ALL">All plans</option>
                      <option value="MAPD">Medicare Advantage + drug</option>
                      <option value="PDP">Stand-alone Part D</option>
                      <option value="MEDIGAP">Medigap</option>
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
                              {showMppp ? (
                                <span className="mt-1 block text-xs text-stone-600">
                                  January-style {money(headline.januaryDrugCost)} · about {money(headline.mpppMonthlyEstimate)}/month smoothed
                                </span>
                              ) : null}
                              {plan.premiumNote ? <span className="mt-1 block text-xs text-stone-500">{plan.premiumNote}</span> : null}
                              <button type="button" className="mt-2 text-xs font-medium text-[var(--accent)] underline" onClick={() => void captureProof(plan)}>
                                View Medicare.gov proof
                              </button>
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
                                <DrugDetail
                                  quote={headline}
                                  alternatives={alternatives}
                                  onAlternatives={(drug) => void loadAlternatives(drug)}
                                  onPrice={(name) => priceAlternative(name)}
                                />
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
      {proofImage ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-stone-900/50 p-4" role="dialog" aria-label="Medicare.gov proof">
          <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Medicare.gov proof</h2>
              <button type="button" className="text-sm underline" onClick={() => setProofImage(null)}>
                Close
              </button>
            </div>
            <p className="mb-3 text-xs text-stone-600">This image is the public page the browser reached. It is not a beneficiary quote.</p>
            {proofError ? <p className="mb-3 text-sm text-[var(--warn)]">{proofError}</p> : null}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={proofImage} alt="Medicare.gov page captured for this lookup" className="w-full rounded-lg border border-[var(--line)]" />
          </div>
        </div>
      ) : null}
    </main>
  );
}

function FormResolution({
  drug,
  options,
  onSelect,
  onCompareBoth,
}: {
  drug: DrugInput;
  options: ResolvedVariant[];
  onSelect: (variant: ResolvedVariant) => void;
  onCompareBoth: (checked: boolean) => void;
}) {
  if (drug.resolutionStatus === "AUTO_LOCKED" && drug.rxcui) {
    return (
      <p className="text-xs text-emerald-800">
        Locked form: {drug.dosageFormLabel} (RxCUI {drug.rxcui}){drug.isBrand ? " · brand" : " · generic"}
      </p>
    );
  }
  if (drug.resolutionStatus === "NOT_FOUND") {
    return <p className="text-xs text-[var(--warn)]">RxNorm did not find this name and strength. Pick the form manually before comparing.</p>;
  }
  if (options.length < 2) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-amber-800">Select form. More than one FDA form matches this strength.</p>
      <div className="flex flex-wrap gap-1">
        {options.map((variant) => (
          <button
            key={variant.rxcui}
            type="button"
            onClick={() => onSelect(variant)}
            className={`rounded-full border px-2 py-1 text-xs ${drug.rxcui === variant.rxcui ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)]"}`}
          >
            {variant.dosageForm} · RxCUI {variant.rxcui}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={Boolean(drug.compareBothForms)} onChange={(event) => onCompareBoth(event.target.checked)} />
        Test both forms
      </label>
    </div>
  );
}

function AuditBanner({ medications, verified }: { medications: DrugInput[]; verified: boolean }) {
  if (medications.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl border border-[var(--line)] p-3">
      <p className={`text-xs font-semibold ${verified ? "text-emerald-800" : "text-amber-800"}`}>
        {verified ? "Verified match" : "Dosage review needed"}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-stone-700">
        {medications.map((drug) => (
          <li key={drug.id}>
            Typed {drug.name} {drug.strength} {drug.dosageFormLabel || drug.dosageForm}
            {drug.resolvedName ? ` · Resolved as ${drug.resolvedName}` : " · not resolved to an RxCUI"}
            {drug.rxcui ? ` · RxCUI ${drug.rxcui}` : ""}
            {drug.isBrand ? " · brand only" : drug.resolutionStatus === "AUTO_LOCKED" ? " · generic" : ""}
            {drug.compareBothForms && drug.alternate ? ` · also quoting ${drug.alternate.fullName}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DrugDetail({
  quote,
  alternatives,
  onAlternatives,
  onPrice,
}: {
  quote: PharmacyPlanQuote;
  alternatives: Record<string, { name: string; rxcui: string; className: string }[]>;
  onAlternatives: (drug: DrugPlanBreakdown) => void;
  onPrice: (name: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-stone-500">Drug detail at {quote.pharmacyName}</p>
      <div className="grid gap-2 md:grid-cols-2">
        {quote.drugBreakdowns.map((drug) => {
          const culprit = isCostCulprit(drug.annualOutOfPocketForDrug, quote.annualDrugCostOop, drug.coveredOnFormulary);
          const options = drug.rxcui ? alternatives[drug.rxcui] : undefined;
          return (
          <article key={drug.drugId} className={`rounded-xl border bg-white p-3 ${culprit ? "border-red-400" : "border-[var(--line)]"}`}>
            <h3 className="font-medium">{drug.drugName}</h3>
            {culprit ? (
              <p className="mt-1 text-xs font-medium text-red-700">
                {drug.coveredOnFormulary ? "This drug is more than half of the annual drug cost." : "Not covered on this formulary."}
              </p>
            ) : null}
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
            {drug.rxcui ? (
              <button type="button" className="mt-2 text-xs text-[var(--accent)] underline" onClick={() => onAlternatives(drug)}>
                Show same-class alternatives
              </button>
            ) : null}
            {options && options.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs">
                {options.map((item) => (
                  <li key={item.rxcui}>
                    {item.name} · {item.className}{" "}
                    <button type="button" className="text-[var(--accent)] underline" onClick={() => onPrice(item.name)}>
                      Price this alternative
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
          );
        })}
      </div>
    </div>
  );
}
