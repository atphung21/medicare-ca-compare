import { CompareRequestSchema } from "@/schemas/medicare";
import { lisSchedule, partDCap } from "@/services/lis";
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
    const lis = lisSchedule(parsed.data.contractYear, parsed.data.lisLevel);
    return NextResponse.json({
      sample: true,
      countyName: parsed.data.countyName,
      zipCode: parsed.data.zipCode,
      contractYear: parsed.data.contractYear,
      partDCap: partDCap(parsed.data.contractYear),
      lis,
      plans,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not build the comparison.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
