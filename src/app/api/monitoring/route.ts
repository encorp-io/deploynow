import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { parseMetrics } from "@/lib/endpoints";
import { usage } from "@/lib/monitor";

/** Active alerts, recently resolved ones, and each endpoint's latest host metrics. */
export async function GET() {
  const gate = await requireUser("monitoring.view");
  if (!gate.ok) return gate.response;
  const [active, resolved, endpoints] = await Promise.all([
    prisma.alert.findMany({ where: { resolvedAt: null }, orderBy: { firedAt: "desc" } }),
    prisma.alert.findMany({ where: { resolvedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } }, orderBy: { resolvedAt: "desc" }, take: 50 }),
    prisma.endpoint.findMany({ orderBy: { name: "asc" } }),
  ]);
  return NextResponse.json({
    active,
    resolved,
    endpoints: endpoints.map((e) => {
      const m = parseMetrics(e.hostMetrics);
      return { id: e.id, name: e.name, type: e.type, status: e.status, containers: e.containers, metrics: m, metricsAt: e.hostMetricsAt, usage: m ? usage(m) : null };
    }),
  });
}
