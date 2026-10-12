import { extractMedications, visionProvider } from "@/services/med-extract";
import { NextResponse } from "next/server";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);

export async function GET() {
  const provider = visionProvider();
  return NextResponse.json({
    available: Boolean(provider),
    provider,
    message: provider
      ? null
      : "Pill-bottle intake needs OPENAI_API_KEY or GEMINI_API_KEY. The manual drug form still works.",
  });
}

export async function POST(request: Request) {
  if (!visionProvider()) {
    return NextResponse.json(
      { error: "Pill-bottle intake needs OPENAI_API_KEY or GEMINI_API_KEY. The manual drug form still works." },
      { status: 503 },
    );
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose an image or PDF." }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json({ error: "Use a JPEG, PNG, WEBP, GIF, or PDF." }, { status: 400 });
  }
  if (file.size > 8_000_000) {
    return NextResponse.json({ error: "That file is larger than 8 MB." }, { status: 400 });
  }
  try {
    const medications = await extractMedications(Buffer.from(await file.arrayBuffer()), file.type);
    return NextResponse.json({ medications });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read that file.";
    const status = message.includes("needs") ? 503 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
