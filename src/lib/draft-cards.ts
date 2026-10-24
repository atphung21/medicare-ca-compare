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

export function cardsFromDraft(draft: MedicationDraft): CheckedMedication[] {
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
