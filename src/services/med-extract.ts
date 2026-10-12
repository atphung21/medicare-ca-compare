import { z } from "zod";
import { coarseDosageForm, type DosageForm } from "@/schemas/medicare";
import { resolveDrugDosageForms, type DrugResolutionResult } from "@/services/rxnorm-resolver";

const ExtractedMedicationSchema = z.object({
  name: z.string().trim().min(2),
  strength: z.string().trim().min(1),
  dosageForm: z.string().trim().optional(),
  quantityPerFill: z.number().int().min(1).max(1000).optional(),
  refillFrequencyMonths: z.enum(["1", "3"]).optional(),
});

const ExtractedListSchema = z.object({
  medications: z.array(ExtractedMedicationSchema).min(1).max(15),
});

export interface ExtractedDrug {
  name: string;
  strength: string;
  dosageForm: DosageForm;
  dosageFormLabel?: string;
  quantityPerFill: number;
  refillFrequencyMonths: "1" | "3";
  resolution: DrugResolutionResult;
}

export function visionProvider() {
  if (process.env.OPENAI_API_KEY) return "openai" as const;
  if (process.env.GEMINI_API_KEY) return "gemini" as const;
  return null;
}

export async function extractMedications(bytes: Buffer, mimeType: string): Promise<ExtractedDrug[]> {
  const provider = visionProvider();
  if (!provider) {
    throw new Error("Pill-bottle intake needs OPENAI_API_KEY or GEMINI_API_KEY. The manual drug form still works.");
  }
  if (mimeType === "application/pdf" && provider === "openai") {
    throw new Error("PDF intake needs GEMINI_API_KEY. A photo works with the OpenAI key, and the manual form still works.");
  }
  const raw = provider === "openai" ? await extractWithOpenAI(bytes, mimeType) : await extractWithGemini(bytes, mimeType);
  const parsed = ExtractedListSchema.parse(raw);
  const medications: ExtractedDrug[] = [];
  for (const item of parsed.medications) {
    const query = [item.name, item.strength, item.dosageForm].filter(Boolean).join(" ");
    const resolution = await resolveDrugDosageForms(query);
    const locked = resolution.selectedVariant;
    medications.push({
      name: item.name,
      strength: item.strength,
      dosageForm: locked?.coarseForm ?? coarseDosageForm(item.dosageForm ?? "tablet"),
      dosageFormLabel: locked?.dosageForm ?? item.dosageForm,
      quantityPerFill: item.quantityPerFill ?? 30,
      refillFrequencyMonths: item.refillFrequencyMonths ?? "1",
      resolution,
    });
  }
  return medications;
}

async function extractWithOpenAI(bytes: Buffer, mimeType: string) {
  const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: extractionPrompt() },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the medications in this image." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error("The vision model could not read that file.");
  }
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  return JSON.parse(text);
}

async function extractWithGemini(bytes: Buffer, mimeType: string) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: extractionPrompt() },
              { inline_data: { mime_type: mimeType, data: bytes.toString("base64") } },
            ],
          },
        ],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    },
  );
  if (!response.ok) {
    throw new Error("The vision model could not read that file.");
  }
  const body = await response.json();
  const text = body?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
  return JSON.parse(text);
}

function extractionPrompt() {
  return `Extract prescription medications from this pill bottle photo, label, or medication list.
Return JSON only: {"medications":[{"name":"string","strength":"string","dosageForm":"string","quantityPerFill":30,"refillFrequencyMonths":"1"}]}.
refillFrequencyMonths is "1" for a 30-day fill and "3" for a 90-day fill.
Do not guess a dosage form that is not printed. Omit dosageForm when the label does not show one.
Do not invent drugs that are not visible.`;
}
