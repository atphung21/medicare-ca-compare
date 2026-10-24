import type { CheckedMedication } from "@/lib/draft-cards";
import { LisLevelSchema, PlanCategorySchema } from "@/schemas/medicare";
import { runAgent } from "@/services/assistant/run-agent";
import { EMPTY_SESSION, type AssistantSession } from "@/services/assistant/session";
import { NextResponse } from "next/server";
import { z } from "zod";

const SessionSchema = z.object({
  zipCode: z.string().regex(/^\d{5}$/).nullable(),
  county: z.object({ fips: z.string(), name: z.string(), state: z.string() }).nullable(),
  contractYear: z.enum(["2026", "2027"]),
  lisLevel: LisLevelSchema,
  planType: PlanCategorySchema,
  pharmacyIds: z.array(z.string()).max(6),
  medications: z.array(z.custom<CheckedMedication>((value) => typeof value === "object" && value !== null && "drug" in value)).max(40),
});

const BodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(12000),
        events: z.array(z.object({ summary: z.string() }).passthrough()).optional(),
      }),
    )
    .min(1)
    .max(60),
  session: SessionSchema.optional(),
});

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "The assistant needs GEMINI_API_KEY in .env.local. The comparison page still works without it." },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "That message could not be read. Start a new chat and try again." }, { status: 400 });
  }
  const session: AssistantSession = structuredClone(parsed.data.session ?? EMPTY_SESSION);
  try {
    const result = await runAgent(parsed.data.messages as Parameters<typeof runAgent>[0], session);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The assistant could not answer.";
    return NextResponse.json({ error: message, session }, { status: 502 });
  }
}
