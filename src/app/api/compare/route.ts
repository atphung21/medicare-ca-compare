import { CompareRequestSchema } from "@/schemas/medicare";
import { compareCaliforniaPlans } from "@/services/medicare-compare";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = CompareRequestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Check the form and try again.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const plans = compareCaliforniaPlans(parsed.data);
    return NextResponse.json({
      sample: true,
      countyName: parsed.data.countyName,
      zipCode: parsed.data.zipCode,
      plans,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not build the comparison.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
