import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { parseMetrics } from "@/lib/endpoints";
import { usage } from "@/lib/monitor";
import { can } from "@/lib/rbac";
import { hostTrends } from "@/lib/usageSummary";

const HOUR = 3600_000;

/** Active alerts, recently resolved ones, and each endpoint's latest host metrics. */
export async function GET() {
  const gate = await requireUser("monitoring.view");
  if (!gate.ok) return gate.response;
  const [active, resolved, endpoints] = await Promise.all([
    prisma.alert.findMany({ where: { resolvedAt: null }, orderBy: { firedAt: "desc" } }),
    prisma.alert.findMany({ where: { resolvedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } }, orderBy: { resolvedAt: "desc" }, take: 50 }),
    prisma.endpoint.findMany({ orderBy: { name: "asc" } }),
  ]);
  const visible = endpoints.filter((e) => can(gate.user, "endpoint.view", { endpointId: e.id }));
  // Hourly CPU and memory over the last 24 hours for the sparklines
  const from = Math.floor((Date.now() - 24 * HOUR) / HOUR) * HOUR + HOUR;
  const samples = visible.length
    ? await prisma.metricSample.findMany({
        where: { endpointId: { in: visible.map((e) => e.id) }, at: { gte: new Date(from) } },
        select: { endpointId: true, at: true, cpus: true, load1: true, memTotal: true, memUsed: true },
      })
    : [];
  const trends = hostTrends(samples, from, HOUR, 24);
  return NextResponse.json({
    active,
    resolved,
    endpoints: visible.map((e) => {
      const m = parseMetrics(e.hostMetrics);
      const t = trends.endpoints.get(e.id);
      return { id: e.id, name: e.name, type: e.type, status: e.status, containers: e.containers, metrics: m, metricsAt: e.hostMetricsAt, usage: m ? usage(m) : null, trend: { cpu: t?.cpu ?? [], mem: t?.mem ?? [] } };
    }),
    fleet: { cpu: trends.fleet.cpu, mem: trends.fleet.mem },
  });
}
