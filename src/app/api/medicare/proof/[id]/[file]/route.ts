import { readFile } from "node:fs/promises";
import path from "node:path";
import { proofDirectory } from "@/services/medicare-agent";
import { NextResponse } from "next/server";

const ALLOWED = /^(summary\.png|drugs\.png|pharmacies\.png|providers\.png|failure\.png|missing-\d+\.png|page\.pdf|meta\.json|[A-Za-z0-9]+-[A-Za-z0-9]+\.png)$/;

export async function GET(_request: Request, context: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await context.params;
  if (!ALLOWED.test(file)) {
    return NextResponse.json({ error: "Unknown proof file." }, { status: 404 });
  }
  try {
    const dir = proofDirectory(id);
    const fullPath = path.join(dir, file);
    if (path.dirname(fullPath) !== dir) {
      return NextResponse.json({ error: "Unknown proof file." }, { status: 404 });
    }
    const body = await readFile(fullPath);
    const type = file.endsWith(".pdf") ? "application/pdf" : file.endsWith(".json") ? "application/json" : "image/png";
    return new NextResponse(new Uint8Array(body), { headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" } });
  } catch {
    return NextResponse.json({ error: "That proof file is not on this machine." }, { status: 404 });
  }
}
