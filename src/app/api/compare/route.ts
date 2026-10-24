import { stateForFips } from "@/lib/us-location";
import { CompareRequestSchema } from "@/schemas/medicare";
import { lisSchedule, partDCap } from "@/services/lis";
import { compareSamplePlans } from "@/services/medicare-compare";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = CompareRequestSchema.safeParse(body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Check the form and try again.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const state = parsed.data.state ?? (stateForFips(parsed.data.countyFips) || undefined);
    const plans = compareSamplePlans({ ...parsed.data, state });
    const lis = lisSchedule(parsed.data.contractYear, parsed.data.lisLevel);
    return NextResponse.json({
      sample: true,
      countyName: parsed.data.countyName,
      state,
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
