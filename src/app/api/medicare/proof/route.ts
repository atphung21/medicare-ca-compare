import { CompareRequestSchema, PlanCategorySchema } from "@/schemas/medicare";
import { captureMedicareProof } from "@/services/medicare-agent";
import { NextResponse } from "next/server";
import { z } from "zod";

const ProofRequestSchema = CompareRequestSchema.extend({
  contractId: z.string().optional(),
  planId: z.string().optional(),
  proofId: z.string().optional(),
  planTypeFilter: PlanCategorySchema.optional(),
  pauseForMissing: z.boolean().optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = ProofRequestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Check the form and try again.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const result = await captureMedicareProof(parsed.data);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Medicare.gov proof could not be captured.";
    return NextResponse.json(
      { ok: false, error: `${message} The sample comparison is still available.` },
      { status: 422 },
    );
  }
}
