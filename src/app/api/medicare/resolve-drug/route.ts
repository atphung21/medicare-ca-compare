import { resolveDrugDosageForms } from "@/services/rxnorm-resolver";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const query = body?.query;
  if (!query || typeof query !== "string") {
    return NextResponse.json({ error: "Query string required" }, { status: 400 });
  }
  try {
    const resolution = await resolveDrugDosageForms(query);
    return NextResponse.json(resolution);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve drug forms";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
