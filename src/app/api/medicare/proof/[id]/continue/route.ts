import { continueMedicareProof } from "@/services/medicare-agent";
import { NextResponse } from "next/server";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const result = await continueMedicareProof(id);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Medicare.gov proof could not finish.";
    return NextResponse.json({ ok: false, proofId: id, error: message }, { status: 422 });
  }
}
