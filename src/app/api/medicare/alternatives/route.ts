import { therapeuticAlternatives } from "@/services/rxclass";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const rxcui = body?.rxcui;
  if (!rxcui || typeof rxcui !== "string") {
    return NextResponse.json({ error: "RxCUI is required" }, { status: 400 });
  }
  try {
    const alternatives = await therapeuticAlternatives(rxcui);
    return NextResponse.json({ rxcui, alternatives });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load therapeutic alternatives.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
