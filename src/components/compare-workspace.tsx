"use client";

import {
  ChatDrugIntake,
  type CheckedMedication,
  type DrugReviewNote,
} from "@/components/chat-drug-intake";
import {
  drugsVerified,
  formularyFormTip,
  splitPharmacyTip,
} from "@/lib/insights";
import { cardsFromDraft } from "@/lib/draft-cards";
import type { ZipLocation } from "@/lib/us-location";
import {
  defaultPharmacyIds,
  pharmaciesForState,
  type CompareRequest,
  type DosageForm,
  type DrugInput,
  type LisLevel,
  type MedicarePlanComparison,
  type PharmacyInput,
  type PharmacyPlanQuote,
  type PlanCategory,
  type ResolvedVariant,
} from "@/schemas/medicare";
import type { SpellingSuggestion } from "@/services/drug-spellcheck";
import type { MedicationDraft } from "@/services/med-list-parser";
import { partDCap } from "@/services/lis";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

const FORMS: { value: DosageForm; label: string }[] = [
  { value: "TABLET", label: "Tablet" },
  { value: "CAPSULE", label: "Capsule" },
  { value: "INJECTABLE_PEN", label: "Injectable pen" },
  { value: "VIAL", label: "Vial" },
  { value: "INHALER", label: "Inhaler" },
  { value: "CREAM", label: "Cream" },
  { value: "DROPS", label: "Drops" },
  { value: "SUPPLY", label: "Diabetic supply" },
];

function medicationNeedsUpdate(drug: DrugInput) {
  if (drug.name.trim().length < 2) return true;
  if (!drug.isSupply && !drug.isOtc && !drug.strength.trim()) return true;
  if (
    !drug.isOtc &&
    (drug.resolutionStatus === "UNRESOLVED" || !drug.resolutionStatus)
  ) {
    return true;
  }
  return (
    drug.resolutionStatus === "AMBIGUOUS_FORM" &&
    !drug.rxcui &&
    !drug.compareBothForms
  );
}

function repeatedDrugs(medications: DrugInput[]) {
  const groups = new Map<string, DrugInput[]>();
  for (const drug of medications) {
    const name = drug.name.trim().replace(/\s+/g, " ");
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(drug);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const name = group[0].name.trim().replace(/\s+/g, " ");
      const strengths = [
        ...new Set(group.map((drug) => drug.strength.trim()).filter(Boolean)),
      ];
      const sameStrength = strengths.length <= 1;
      return {
        ids: group.map((drug) => drug.id),
        count: group.length,
        label: sameStrength && strengths[0] ? `${name} ${strengths[0]}` : name,
        detail: sameStrength ? "" : ` (${strengths.join(" and ")})`,
      };
    });
}

function DrugCheckSummary({
  count,
  repeats,
}: {
  count: number;
  repeats: ReturnType<typeof repeatedDrugs>;
}) {
  if (count === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-center text-sm text-stone-600">
        {count} {count === 1 ? "drug" : "drugs"}
      </p>
      {repeats.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-left text-sm text-amber-950">
          <p className="font-medium">Listed more than once</p>
          <ul className="mt-1 space-y-1">
            {repeats.map((repeat) => (
              <li key={repeat.label}>
                {repeat.label} is listed {repeat.count} times
                {repeat.detail}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function money(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function blankNote(name: string): DrugReviewNote {
  return {
    rawLine: name,
    originalTypedName: name,
    wasSpellCorrected: false,
    confidenceScore: 1,
    spellingSuggestions: [],
    strengthChoices: [],
  };
}

function sameStrength(left: string, right: string) {
  return (
    left.toLowerCase().replace(/\s+/g, "") ===
    right.toLowerCase().replace(/\s+/g, "")
  );
}

function timesPerDay(drug: DrugInput) {
  const days = drug.refillFrequencyMonths === "3" ? 90 : 30;
  return Math.max(1, Math.round(drug.quantityPerFill / days));
}

function quantityUnit(drug: DrugInput) {
  if (drug.dosageForm === "DROPS" || drug.dosageForm === "VIAL") return "mL";
  if (/insulin/i.test(`${drug.name} ${drug.resolvedName ?? ""}`)) return "mL";
  if (/solution|suspension|syrup|elixir/i.test(drug.dosageFormLabel ?? "")) return "mL";
  if (drug.dosageForm === "SUPPLY") return "each";
  if (drug.dosageForm === "TABLET" || drug.dosageForm === "CAPSULE") return "";
  return drug.quantityPerFill === 1 ? "package" : "packages";
}

function quantityLabel(drug: DrugInput) {
  const days = drug.refillFrequencyMonths === "3" ? 90 : 30;
  const perDay = drug.quantityPerFill / days;
  const unit = quantityUnit(drug);
  if (!unit && [1, 2, 3].includes(perDay))
    return `${perDay} ${perDay === 1 ? "time" : "times"} a day`;
  return `${drug.quantityPerFill}${unit ? ` ${unit}` : ""} per ${days}-day fill`;
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

function inNetwork(quote: PharmacyPlanQuote) {
  return quote.networkStatus !== "OUT_OF_NETWORK";
}

function comparisonQuote(plan: MedicarePlanComparison) {
  const eligible = plan.pharmacyQuotes.filter(inNetwork);
  const pool = eligible.length ? eligible : plan.pharmacyQuotes;
  return pool.reduce((best, quote) =>
    quote.totalAnnualCost < best.totalAnnualCost ? quote : best,
  );
}

async function lookupLocation(zipCode: string, signal: AbortSignal) {
  const response = await fetch(`/api/location?zip=${zipCode}`, { signal });
  const body = (await response.json()) as ZipLocation & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "That ZIP code was not found.");
  return body;
}

type ProofResult = {
  id: string | null;
  url: string;
  error: string;
  pdf: boolean;
  images: { label: string; src: string }[];
  skipped: string[];
  /** Drugs Medicare.gov's search could not add automatically. */
  missing: { name: string; strength: string; reason: string; src: string }[];
  /** The visible Medicare.gov window is waiting on the drug list for the user. */
  paused: boolean;
};

type ProofResponse = {
  ok?: boolean;
  proofId?: string;
  medicareGovUrl?: string;
  error?: string;
  pdf?: boolean;
  imageFile?: string;
  images?: { label: string; file: string }[];
  skipped?: string[];
  missing?: { name: string; strength?: string; reason?: string; image?: string }[];
  paused?: boolean;
};

function readProof(data: ProofResponse): ProofResult {
  // drugs.png is taken again after a pause, so each response gets fresh image URLs.
  const version = Date.now();
  const id = data.proofId ?? null;
  const missing = (Array.isArray(data.missing) ? data.missing : []).map((drug) => ({
    name: drug.name,
    strength: drug.strength ?? "",
    reason: drug.reason ?? "",
    src: id && drug.image ? `/api/medicare/proof/${id}/${drug.image}?v=${version}` : "",
  }));
  return {
    id,
    url: data.medicareGovUrl ?? "https://www.medicare.gov/plan-compare/",
    error: data.ok ? "" : (data.error ?? "Medicare.gov proof is unavailable."),
    pdf: Boolean(data.ok && data.pdf),
    images: [
      ...proofShots(data).map((image) => ({ ...image, src: `${image.src}?v=${version}` })),
      ...missing
        .filter((drug) => drug.src)
        .map((drug) => ({ label: `Not found: ${drug.name}`, src: drug.src })),
    ],
    skipped: Array.isArray(data.skipped) ? data.skipped : [],
    missing,
    paused: Boolean(data.paused),
  };
}

/** A drug card written back as text the medication reader understands, such as "Furosemide 40 mg Oral Tablet". */
function readingFor(drug: DrugInput) {
  return [drug.name, drug.strength, drug.isSupply ? "" : drug.dosageFormLabel]
    .map((part) => (part ?? "").replace(/[;()]/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

function providerNames(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
    .map((name) => ({ name }));
}

function skippedNote(names: string[]) {
  if (names.length === 0) return "";
  return `${names.join(", ")} ${names.length === 1 ? "isn't" : "aren't"} on Medicare.gov's drug list, so the proof leaves ${names.length === 1 ? "it" : "them"} out. Test strips and other diabetic supplies are usually covered under Part B; vitamins and other over-the-counter items usually aren't covered by Part D.`;
}

function proofShots(data: {
  proofId?: string;
  imageFile?: string;
  images?: { label: string; file: string }[];
}) {
  if (!data.proofId) return [];
  const listed = Array.isArray(data.images) ? data.images : [];
  if (listed.length > 0) {
    return listed.map((image) => ({
      label: image.label,
      src: `/api/medicare/proof/${data.proofId}/${image.file}`,
    }));
  }
  return data.imageFile
    ? [
        {
          label: "Medicare.gov Proof",
          src: `/api/medicare/proof/${data.proofId}/${data.imageFile}`,
        },
      ]
    : [];
}

export function CompareWorkspace() {
  const [zipCode, setZipCode] = useState("92704");
  const [countyFips, setCountyFips] = useState("06059");
  const [contractYear, setContractYear] = useState<"2026" | "2027">("2027");
  const [lisLevel, setLisLevel] = useState<LisLevel>("LIS_NONE");
  const [showMppp, setShowMppp] = useState(false);
  const [medications, setMedications] = useState<DrugInput[]>([]);
  const [formOptions, setFormOptions] = useState<
    Record<string, ResolvedVariant[]>
  >({});
  const [catalogPharmacies, setCatalogPharmacies] = useState<PharmacyInput[]>(() =>
    pharmaciesForState("CA"),
  );
  const pharmacyState = useRef("CA");
  const [selectedPharmacyIds, setSelectedPharmacyIds] = useState<string[]>(() =>
    defaultPharmacyIds("CA"),
  );
  const [customPharmacies, setCustomPharmacies] = useState<PharmacyInput[]>([]);
  const [customPharmacyName, setCustomPharmacyName] = useState("");
  const [providerText, setProviderText] = useState("");
  const [providersOpen, setProvidersOpen] = useState(false);
  const [plans, setPlans] = useState<MedicarePlanComparison[]>([]);
  const [context, setContext] = useState<{
    zipCode: string;
    countyName: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [planType, setPlanType] = useState<PlanCategory>("ALL");
  const [lisNote, setLisNote] = useState<LisPayload | null>(null);
  const [quotedMeds, setQuotedMeds] = useState<DrugInput[]>([]);
  const [visionMessage, setVisionMessage] = useState(
    "Checking pill-bottle intake…",
  );
  const [extracting, setExtracting] = useState(false);
  const [proofs, setProofs] = useState<Record<string, ProofResult>>({});
  const [proofLoading, setProofLoading] = useState(false);
  const [openProofKey, setOpenProofKey] = useState<string | null>(null);
  const [location, setLocation] = useState<ZipLocation | null>(null);
  const [locationError, setLocationError] = useState("");
  const [formVersion, setFormVersion] = useState(0);
  const [drugNotes, setDrugNotes] = useState<Record<string, DrugReviewNote>>(
    {},
  );
  const [fixing, setFixing] = useState<{ id: string; reading: string } | null>(
    null,
  );
  const [learning, setLearning] = useState(false);
  const [learnMessage, setLearnMessage] = useState("");
  const [duplicate, setDuplicate] = useState<{
    rawLine: string;
    removed: string;
    kept: string[];
    reading: string;
  } | null>(null);

  const counties = location?.zipCode === zipCode ? location.counties : [];
  const countyChoices = counties;
  const pharmacyChoices = [...catalogPharmacies, ...customPharmacies];
  const selectedPharmacies = pharmacyChoices.filter((pharmacy) =>
    selectedPharmacyIds.includes(pharmacy.id),
  );
  const proofKey = JSON.stringify([
    zipCode,
    countyFips,
    contractYear,
    lisLevel,
    planType,
    medications,
    selectedPharmacyIds,
    providerText,
  ]);
  const proof = proofs[proofKey];
  const openProof = openProofKey === proofKey ? proof : undefined;
  const retailCount = selectedPharmacies.filter(
    (pharmacy) => !pharmacy.isMailOrder,
  ).length;
  const filtered = useMemo(() => {
    const rows = plans.filter(
      (plan) => planType === "ALL" || plan.planType === planType,
    );
    rows.sort(
      (a, b) =>
        comparisonQuote(a).totalAnnualCost - comparisonQuote(b).totalAnnualCost,
    );
    return rows;
  }, [plans, planType]);

  useEffect(() => {
    if (!/^\d{5}$/.test(zipCode)) return;
    const controller = new AbortController();
    void lookupLocation(zipCode, controller.signal)
      .then((found) => {
        setLocation(found);
        setLocationError("");
        setCountyFips((current) =>
          found.counties.some((county) => county.fips === current)
            ? current
            : (found.counties[0]?.fips ?? ""),
        );
        if (found.state === pharmacyState.current) return;
        pharmacyState.current = found.state;
        const defaults = defaultPharmacyIds(found.state);
        setCatalogPharmacies(pharmaciesForState(found.state));
        setSelectedPharmacyIds((current) => {
          const customSelected = current.filter((id) => id.startsWith("custom-"));
          return [...defaults.filter((id) => id !== "mail-order"), ...customSelected, "mail-order"];
        });
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setLocation(null);
        setLocationError(
          error instanceof Error ? error.message : "That ZIP code was not found.",
        );
      });
    return () => controller.abort();
  }, [zipCode]);

  function resetPage() {
    setZipCode("");
    setCountyFips("");
    setLocation(null);
    setLocationError("");
    setContractYear("2027");
    setLisLevel("LIS_NONE");
    setShowMppp(false);
    setMedications([]);
    setDrugNotes({});
    setFormOptions({});
    pharmacyState.current = "";
    setCatalogPharmacies(pharmaciesForState(""));
    setSelectedPharmacyIds(defaultPharmacyIds(""));
    setCustomPharmacies([]);
    setCustomPharmacyName("");
    setProviderText("");
    setPlans([]);
    setContext(null);
    setError("");
    setLoading(false);
    setPlanType("ALL");
    setLisNote(null);
    setQuotedMeds([]);
    setProofs({});
    setProofLoading(false);
    setOpenProofKey(null);
    setFormVersion((version) => version + 1);
  }

  function updateDrug(id: string, patch: Partial<DrugInput>) {
    setMedications((current) =>
      current.map((drug) => (drug.id === id ? { ...drug, ...patch } : drug)),
    );
  }

  function applyResolution(id: string, resolution: ResolutionPayload) {
    const forms = resolution.availableFormsForStrength;
    setFormOptions((current) => ({ ...current, [id]: forms }));
    const locked =
      resolution.status === "AUTO_LOCKED" ? resolution.selectedVariant : null;
    updateDrug(
      id,
      locked
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
          },
    );
  }

  async function resolveDrug(drug: DrugInput) {
    const query = [drug.ndc, drug.name, drug.strength]
      .filter(Boolean)
      .join(" ");
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
    const others = (formOptions[drug.id] ?? []).filter(
      (item) => item.dosageForm !== variant.dosageForm,
    );
    updateDrug(drug.id, {
      rxcui: variant.rxcui,
      resolvedName: variant.fullName,
      dosageForm: variant.coarseForm,
      dosageFormLabel: variant.dosageForm,
      isBrand: variant.isBrand,
      resolutionStatus: drug.compareBothForms
        ? "AMBIGUOUS_FORM"
        : "AUTO_LOCKED",
      strength: drug.strength || variant.strength,
      alternate: drug.compareBothForms ? others[0] : undefined,
    });
  }

  function acceptChecked(items: CheckedMedication[]) {
    const notes: Record<string, DrugReviewNote> = {};
    const forms: Record<string, ResolvedVariant[]> = {};
    for (const item of items) {
      notes[item.drug.id] = item.note;
      if (item.forms.length > 0) forms[item.drug.id] = item.forms;
    }
    setMedications(items.map((item) => item.drug));
    setProofs({});
    setOpenProofKey(null);
    setDrugNotes(notes);
    setFormOptions(forms);
    setError("");
    setFixing(null);
    setDuplicate(null);
    setLearnMessage("");
    resolveUnlocked(items);
  }

  function resolveUnlocked(items: CheckedMedication[]) {
    for (const item of items) {
      const drug = item.drug;
      if (
        drug.name.trim() &&
        drug.strength.trim() &&
        !drug.rxcui &&
        drug.resolutionStatus !== "AMBIGUOUS_FORM"
      ) {
        void resolveDrug(drug);
      }
    }
  }

  function removeDrug(id: string) {
    const removed = medications.find((item) => item.id === id);
    const rawLine = drugNotes[id]?.rawLine;
    const siblings = rawLine
      ? medications.filter(
          (item) => item.id !== id && drugNotes[item.id]?.rawLine === rawLine,
        )
      : [];
    setMedications((current) => current.filter((item) => item.id !== id));
    setDrugNotes((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setDuplicate(
      removed && rawLine && siblings.length > 0
        ? {
            rawLine,
            removed: removed.name,
            kept: siblings.map((item) => item.name),
            reading: siblings.map(readingFor).join("; "),
          }
        : null,
    );
  }

  async function saveLearning(body: Record<string, unknown>) {
    const response = await fetch("/api/medicare/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      drafts?: MedicationDraft[];
    };
    if (!response.ok || !data.ok)
      throw new Error(data.error || "The correction could not be saved.");
    return data;
  }

  /** Saves how a typed line should be read, then shows the line's medications read the new way. */
  async function teachLine(rawLine: string, reading: string) {
    setLearning(true);
    setLearnMessage("");
    try {
      const data = await saveLearning({ kind: "line", rawLine, reading });
      const items = (data.drafts ?? []).flatMap(cardsFromDraft);
      replaceLine(rawLine, items);
      setFixing(null);
      setLearnMessage(
        `${reading ? "Learned how to read" : "Learned that this isn't a medication:"} "${rawLine}". ${data.message ?? ""}`,
      );
    } catch (caught) {
      setLearnMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLearning(false);
    }
  }

  function replaceLine(rawLine: string, items: CheckedMedication[]) {
    const onLine = (drug: DrugInput) => drugNotes[drug.id]?.rawLine === rawLine;
    const at = Math.max(0, medications.findIndex(onLine));
    const kept = medications.filter((drug) => !onLine(drug));
    const removedIds = medications.filter(onLine).map((drug) => drug.id);
    setMedications([
      ...kept.slice(0, at),
      ...items.map((item) => item.drug),
      ...kept.slice(at),
    ]);
    setDrugNotes((current) => {
      const next = { ...current };
      removedIds.forEach((id) => delete next[id]);
      items.forEach((item) => (next[item.drug.id] = item.note));
      return next;
    });
    setFormOptions((current) => {
      const next = { ...current };
      removedIds.forEach((id) => delete next[id]);
      items.forEach((item) => {
        if (item.forms.length > 0) next[item.drug.id] = item.forms;
      });
      return next;
    });
    resolveUnlocked(items);
  }

  async function learnDuplicate() {
    if (!duplicate) return;
    setLearning(true);
    try {
      const data = await saveLearning({
        kind: "line",
        rawLine: duplicate.rawLine,
        reading: duplicate.reading,
      });
      setLearnMessage(
        `Learned: "${duplicate.rawLine}" is ${duplicate.kept.join(" and ")} only. ${data.message ?? ""}`,
      );
      setDuplicate(null);
    } catch (caught) {
      setLearnMessage(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLearning(false);
    }
  }

  async function markOtc(drug: DrugInput, otc: boolean) {
    updateDrug(drug.id, { isOtc: otc });
    try {
      const data = await saveLearning({ kind: "otc", name: drug.name, otc });
      setLearnMessage(
        `${drug.name} is now marked ${otc ? "over the counter (usually not Part D)" : "a prescription drug"}. ${data.message ?? ""}`,
      );
    } catch (caught) {
      setLearnMessage(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function pickStrength(drug: DrugInput, label: string) {
    const next = {
      ...drug,
      strength: label,
      resolutionStatus: "UNRESOLVED" as const,
      rxcui: undefined,
      resolvedName: undefined,
    };
    updateDrug(drug.id, next);
    setDrugNotes((current) => ({
      ...current,
      [drug.id]: {
        ...(current[drug.id] ?? blankNote(drug.name)),
        strengthChoices: [],
      },
    }));
    void resolveDrug(next);
  }

  function chooseSpelling(drug: DrugInput, suggestion: SpellingSuggestion) {
    const kept = suggestion.strengths.find((choice) =>
      sameStrength(choice, drug.strength),
    );
    const next: DrugInput = {
      ...drug,
      name: suggestion.drugName,
      strength: kept ?? "",
      resolutionStatus: "UNRESOLVED",
      rxcui: undefined,
      resolvedName: undefined,
      dosageFormLabel: undefined,
    };
    updateDrug(drug.id, next);
    setDrugNotes((current) => ({
      ...current,
      [drug.id]: {
        ...(current[drug.id] ?? blankNote(suggestion.drugName)),
        wasSpellCorrected: true,
        originalTypedName: current[drug.id]?.originalTypedName || drug.name,
        strengthChoices: kept ? [] : suggestion.strengths,
      },
    }));
    if (kept) void resolveDrug(next);
  }

  function setTimesPerDay(drug: DrugInput, times: number) {
    updateDrug(drug.id, {
      quantityPerFill: times * 30,
      refillFrequencyMonths: "1",
    });
  }

  useEffect(() => {
    fetch("/api/medicare/extract-meds")
      .then((response) => response.json())
      .then((data) =>
        setVisionMessage(
          data.message ?? "Drop a pill-bottle photo or medication PDF.",
        ),
      )
      .catch(() =>
        setVisionMessage(
          "Pill-bottle intake is unavailable. The manual drug form still works.",
        ),
      );
  }, []);

  function togglePharmacy(pharmacy: PharmacyInput) {
    setSelectedPharmacyIds((current) => {
      if (current.includes(pharmacy.id))
        return current.filter((id) => id !== pharmacy.id);
      const next = [...current, pharmacy.id];
      const retail = pharmacyChoices.filter(
        (item) => next.includes(item.id) && !item.isMailOrder,
      );
      if (retail.length > 5) return current;
      return next;
    });
  }

  function addCustomPharmacy() {
    const name = customPharmacyName.trim();
    if (name.length < 2) {
      setError("Enter a pharmacy name.");
      return;
    }
    const pharmacy: PharmacyInput = {
      id: `custom-${crypto.randomUUID()}`,
      name,
      chain: name,
      address: name,
      isMailOrder: false,
    };
    setCustomPharmacies((current) => [...current, pharmacy]);
    setCustomPharmacyName("");
    setError("");
    setSelectedPharmacyIds((current) => {
      const retail = [...pharmacyChoices, pharmacy].filter(
        (item) =>
          [...current, pharmacy.id].includes(item.id) && !item.isMailOrder,
      );
      if (retail.length > 5) return current;
      return [...current, pharmacy.id];
    });
  }

  function removeCustomPharmacy(id: string) {
    setCustomPharmacies((current) =>
      current.filter((pharmacy) => pharmacy.id !== id),
    );
    setSelectedPharmacyIds((current) =>
      current.filter((selectedId) => selectedId !== id),
    );
  }

  function showMedicationError(drugId: string, message: string) {
    setError(message);
    document.getElementById(`medication-${drugId}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const county =
      counties.find((item) => item.fips === countyFips) ?? counties[0];
    if (!county) {
      setError("Choose a county.");
      return;
    }
    if (medications.length === 0) {
      setError("Add at least one medication.");
      return;
    }
    const missingName = medications.find((drug) => drug.name.trim().length < 2);
    if (missingName) {
      showMedicationError(missingName.id, "Each medication needs a name.");
      return;
    }
    const missingStrength = medications.find(
      (drug) => !drug.isSupply && !drug.isOtc && !drug.strength.trim(),
    );
    if (missingStrength) {
      showMedicationError(missingStrength.id, `Pick a Strength for ${missingStrength.name}.`);
      return;
    }
    const unresolved = medications.find(
      (drug) =>
        !drug.isOtc &&
        (drug.resolutionStatus === "UNRESOLVED" || !drug.resolutionStatus),
    );
    if (unresolved) {
      showMedicationError(unresolved.id, `Pick a Form for ${unresolved.name} before comparing.`);
      return;
    }
    const ambiguous = medications.find(
      (drug) =>
        drug.resolutionStatus === "AMBIGUOUS_FORM" &&
        !drug.rxcui &&
        !drug.compareBothForms,
    );
    if (ambiguous) {
      showMedicationError(
        ambiguous.id,
        `${ambiguous.name} has two forms. Pick one, or turn on Test Both Forms.`,
      );
      return;
    }
    if (selectedPharmacies.length === 0) {
      setError("Select at least one pharmacy.");
      return;
    }
    const unchecked = [
      ...new Set(
        medications
          .map((drug) => drugNotes[drug.id]?.learnedFix)
          .filter((fix) => fix && !fix.confirmed)
          .map((fix) => fix!.id),
      ),
    ];
    if (unchecked.length > 0) {
      void saveLearning({ kind: "confirm", ids: unchecked }).catch(() => undefined);
    }
    const payload: CompareRequest = {
      zipCode,
      countyFips: county.fips,
      countyName: county.name,
      state: county.state || undefined,
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
      setContext({
        zipCode: data.zipCode,
        countyName: county.state
          ? `${data.countyName}, ${county.state}`
          : data.countyName,
      });
      } catch {
      setError("Could not reach the comparison service.");
    } finally {
      setLoading(false);
    }
  }

  async function onExtract(file: File) {
    setExtracting(true);
    setError("");
    const body = new FormData();
    body.set("file", file);
    try {
      const response = await fetch("/api/medicare/extract-meds", {
        method: "POST",
        body,
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error ?? "Could not read that file.");
        return;
      }
      const imported: DrugInput[] = data.medications.map(
        (item: {
          name: string;
          strength: string;
          dosageForm: DosageForm;
          dosageFormLabel?: string;
          quantityPerFill: number;
          refillFrequencyMonths: "1" | "3";
          resolution: ResolutionPayload;
        }) => {
          const variant =
            item.resolution.status === "AUTO_LOCKED"
              ? item.resolution.selectedVariant
              : null;
          const id = crypto.randomUUID();
          setFormOptions((current) => ({
            ...current,
            [id]: item.resolution.availableFormsForStrength,
          }));
          return {
            id,
            name: item.name,
            strength: item.strength,
            dosageForm: variant?.coarseForm ?? item.dosageForm,
            dosageFormLabel: variant?.dosageForm ?? item.dosageFormLabel,
            quantityPerFill: item.quantityPerFill,
            refillFrequencyMonths: item.refillFrequencyMonths,
            acceptGeneric: true,
            rxcui: variant?.rxcui,
            resolvedName: variant?.fullName,
            isBrand: variant?.isBrand,
            resolutionStatus: item.resolution.status,
          } satisfies DrugInput;
        },
      );
      setMedications((current) => [
        ...current.filter((drug) => drug.name.trim()),
        ...imported,
      ]);
    } catch {
      setError("Could not read that file. The manual drug form still works.");
    } finally {
      setExtracting(false);
    }
  }

  async function captureProof() {
    const county =
      counties.find((item) => item.fips === countyFips) ?? counties[0];
    if (!county) return;
    const key = proofKey;
    const cached = proofs[key];
    if (cached && !cached.error) {
      setOpenProofKey(key);
      return;
    }
    setProofLoading(true);
    setOpenProofKey(null);
    let result: ProofResult;
    try {
      const response = await fetch("/api/medicare/proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zipCode,
          countyFips: county.fips,
          countyName: county.name,
          state: county.state || undefined,
          contractYear,
          lisLevel,
          medications,
          pharmacies: selectedPharmacies,
          providers: providerNames(providerText),
          planTypeFilter: planType,
          pauseForMissing: true,
        }),
      });
      result = readProof(await response.json());
    } catch {
      result = {
        ...readProof({}),
        url: "",
        error:
          "Medicare.gov proof could not be captured. The sample comparison is still available.",
      };
    } finally {
      setProofLoading(false);
    }
    setProofs((current) => ({ ...current, [key]: result }));
    if (result.images.length > 0 && !result.paused) setOpenProofKey(key);
  }

  const splitTip =
    filtered.map((plan) => splitPharmacyTip(plan)).find(Boolean) ?? null;
  const formTips = filtered.flatMap((plan) =>
    formularyFormTip(plan, comparisonQuote(plan)),
  );
  const repeats = repeatedDrugs(medications);
  const repeatedIds = new Set(repeats.flatMap((repeat) => repeat.ids));

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-8 pb-28 sm:px-6">
      <div className="mb-6 space-y-4">
        <div className="flex justify-end pr-36">
          <Link
            href="/assistant"
            className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white"
          >
            Assistant
          </Link>
        </div>
        <button
          type="button"
          onClick={resetPage}
          className="fixed top-4 right-4 z-10 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-medium shadow-sm"
        >
          Reset Form
        </button>
        <header className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-medium tracking-wide text-[var(--accent)]">
            Licensed Agent Planning Tool
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Medicare Drug Comparison
          </h1>
          <p className="mt-3 text-sm leading-6 text-stone-700">
            These figures are sample planning estimates, not a beneficiary
            quote. Confirm the final one or two plans in Medicare.gov or the
            agency quoting tool. Annual out-of-pocket drug costs in this sample
            stop at the {money(partDCap(contractYear))} Part D cap for{" "}
            {contractYear}.
          </p>
        </header>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        <fieldset className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4 shadow-sm">
          <legend className="mx-auto px-1 text-center text-sm font-semibold">Location</legend>
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,0.55fr)_minmax(0,0.75fr)_minmax(0,0.5fr)_minmax(0,0.9fr)_minmax(14rem,1.4fr)_auto]">
            <label className="block text-sm">
              ZIP Code
              <input
                value={zipCode}
                onChange={(event) =>
                  setZipCode(event.target.value.replace(/\D/g, "").slice(0, 5))
                }
                inputMode="numeric"
                placeholder="Any US ZIP"
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              />
              {locationError && zipCode.length === 5 ? (
                <span className="mt-1 block text-xs text-[var(--warn)]">
                  {locationError}
                </span>
              ) : null}
            </label>
            <label className="block text-sm">
              County
              <select
                value={countyFips}
                onChange={(event) => setCountyFips(event.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                <option value="">
                  {zipCode.length === 5 ? "Select a County" : "Enter a ZIP code first"}
                </option>
                {countyChoices.map((county) => (
                  <option key={county.fips} value={county.fips}>
                    {county.state ? `${county.name}, ${county.state}` : county.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Contract Year
              <select
                value={contractYear}
                onChange={(event) =>
                  setContractYear(event.target.value as "2026" | "2027")
                }
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                <option value="2026">2026</option>
                <option value="2027">2027</option>
              </select>
            </label>
            <label className="block text-sm">
              Plan Type
              <select
                value={planType}
                onChange={(event) =>
                  setPlanType(event.target.value as PlanCategory)
                }
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                <option value="ALL">All Plans</option>
                <option value="MAPD">Medicare Advantage + Drug</option>
                <option value="PDP">Stand-Alone Part D</option>
                <option value="MEDIGAP">Medigap</option>
              </select>
            </label>
            <label className="block text-sm">
              Do you get help with your Medicare health or drug costs?
              <select
                value={lisLevel}
                onChange={(event) =>
                  setLisLevel(event.target.value as LisLevel)
                }
                className="mt-1 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2"
              >
                <option value="LIS_MEDICAID">Medicaid</option>
                <option value="LIS_SSI">Supplemental Security Income</option>
                <option value="LIS_MSP">Medicare Savings Program</option>
                <option value="LIS_SS">Extra Help (with drug costs)</option>
                <option value="LIS_NONE">
                  I don&apos;t get help from any of these programs
                </option>
              </select>
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={showMppp}
                onChange={(event) => setShowMppp(event.target.checked)}
              />
              Show MPPP Monthly Smoothed Payment
            </label>
          </div>
          {zipCode === "91361" ? (
            <p className="mt-2 text-xs text-[var(--warn)]">
              This ZIP spans Ventura and Los Angeles. Pick the county before
              comparing.
            </p>
          ) : null}
          <div className="mt-4 border-t border-[var(--line)] pt-3">
            <p className="text-center text-sm font-semibold">Pharmacies</p>
            <p className="mt-1 text-center text-xs text-stone-600">
              Up to five retail pharmacies, plus mail order.
              {location?.state ? ` Big chains in ${location.state}.` : ""}{" "}
              {retailCount} retail selected.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              {pharmacyChoices.map((pharmacy) => (
                <label
                  key={pharmacy.id}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selectedPharmacyIds.includes(pharmacy.id)}
                    onChange={() => togglePharmacy(pharmacy)}
                  />
                  <span className="font-medium">{pharmacy.name}</span>
                  {pharmacy.id.startsWith("custom-") ? (
                    <button
                      type="button"
                      className="text-xs text-stone-600 underline"
                      onClick={() => removeCustomPharmacy(pharmacy.id)}
                    >
                      Remove
                    </button>
                  ) : null}
                </label>
              ))}
              <div className="flex min-w-64 flex-1 gap-2">
                <input
                  value={customPharmacyName}
                  onChange={(event) =>
                    setCustomPharmacyName(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCustomPharmacy();
                    }
                  }}
                  placeholder="Pharmacy Name"
                  aria-label="Custom Pharmacy Name"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={addCustomPharmacy}
                  className="rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm font-medium"
                >
                  Add Pharmacy
                </button>
              </div>
            </div>
          </div>
          <div className="mt-4 border-t border-[var(--line)] pt-3">
            <button
              type="button"
              aria-expanded={providersOpen}
              onClick={() => setProvidersOpen((open) => !open)}
              className="w-full text-center text-sm font-semibold"
            >
              Providers
              <span className="ml-2 font-normal text-stone-600">
                {providerNames(providerText).length > 0
                  ? `${providerNames(providerText).length} listed`
                  : "Optional"}
              </span>
            </button>
            {providersOpen ? (
              <label className="mt-2 block text-sm">
                <span className="mt-2 block text-center text-xs font-normal text-stone-600">
                  One doctor per line, first and last name, such as Jane Smith
                  or Smith, Jane. Leave this blank and the proof skips
                  providers.
                </span>
                <textarea
                  value={providerText}
                  onChange={(event) => setProviderText(event.target.value)}
                  rows={3}
                  placeholder={"Jane Smith\nSmith, Jane"}
                  aria-label="Providers, one doctor per line, first and last name"
                  className="mt-2 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
                />
              </label>
            ) : null}
          </div>
        </fieldset>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <aside className="order-2 min-w-0 space-y-3 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4 lg:order-1">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
              <button
                type="button"
                className="justify-self-start text-sm font-medium text-[var(--accent)]"
                onClick={() =>
                  setMedications((current) => [...current, newDrug()])
                }
              >
                Add a Drug
              </button>
              <div className="text-center">
                <h2 className="text-sm font-semibold">Medications</h2>
                {medications.length > 0 ? (
                  <p className="text-xs text-stone-600">
                    {medications.length}{" "}
                    {medications.length === 1 ? "drug" : "drugs"}
                  </p>
                ) : null}
              </div>
              <div className="justify-self-end">
              {medications.length > 0 ? (
                <button
                  type="button"
                  className="text-sm text-stone-600 underline"
                  onClick={() => {
                    setMedications([]);
                    setDrugNotes({});
                    setFormOptions({});
                    setError("");
                    setFixing(null);
                    setDuplicate(null);
                  }}
                >
                  Remove All
                </button>
              ) : (
                <span />
              )}
              </div>
            </div>
            {duplicate ? (
              <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
                <p>
                  Removed {duplicate.removed}. Was it the same drug as{" "}
                  {duplicate.kept.join(" and ")}, written twice on “
                  {duplicate.rawLine}”?
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={learning}
                    onClick={() => void learnDuplicate()}
                    className="rounded-lg bg-[var(--accent)] px-2 py-1 font-semibold text-white disabled:opacity-60"
                  >
                    Yes, read this line as one drug next time
                  </button>
                  <button
                    type="button"
                    onClick={() => setDuplicate(null)}
                    className="rounded-lg border border-[var(--line)] bg-white px-2 py-1"
                  >
                    No
                  </button>
                </div>
              </div>
            ) : null}
            {learnMessage ? (
              <p className="text-xs text-stone-600">{learnMessage}</p>
            ) : null}
            {repeats.length > 0 ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-medium">Listed more than once</p>
                <ul className="mt-1 space-y-1">
                  {repeats.map((repeat) => (
                    <li key={repeat.label}>
                      {repeat.label} is listed {repeat.count} times
                      {repeat.detail}.
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {medications.length === 0 ? (
              <p className="text-center text-sm text-stone-600">
                Checked medications appear here.
              </p>
            ) : (
              <ol className="space-y-3">
                {medications.map((drug, index) => {
                  const note = drugNotes[drug.id];
                  const strengthChoices = note?.strengthChoices ?? [];
                  const confirmed = Boolean(drug.rxcui || drug.isSupply);
                  const countsPerDay = ["TABLET", "CAPSULE", "SUPPLY"].includes(
                    drug.dosageForm,
                  );
                  const needsStrength =
                    strengthChoices.length > 0 &&
                    !drug.strength.trim() &&
                    !confirmed;
                  const daily = timesPerDay(drug);
                  const otherNames = (note?.spellingSuggestions ?? []).filter(
                    (suggestion) =>
                      suggestion.drugName.toLowerCase() !==
                      drug.name.toLowerCase(),
                  );
                  const incomplete = medicationNeedsUpdate(drug);
                  const repeated = repeatedIds.has(drug.id);
                  return (
                    <li
                      key={drug.id}
                      id={`medication-${drug.id}`}
                      className={`scroll-mt-6 space-y-2 rounded-xl border p-3 ${incomplete ? "border-amber-300 bg-amber-50" : repeated ? "border-amber-300" : "border-[var(--line)]"}`}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-stone-500">
                          Drug {index + 1}
                          {repeated ? (
                            <span className="ml-2 text-amber-800">
                              Listed more than once
                            </span>
                          ) : null}
                        </p>
                        <div className="flex gap-3">
                          {note?.rawLine ? (
                            <button
                              type="button"
                              className="text-xs text-[var(--accent)] underline"
                              onClick={() =>
                                setFixing(
                                  fixing?.id === drug.id
                                    ? null
                                    : { id: drug.id, reading: readingFor(drug) },
                                )
                              }
                            >
                              Fix This Read
                            </button>
                          ) : null}
                          {!drug.isSupply && drug.name.trim() ? (
                            <button
                              type="button"
                              className="text-xs text-stone-600 underline"
                              onClick={() => void markOtc(drug, !drug.isOtc)}
                            >
                              {drug.isOtc ? "Not OTC" : "Mark OTC"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="text-xs text-stone-600 underline"
                            onClick={() => removeDrug(drug.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                      {fixing?.id === drug.id && note?.rawLine ? (
                        <div className="space-y-2 rounded-lg border border-[var(--line)] bg-stone-50 p-2">
                          <p className="text-xs text-stone-600">
                            Typed: “{note.rawLine}”. Write how this line should
                            be read (name, strength, form). Put ; between drugs
                            if it really lists more than one. Everyone on the
                            team gets the fix.
                          </p>
                          <input
                            aria-label={`How to read drug ${index + 1}`}
                            value={fixing.reading}
                            onChange={(event) =>
                              setFixing({ id: drug.id, reading: event.target.value })
                            }
                            className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                          />
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={learning || fixing.reading.trim().length < 2}
                              onClick={() =>
                                void teachLine(note.rawLine, fixing.reading.trim())
                              }
                              className="rounded-lg bg-[var(--accent)] px-2 py-1 text-xs font-semibold text-white disabled:opacity-60"
                            >
                              {learning ? "Saving…" : "Save and read again"}
                            </button>
                            <button
                              type="button"
                              disabled={learning}
                              onClick={() => void teachLine(note.rawLine, "")}
                              className="rounded-lg border border-[var(--line)] bg-white px-2 py-1 text-xs"
                            >
                              Not a medication
                            </button>
                            <button
                              type="button"
                              onClick={() => setFixing(null)}
                              className="px-2 py-1 text-xs text-stone-600 underline"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : null}
                      {note && drug.name.trim() ? (
                        <div className="space-y-1">
                          <h3 className="text-sm font-semibold">{drug.name}</h3>
                          {note.alsoKnownAs ? (
                            <p className="text-xs text-stone-600">
                              Also written as {note.alsoKnownAs}
                            </p>
                          ) : null}
                          {drug.isOtc ? (
                            <p className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                              OTC, likely not covered by Part D
                            </p>
                          ) : null}
                          {note.learnedFix ? (
                            <p className="text-xs text-stone-600">
                              {!note.learnedFix.confirmed
                                ? "Gemini fixed how this line was read. Check it; comparing confirms the fix for the team."
                                : note.learnedFix.author.includes("Gemini")
                                  ? "Read with a Gemini fix the team confirmed."
                                  : `Read with a fix taught by ${note.learnedFix.author}.`}
                            </p>
                          ) : null}
                        </div>
                      ) : (
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
                          onBlur={(event) => {
                            const name = event.currentTarget.value.trim();
                            if (name && drug.strength.trim())
                              void resolveDrug({ ...drug, name });
                          }}
                          className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                        />
                      )}
                      {note?.wasSpellCorrected ? (
                        <div className="space-y-1">
                          <p className="text-xs text-stone-600">
                            Changed from what was typed:{" "}
                            {note.originalTypedName}
                          </p>
                          {otherNames.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {otherNames.map((suggestion) => (
                                <button
                                  key={suggestion.drugName}
                                  type="button"
                                  onClick={() =>
                                    chooseSpelling(drug, suggestion)
                                  }
                                  className="rounded-full border border-[var(--line)] px-2 py-1 text-xs"
                                >
                                  {suggestion.drugName}
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      {needsStrength ? (
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-amber-800">
                            {note?.unlistedStrength
                              ? `${note.unlistedStrength} is not a listed strength. Pick a Strength`
                              : "Pick a Strength"}
                          </p>
                          {strengthChoices.length > 3 ? (
                            <select
                              aria-label={`Drug ${index + 1} strength`}
                              value={
                                strengthChoices.includes(drug.strength)
                                  ? drug.strength
                                  : ""
                              }
                              onChange={(event) => {
                                if (event.target.value)
                                  pickStrength(drug, event.target.value);
                              }}
                              className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
                            >
                              <option value="">Pick a Strength</option>
                              {strengthChoices.map((choice) => (
                                <option key={choice} value={choice}>
                                  {choice}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {strengthChoices.map((choice) => (
                                <button
                                  key={choice}
                                  type="button"
                                  onClick={() => pickStrength(drug, choice)}
                                  className="rounded-full border border-[var(--line)] px-2 py-1 text-xs"
                                >
                                  {choice}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : null}
                      {confirmed ? (
                        <p className="text-sm text-stone-700">
                          {drug.isSupply ? "Diabetic supply" : drug.strength} ·{" "}
                          {quantityLabel(drug)}
                        </p>
                      ) : (
                        <input
                          aria-label={`Drug ${index + 1} strength`}
                          placeholder="Strength, such as 20 mg or 10 mg / 20 mg"
                          value={drug.strength}
                          onChange={(event) =>
                            updateDrug(drug.id, {
                              strength: event.target.value,
                              resolutionStatus: "UNRESOLVED",
                              rxcui: undefined,
                              resolvedName: undefined,
                            })
                          }
                          onBlur={(event) => {
                            const strength = event.currentTarget.value.trim();
                            if (!drug.name.trim() || !strength) return;
                            const next = {
                              ...drug,
                              strength,
                              resolutionStatus: "UNRESOLVED" as const,
                              rxcui: undefined,
                              resolvedName: undefined,
                            };
                            updateDrug(drug.id, next);
                            void resolveDrug(next);
                          }}
                          className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                        />
                      )}
                      {countsPerDay ? (
                      <div className="flex flex-wrap gap-1">
                        {[1, 2, 3].map((times) => (
                          <button
                            key={times}
                            type="button"
                            onClick={() => setTimesPerDay(drug, times)}
                            className={`rounded-full border px-2 py-1 text-xs ${daily === times && drug.refillFrequencyMonths === "1" ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)]"}`}
                          >
                            {times} {times === 1 ? "time" : "times"} a day
                          </button>
                        ))}
                      </div>
                      ) : (
                        <label className="flex items-center gap-2 text-xs text-stone-600">
                          Quantity per 30-day fill
                          <input
                            type="number"
                            min={1}
                            aria-label={`Drug ${index + 1} quantity`}
                            value={drug.quantityPerFill}
                            onChange={(event) =>
                              updateDrug(drug.id, {
                                quantityPerFill: Math.max(
                                  1,
                                  Math.round(Number(event.target.value) || 1),
                                ),
                                refillFrequencyMonths: "1",
                              })
                            }
                            className="w-20 rounded-lg border border-[var(--line)] px-2 py-1 text-sm"
                          />
                          {quantityUnit(drug)}
                        </label>
                      )}
                      {(formOptions[drug.id]?.length ?? 0) <= 1 &&
                      drug.resolutionStatus === "NOT_FOUND" ? (
                        <select
                          aria-label={`Drug ${index + 1} form`}
                          value={drug.dosageForm}
                          onChange={(event) =>
                            updateDrug(drug.id, {
                              dosageForm: event.target.value as DosageForm,
                            })
                          }
                          className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
                        >
                          {FORMS.map((form) => (
                            <option key={form.value} value={form.value}>
                              {form.label}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <FormResolution
                        drug={drug}
                        options={formOptions[drug.id] ?? []}
                        onSelect={(variant) => selectVariant(drug, variant)}
                        onCompareBoth={(checked) => {
                          const forms = formOptions[drug.id] ?? [];
                          const primary =
                            forms.find((item) => item.rxcui === drug.rxcui) ??
                            forms[0];
                          const alternate = forms.find(
                            (item) => item.dosageForm !== primary?.dosageForm,
                          );
                          updateDrug(drug.id, {
                            compareBothForms: checked,
                            resolutionStatus: checked
                              ? "AMBIGUOUS_FORM"
                              : drug.rxcui
                                ? "AUTO_LOCKED"
                                : "AMBIGUOUS_FORM",
                            rxcui: primary?.rxcui ?? drug.rxcui,
                            resolvedName:
                              primary?.fullName ?? drug.resolvedName,
                            dosageForm: primary?.coarseForm ?? drug.dosageForm,
                            dosageFormLabel:
                              primary?.dosageForm ?? drug.dosageFormLabel,
                            isBrand: primary?.isBrand ?? drug.isBrand,
                            alternate: checked ? alternate : undefined,
                          });
                        }}
                      />
                      {drug.isBrand ? (
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!drug.acceptGeneric}
                            onChange={(event) =>
                              updateDrug(drug.id, {
                                acceptGeneric: !event.target.checked,
                              })
                            }
                          />
                          Brand Only
                        </label>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            )}
          </aside>
          <div className="order-1 space-y-3 self-start rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4 shadow-sm lg:sticky lg:top-4 lg:order-2 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <ChatDrugIntake key={formVersion} onChecked={acceptChecked} />
        <section className="min-w-0 space-y-4">
            {plans.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-4 text-center text-sm text-stone-600">
                Run a comparison, then capture Medicare.gov proof for the
                current medication list.
              </div>
            ) : (
              <>
                <div className="rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4">
                  <div className="text-center">
                    <h2 className="text-lg font-semibold">
                      {context?.countyName} · {context?.zipCode}
                    </h2>
                    <p className="text-sm text-stone-600">
                      {filtered.length} of {plans.length} sample plans match
                      these filters.
                    </p>
                    <div className="mt-3">
                      <DrugCheckSummary
                        count={medications.length}
                        repeats={repeats}
                      />
                    </div>
                    <div className="mt-3 flex flex-wrap justify-center gap-2">
                      <button
                        type="button"
                        onClick={() => void captureProof()}
                        disabled={proofLoading}
                        className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      >
                        {proofLoading
                          ? "Opening Medicare.gov…"
                          : proof && !proof.error
                            ? "View Medicare.gov Proof"
                            : "Capture Medicare.gov Proof"}
                      </button>
                    </div>
                  </div>
                  <AuditBanner
                    medications={quotedMeds}
                    verified={
                      filtered[0]
                        ? drugsVerified(
                            quotedMeds,
                            comparisonQuote(filtered[0]),
                          )
                        : false
                    }
                  />
                  {lisNote ? (
                    <p className="mt-3 text-xs leading-5 text-stone-700">
                      {lisNote.label}
                    </p>
                  ) : null}
                  {showMppp ? (
                    <p className="mt-2 text-xs leading-5 text-stone-700">
                      The monthly figure is an even split of this sample&apos;s
                      annual drug cost. It is a planning estimate of the
                      Medicare Prescription Payment Plan, not the CMS invoice.
                      The January-style amount is the first fill before
                      smoothing.
                    </p>
                  ) : null}
                  {splitTip ? (
                    <p className="mt-3 rounded-lg bg-[var(--accent-soft)] px-3 py-2 text-sm">
                      {splitTip}
                    </p>
                  ) : null}
                  {formTips.map((tip) => (
                    <p
                      key={tip}
                      className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950"
                    >
                      {tip}
                    </p>
                  ))}
                  {proof?.error ? (
                    <p className="mt-3 text-sm text-[var(--warn)]">
                      {proof.error}
                    </p>
                  ) : null}
                  {proof && proof.skipped.length > 0 ? (
                    <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
                      {skippedNote(proof.skipped)}
                    </p>
                  ) : null}
                  {proof && proof.missing.length > 0 ? (
                    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-950">
                      <p className="font-medium">
                        Not Found Automatically ({proof.missing.length}).
                      </p>
                      <ul className="mt-2 space-y-2">
                        {proof.missing.map((drug, index) => (
                          <li key={`${drug.name}-${drug.strength}-${index}`} className="flex items-start gap-3">
                            {drug.src ? (
                              <button
                                type="button"
                                className="shrink-0"
                                onClick={() => setOpenProofKey(proofKey)}
                                aria-label={`Screenshot for ${drug.name}`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={drug.src}
                                  alt=""
                                  className="h-14 w-20 rounded border border-amber-200 object-cover object-top"
                                />
                              </button>
                            ) : null}
                            <div>
                              <p className="font-medium">
                                {[drug.name, drug.strength].filter(Boolean).join(" ")}
                              </p>
                              <p className="text-xs text-amber-900">{drug.reason}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {proof && proof.images.length > 0 ? (
                    <button
                      type="button"
                      className="mr-4 mt-2 inline-block text-sm text-[var(--accent)] underline"
                      onClick={() => setOpenProofKey(proofKey)}
                    >
                      View Screenshots
                    </button>
                  ) : null}
                  {proof?.url ? (
                    <a
                      className="mt-2 inline-block text-sm text-[var(--accent)] underline"
                      href={proof.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open This Medicare.gov Page
                    </a>
                  ) : null}
                  {proof?.pdf && proof.id ? (
                    <a
                      className="ml-4 mt-2 inline-block text-sm text-[var(--accent)] underline"
                      href={`/api/medicare/proof/${proof.id}/page.pdf`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download PDF
                    </a>
                  ) : null}
                </div>

              </>
            )}
          </section>
            <label className="block rounded-xl border border-dashed border-[var(--line)] p-3 text-xs text-stone-600">
              Pill Bottle or Medication List
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
              <span className="mt-2 block">
                {extracting ? "Reading the file…" : visionMessage}
              </span>
            </label>
            <button
              type="button"
              className="text-sm font-medium text-[var(--accent)]"
              onClick={() =>
                setMedications((current) => [...current, newDrug()])
              }
            >
              Add a Drug
            </button>
          </div>
        </div>
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 flex flex-col items-center gap-2 px-4 py-3">
          {error ? (
            <p className="pointer-events-auto rounded-lg bg-amber-100 px-3 py-1.5 text-center text-sm font-medium text-[var(--warn)]">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={loading}
            className="pointer-events-auto w-full max-w-md rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
              {loading ? "Comparing…" : "Compare Plans"}
            </button>
        </div>
      </form>
      {openProof ? (
        <div
          className="fixed inset-0 z-20 flex items-center justify-center bg-stone-900/50 p-4"
          role="dialog"
          aria-label="Medicare.gov Proof"
        >
          <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-4">
            <div className="mb-3 text-center">
              <h2 className="text-lg font-semibold">Medicare.gov Proof</h2>
              <button
                type="button"
                className="mt-1 text-sm underline"
                onClick={() => setOpenProofKey(null)}
              >
                Close
              </button>
            </div>
            <p className="mb-3 text-center text-xs text-stone-600">
              These images are the public pages the browser reached. They are
              not a beneficiary quote.
            </p>
            {openProof.error ? (
              <p className="mb-3 text-sm text-[var(--warn)]">
                {openProof.error}
              </p>
            ) : null}
            <div className="space-y-4">
              {openProof.images.map((image) => (
                <figure key={image.src}>
                  <figcaption className="mb-2 text-sm font-medium">
                    {image.label}
                  </figcaption>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.src}
                    alt={image.label}
                    className="w-full rounded-lg border border-[var(--line)]"
                  />
                </figure>
              ))}
            </div>
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
  if (drug.resolutionStatus === "NOT_FOUND") {
    return (
      <p className="text-xs text-[var(--warn)]">
        This name and strength were not found. Pick the form before comparing.
      </p>
    );
  }
  if (options.length < 2) {
    if (!drug.rxcui) return null;
    return (
      <p className="text-xs text-emerald-800">
        Form Confirmed.{drug.dosageFormLabel ? ` ${drug.dosageFormLabel}.` : ""}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {drug.rxcui ? (
        <p className="text-xs text-emerald-800">Form Confirmed.</p>
      ) : (
        <p className="text-xs font-medium text-amber-800">Pick a Form</p>
      )}
      {options.length > 3 ? (
        <select
          aria-label="Form"
          value={
            options.some((variant) => variant.rxcui === drug.rxcui)
              ? (drug.rxcui ?? "")
              : ""
          }
          onChange={(event) => {
            const variant = options.find((item) => item.rxcui === event.target.value);
            if (variant) onSelect(variant);
          }}
          className="w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm"
        >
          <option value="">Pick a Form</option>
          {options.map((variant) => (
            <option key={variant.rxcui} value={variant.rxcui}>
              {variant.dosageForm}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex flex-wrap gap-1">
          {options.map((variant) => (
            <button
              key={variant.rxcui}
              type="button"
              onClick={() => onSelect(variant)}
              className={`rounded-full border px-2 py-1 text-xs ${drug.rxcui === variant.rxcui ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)]"}`}
            >
              {variant.dosageForm}
            </button>
          ))}
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={Boolean(drug.compareBothForms)}
          onChange={(event) => onCompareBoth(event.target.checked)}
        />
        Test Both Forms
      </label>
    </div>
  );
}

function AuditBanner({
  medications,
  verified,
}: {
  medications: DrugInput[];
  verified: boolean;
}) {
  if (medications.length === 0) return null;
  return (
    <div className="mt-4 rounded-xl border border-[var(--line)] p-3">
      <p
        className={`text-xs font-semibold ${verified ? "text-emerald-800" : "text-amber-800"}`}
      >
        {verified ? "Verified Match" : "Dosage Review Needed"}
      </p>
      <ul className="mt-2 space-y-1 text-xs text-stone-700">
        {medications.map((drug) => (
          <li key={drug.id}>
            Typed {drug.name} {drug.strength}{" "}
            {drug.dosageFormLabel || drug.dosageForm}
            {drug.isSupply || (drug.isOtc && !drug.resolvedName)
              ? " · searched on Medicare.gov by name"
              : drug.resolvedName
                ? ` · Resolved as ${drug.resolvedName}`
                : " · not resolved to an RxCUI"}
            {drug.rxcui ? ` · RxCUI ${drug.rxcui}` : ""}
            {drug.isBrand
              ? drug.acceptGeneric
                ? " · generic allowed"
                : " · brand only"
              : drug.resolutionStatus === "AUTO_LOCKED" && !drug.isSupply
                ? " · generic"
                : ""}
            {drug.compareBothForms && drug.alternate
              ? ` · also quoting ${drug.alternate.fullName}`
              : ""}
            {drug.isOtc ? " · OTC, usually not covered by Part D" : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
