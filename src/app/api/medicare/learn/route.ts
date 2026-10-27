import { NextResponse } from "next/server";
import { z } from "zod";
import { knowledgeSharingConfigured } from "@/services/assistant/knowledge-sync";
import { confirmLineFixes, saveLineFix, setOtc } from "@/services/assistant/memory";
import { medicationLineKey } from "@/services/med-line-normalizer";
import { parseTypedLine } from "@/services/med-list-parser";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("line"),
    rawLine: z.string().trim().min(2).max(500),
    /** How the line should be read, one drug per ";". Empty means it is not a medication. */
    reading: z.string().trim().max(500),
  }),
  z.object({
    kind: z.literal("otc"),
    name: z.string().trim().min(2).max(120),
    otc: z.boolean(),
  }),
  z.object({
    kind: z.literal("confirm"),
    ids: z.array(z.string().min(4).max(64)).min(1).max(50),
  }),
]);

function sharing(shared: boolean) {
  if (shared) return "Saved for the team.";
  return knowledgeSharingConfigured()
    ? "Saved on this computer; it will be shared once online."
    : "Saved on this computer only (no KNOWLEDGE_TOKEN).";
}

/** Saves a correction from the comparison page to team memory, so every computer reads the line the same way next time. */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "That correction is incomplete." }, { status: 400 });
  }
  const body = parsed.data;
  try {
    if (body.kind === "line") {
      const { shared } = await saveLineFix(medicationLineKey(body.rawLine), body.rawLine, body.reading);
      const drafts = body.reading ? await parseTypedLine(body.rawLine) : [];
      return NextResponse.json({ ok: true, drafts, message: sharing(shared) });
    }
    if (body.kind === "otc") {
      const { shared } = await setOtc(body.name, body.otc);
      return NextResponse.json({ ok: true, message: sharing(shared) });
    }
    const { value, shared } = await confirmLineFixes(body.ids);
    return NextResponse.json({ ok: true, confirmed: value, message: sharing(shared) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: `Could not save: ${message}` }, { status: 500 });
  }
}
