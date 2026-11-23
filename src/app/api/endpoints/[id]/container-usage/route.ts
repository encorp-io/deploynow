import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { endpointGate } from "@/lib/endpointRoute";
import { can } from "@/lib/rbac";
import { parseRange, readHistory } from "@/lib/containerMetrics";

/** Usage summary of every container on the endpoint over a range, busiest first: ?range=1h|6h|24h|7d|30d */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.view");
  if (!gate.ok) return gate.response;
  const range = parseRange(new URL(request.url).searchParams.get("range"));
  const h = await readHistory({ endpointId: id }, range);
  const appIds = [...new Set(h.series.filter((s) => s.key.startsWith("app:")).map((s) => s.key.split(":")[1]))];
  const apps = await prisma.application.findMany({ where: { id: { in: appIds } }, select: { id: true, name: true, environment: { select: { projectId: true } } } });
  const appById = new Map(apps.map((a) => [a.id, a]));
  const rows = h.series
    .map((s) => {
      const appId = s.key.startsWith("app:") ? s.key.split(":")[1] : "";
      const app = appById.get(appId);
      const visible = !app || can(gate.ctx.user, "project.view", { projectId: app.environment.projectId });
      return { key: s.key, container: s.container, service: s.service, app: app && visible ? { id: app.id, name: app.name } : null, ...s.summary };
    })
    .sort((a, b) => b.cpuAvg - a.cpuAvg);
  return NextResponse.json({ range: h.range, from: h.from, to: h.to, containers: rows });
}
