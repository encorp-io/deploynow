import { NextResponse } from "next/server";
import { probeSignature } from "@/lib/platformDomain";

/**
 * Public: Settings → Domain calls https://<domain>/api/platform-domain/probe?n=…
 * from the server to prove the domain reaches this very instance.
 */
export async function GET(request: Request) {
  const n = new URL(request.url).searchParams.get("n") ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(n)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  return NextResponse.json({ sig: probeSignature(n) }, { headers: { "Cache-Control": "no-store" } });
}
