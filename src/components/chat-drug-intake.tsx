"use client";

import { cardsFromDraft, type CheckedMedication } from "@/lib/draft-cards";
import type { MedicationDraft } from "@/services/med-list-parser";
import { useState } from "react";

export type { CheckedMedication, DrugReviewNote } from "@/lib/draft-cards";

const SAMPLE = `medications:
metformin 1000 2/ day
amlodipine benazepril 10 mg -20 mg 1/day
ezetimibe 10 mg 1/day
rosuvastatin`;

const MISSPELLED_SAMPLE = `metfromin 1000 2/ day
amlodapine benezepril 10 mg -20 mg 1/day
ezetimbe 10 mg 1/day
rosuvistatin`;

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
