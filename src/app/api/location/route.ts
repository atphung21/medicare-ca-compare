import { lookupZip } from "@/lib/us-location";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const zipCode = new URL(request.url).searchParams.get("zip") ?? "";
  if (!/^\d{5}$/.test(zipCode)) {
    return NextResponse.json({ error: "Enter a 5-digit ZIP code." }, { status: 400 });
  }
  const location = await lookupZip(zipCode);
  if (!location) {
    return NextResponse.json({ error: `${zipCode} is not a known US ZIP code.` }, { status: 404 });
  }
  return NextResponse.json(location, {
    headers: { "Cache-Control": "public, max-age=86400" },
  });
}
