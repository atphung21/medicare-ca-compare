"use client";

import { coarseDosageForm, type DrugInput } from "@/schemas/medicare";
import { useState } from "react";
import type { MedicationDraft, StagingOption, StagingVariant } from "@/services/med-list-parser";

const SAMPLE = `medications:
metformin 1000 2/ day
amlodipine benazepril 10 mg -20 mg 1/day
ezetimibe 10 mg 1/day
rosuvastatin`;

export function ChatDrugIntake({ onAdd }: { onAdd: (rows: DrugInput[]) => void }) {
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<MedicationDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function organize() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/medicare/parse-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = (await response.json()) as { ok: boolean; drafts?: MedicationDraft[]; error?: string };
      if (!response.ok || !data.ok || !data.drafts) {
        setDrafts([]);
        setMessage(data.error || "That note could not be organized.");
        return;
      }
      setDrafts(data.drafts);
    } catch {
      setMessage("The medication list could not be organized.");
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(id: string, next: MedicationDraft) {
    setDrafts((current) => current.map((draft) => (draft.id === id ? next : draft)));
  }

  const blocked = drafts.length === 0 || drafts.some((draft) => !draft.strengths.some((option) => option.selected));

  return (
    <div className="space-y-3 rounded-xl border border-[var(--line)] bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Paste a medication list</p>
        <button type="button" className="text-xs text-[var(--accent)] underline" onClick={() => setText(SAMPLE)}>
          Use sample list
        </button>
      </div>
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={5}
        placeholder="One medication per line, with strength and how often it is taken"
        className="w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm"
      />
      <button
        type="button"
        disabled={busy || text.trim().length === 0}
        onClick={() => void organize()}
        className="rounded-lg bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
      >
        {busy ? "Organizing…" : "Organize & build form"}
      </button>
      {message ? <p className="text-xs text-[var(--warn)]">{message}</p> : null}
      {drafts.map((draft) => (
        <article key={draft.id} className="space-y-2 rounded-xl border border-[var(--line)] p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{draft.drugName}</h3>
              <p className="text-xs text-stone-500">{draft.rawLine}</p>
            </div>
            <span className="text-xs font-medium text-stone-600">{statusLabel(draft)}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {[1, 2, 3].map((count) => (
              <button
                key={count}
                type="button"
                onClick={() =>
                  updateDraft(draft.id, {
                    ...draft,
                    dailyFrequency: count,
                    monthlyQuantity: count * 30,
                  })
                }
                className={chipClass(draft.dailyFrequency === count)}
              >
                {count}/day
              </button>
            ))}
            <span className="self-center text-xs text-stone-500">{draft.monthlyQuantity} per 30-day fill</span>
          </div>
          <ChipRow
            label="Strength"
            options={draft.strengths}
            onToggle={(label) => updateDraft(draft.id, toggleOption(draft, "strengths", label, false))}
          />
          <ChipRow
            label="Form"
            options={draft.forms}
            onToggle={(label) => updateDraft(draft.id, toggleOption(draft, "forms", label, true))}
          />
        </article>
      ))}
      {drafts.length > 0 ? (
        <button
          type="button"
          disabled={blocked}
          onClick={() => onAdd(drafts.flatMap(rowsFromDraft))}
          className="rounded-lg border border-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent)] disabled:opacity-60"
        >
          Add selected drug options
        </button>
      ) : null}
    </div>
  );
}

function ChipRow({ label, options, onToggle }: { label: string; options: StagingOption[]; onToggle: (label: string) => void }) {
  if (options.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs text-stone-500">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button key={option.label} type="button" onClick={() => onToggle(option.label)} className={chipClass(option.selected)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function chipClass(selected: boolean) {
  return `rounded-full border px-2 py-1 text-xs ${selected ? "border-[var(--accent)] bg-[var(--accent)] text-white" : "border-[var(--line)] bg-white"}`;
}

function statusLabel(draft: MedicationDraft) {
  if (!draft.strengths.some((option) => option.selected)) return "Missing strength";
  if (draft.forms.length > 1) return "Multiple forms";
  return "Ready";
}

function toggleOption(draft: MedicationDraft, key: "strengths" | "forms", label: string, keepOne: boolean): MedicationDraft {
  const selectedCount = draft[key].filter((option) => option.selected).length;
  const target = draft[key].find((option) => option.label === label);
  if (keepOne && target?.selected && selectedCount === 1) return draft;
  return {
    ...draft,
    [key]: draft[key].map((option) => (option.label === label ? { ...option, selected: !option.selected } : option)),
  };
}

function rowsFromDraft(draft: MedicationDraft): DrugInput[] {
  const strengths = draft.strengths.filter((option) => option.selected);
  const forms = draft.forms.filter((option) => option.selected);
  return strengths.flatMap((strength) =>
    forms.map((form) => {
      const variant = matchingVariant(strength, form);
      return {
        id: crypto.randomUUID(),
        name: draft.drugName,
        strength: strength.label,
        dosageForm: variant?.coarseForm ?? coarseDosageForm(form.label),
        dosageFormLabel: form.label,
        quantityPerFill: draft.monthlyQuantity,
        refillFrequencyMonths: "1" as const,
        acceptGeneric: variant ? !variant.isBrand : true,
        rxcui: variant?.rxcui || undefined,
        resolvedName: variant?.fullName,
        isBrand: variant?.isBrand,
        resolutionStatus: variant?.rxcui ? ("AUTO_LOCKED" as const) : ("UNRESOLVED" as const),
      };
    }),
  );
}

function matchingVariant(strength: StagingOption, form: StagingOption): StagingVariant | undefined {
  return (
    strength.variants.find((variant) => variant.dosageForm === form.label) ??
    form.variants.find((variant) => variant.strength.replace(/\s+/g, "").toLowerCase() === strength.label.replace(/\s+/g, "").toLowerCase())
  );
}
