import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";

/**
 * GET /api/health: public liveness and readiness for Docker HEALTHCHECK, load
 * balancers and uptime monitors. Reveals only the version and whether the
 * database answers.
 */
export async function GET() {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return NextResponse.json({ ok: true, version: VERSION }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, version: VERSION, error: "database unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
