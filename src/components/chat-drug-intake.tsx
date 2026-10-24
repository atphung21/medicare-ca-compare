"use client";

import { sameStrength } from "@/lib/strength";
import {
  coarseDosageForm,
  type DrugInput,
  type ResolvedVariant,
} from "@/schemas/medicare";
import type {
  MedicationDraft,
  SpellingSuggestion,
  StagingOption,
  StagingVariant,
} from "@/services/med-list-parser";
import { useState } from "react";

const SAMPLE = `medications:
metformin 1000 2/ day
amlodipine benazepril 10 mg -20 mg 1/day
ezetimibe 10 mg 1/day
rosuvastatin`;

const MISSPELLED_SAMPLE = `metfromin 1000 2/ day
amlodapine benezepril 10 mg -20 mg 1/day
ezetimbe 10 mg 1/day
rosuvistatin`;

export type DrugReviewNote = {
  rawLine: string;
  originalTypedName: string;
  wasSpellCorrected: boolean;
  confidenceScore: number;
  spellingSuggestions: SpellingSuggestion[];
  strengthChoices: string[];
  unlistedStrength?: string;
};

export type CheckedMedication = {
  drug: DrugInput;
  note: DrugReviewNote;
  forms: ResolvedVariant[];
};

export function ChatDrugIntake({
  onChecked,
}: {
  onChecked: (items: CheckedMedication[]) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function checkMedications() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/medicare/parse-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await response.json()) as {
        ok: boolean;
        drafts?: MedicationDraft[];
        error?: string;
      };
      if (!response.ok || !data.ok || !data.drafts) {
        setMessage(data.error || "That note could not be checked.");
        return;
      }
      onChecked(data.drafts.flatMap(cardsFromDraft));
    } catch {
      setMessage("The medication list could not be checked.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-[var(--line)] bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Paste a medication list</p>
        <div className="flex gap-3">
          <button
            type="button"
            className="text-xs text-[var(--accent)] underline"
            onClick={() => setText(SAMPLE)}
          >
            Use sample list
          </button>
          <button
            type="button"
            className="text-xs text-[var(--accent)] underline"
            onClick={() => setText(MISSPELLED_SAMPLE)}
          >
            Test misspelled sample
          </button>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={5}
        placeholder="Type or paste medications in any format, such as: lisinoprill 10 once a day, metformin ER 500 2 tabs bid, dorzolamide 2% 1 drop both eyes bid, FreeStyle test strips 3x daily"
        className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />
      <button
        type="button"
        disabled={busy || text.trim().length === 0}
        onClick={() => void checkMedications()}
        className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? "Checking…" : "Check medications"}
      </button>
      {message ? <p className="text-xs text-[var(--warn)]">{message}</p> : null}
    </div>
  );
}

function cardsFromDraft(draft: MedicationDraft): CheckedMedication[] {
  if (draft.isSupply) return [supplyCard(draft)];
  const selectedStrengths = draft.strengths.filter((option) => option.selected);
  if (selectedStrengths.length === 0) {
    const chosenForms = new Set(
      draft.forms.filter((option) => option.selected).map((option) => option.label),
    );
    const fitting = draft.strengths.filter((option) =>
      option.variants.some((variant) => chosenForms.has(variant.dosageForm)),
    );
    return [
      cardFor(
        draft,
        "",
        [],
        (fitting.length > 0 ? fitting : draft.strengths).map((option) => option.label),
        "UNRESOLVED",
      ),
    ];
  }
  const selectedForms = draft.forms.filter((option) => option.selected);
  const formPool =
    draft.status === "MULTIPLE_FORMS"
      ? draft.forms
      : selectedForms.length > 0
        ? selectedForms
        : draft.forms.slice(0, 1);
  return selectedStrengths.map((strength) => {
    const variants = uniqueVariants(strength, formPool);
    if (variants.length > 1)
      return cardFor(draft, strength.label, variants, [], "AMBIGUOUS_FORM");
    if (variants.length === 1)
      return cardFor(draft, strength.label, variants, [], "AUTO_LOCKED");
    return cardFor(draft, strength.label, [], [], "UNRESOLVED", formPool[0]);
  });
}

function supplyCard(draft: MedicationDraft): CheckedMedication {
  return {
    drug: {
      id: crypto.randomUUID(),
      name: draft.drugName,
      strength: "",
      dosageForm: "SUPPLY",
      dosageFormLabel: "Diabetic supply",
      quantityPerFill: draft.monthlyQuantity,
      refillFrequencyMonths: "1",
      acceptGeneric: true,
      resolutionStatus: "AUTO_LOCKED",
      isSupply: true,
    },
    note: {
      rawLine: draft.rawLine,
      originalTypedName: draft.originalTypedName,
      wasSpellCorrected: draft.wasSpellCorrected,
      confidenceScore: draft.confidenceScore,
      spellingSuggestions: [],
      strengthChoices: [],
    },
    forms: [],
  };
}

function cardFor(
  draft: MedicationDraft,
  strength: string,
  variants: ResolvedVariant[],
  strengthChoices: string[],
  status: DrugInput["resolutionStatus"],
  fallbackForm?: StagingOption,
): CheckedMedication {
  const locked = status === "AUTO_LOCKED" ? variants[0] : undefined;
  const hinted =
    fallbackForm ??
    draft.forms.find((option) => option.selected) ??
    draft.forms[0];
  return {
    drug: {
      id: crypto.randomUUID(),
      name: draft.drugName,
      strength,
      dosageForm:
        locked?.coarseForm ??
        (hinted ? coarseDosageForm(hinted.label) : "TABLET"),
      dosageFormLabel: locked?.dosageForm ?? hinted?.label,
      quantityPerFill: draft.monthlyQuantity,
      refillFrequencyMonths: "1",
      acceptGeneric: true,
      rxcui: locked?.rxcui,
      resolvedName: locked?.fullName,
      isBrand: locked?.isBrand,
      resolutionStatus: status,
    },
    note: {
      rawLine: draft.rawLine,
      originalTypedName: draft.originalTypedName,
      wasSpellCorrected: draft.wasSpellCorrected,
      confidenceScore: draft.confidenceScore,
      spellingSuggestions: draft.spellingSuggestions,
      strengthChoices,
      unlistedStrength:
        strengthChoices.length > 0 ? (draft.typedStrength ?? undefined) : undefined,
    },
    forms: variants,
  };
}

function uniqueVariants(
  strength: StagingOption,
  forms: StagingOption[],
): ResolvedVariant[] {
  const seen = new Set<string>();
  const variants: ResolvedVariant[] = [];
  for (const form of forms) {
    const match = matchingVariant(strength, form);
    const pool = match
      ? [match]
      : form.variants.filter((variant) =>
          sameText(variant.strength, strength.label),
        );
    for (const variant of pool) {
      if (seen.has(variant.rxcui)) continue;
      seen.add(variant.rxcui);
      variants.push(variant);
    }
  }
  return variants;
}

function matchingVariant(
  strength: StagingOption,
  form: StagingOption,
): StagingVariant | undefined {
  return (
    strength.variants.find((variant) => variant.dosageForm === form.label) ??
    form.variants.find((variant) => sameText(variant.strength, strength.label))
  );
}

function sameText(left: string, right: string) {
  return (
    sameStrength(left, right) ||
    left.toLowerCase().replace(/\s+/g, "") ===
      right.toLowerCase().replace(/\s+/g, "")
  );
}
