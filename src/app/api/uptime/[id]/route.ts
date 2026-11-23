import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { summarize, UptimeError, validateCheck } from "@/lib/uptime";

type Params = { params: Promise<{ id: string }> };
const RANGES: Record<string, number> = { "1h": 3600_000, "24h": 86400_000, "7d": 7 * 86400_000, "14d": 14 * 86400_000 };
const notFound = () => NextResponse.json({ error: "Uptime check not found" }, { status: 404 });

/** A check with its response times over the range (default 24h) and its recent incidents. */
export async function GET(request: Request, { params }: Params) {
  const gate = await requireUser("monitoring.view");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const check = await prisma.uptimeCheck.findUnique({ where: { id } });
  if (!check) return notFound();
  const range = new URL(request.url).searchParams.get("range") ?? "24h";
  const since = new Date(Date.now() - (RANGES[range] ?? RANGES["24h"]));
  const [results, incidents, sums] = await Promise.all([
    prisma.uptimeResult.findMany({ where: { checkId: id, at: { gte: since } }, orderBy: { at: "asc" }, select: { at: true, ok: true, latencyMs: true, statusCode: true, error: true } }),
    prisma.uptimeIncident.findMany({ where: { checkId: id }, orderBy: { startedAt: "desc" }, take: 20 }),
    summarize([check]),
  ]);
  const up = results.filter((r) => r.ok);
  const lat = up.map((r) => r.latencyMs ?? 0).sort((a, b) => a - b);
  return NextResponse.json({
    ...check,
    ...sums.get(id),
    range,
    results,
    incidents,
    stats: {
      checks: results.length,
      uptime: results.length ? Math.round((up.length / results.length) * 10000) / 100 : null,
      avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      p95LatencyMs: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
    },
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const gate = await requireUser("uptime.manage");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const existing = await prisma.uptimeCheck.findUnique({ where: { id } });
  if (!existing) return notFound();
  let data;
  try {
    data = validateCheck(await readJson(request), existing);
  } catch (err) {
    if (err instanceof UptimeError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  const retarget = data.target !== existing.target || data.type !== existing.type;
  const check = await prisma.uptimeCheck.update({
    where: { id },
    data: { ...data, nextCheckAt: new Date(), ...(retarget ? { certCheckedAt: null, certExpiresAt: null, certWarned: false } : {}) },
  });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "uptime.update", targetType: "uptime_check", targetId: id, message: `${gate.user.email} changed uptime check ${check.name}` });
  return NextResponse.json(check);
}

export async function DELETE(request: Request, { params }: Params) {
  const gate = await requireUser("uptime.manage");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const check = await prisma.uptimeCheck.findUnique({ where: { id } });
  if (!check) return notFound();
  await prisma.uptimeCheck.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "uptime.delete", targetType: "uptime_check", targetId: id, message: `${gate.user.email} removed uptime check ${check.name}` });
  return NextResponse.json({ success: true });
}
