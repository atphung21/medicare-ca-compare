import { NextResponse } from "next/server";
import { z } from "zod";
import { parseMedicationList } from "@/services/med-list-parser";

const bodySchema = z.object({
  text: z.string().min(1).max(8000),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Paste a medication list first." }, { status: 400 });
  }
  const drafts = await parseMedicationList(parsed.data.text);
  if (drafts.length === 0) {
    return NextResponse.json({ ok: false, error: "No medications were found in that note." }, { status: 422 });
  }
  return NextResponse.json({ ok: true, drafts });
}
