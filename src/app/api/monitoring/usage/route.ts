import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import { parseRange, readHistory } from "@/lib/containerMetrics";
import { appsOf, unmanagedOf } from "@/lib/usageSummary";

/**
 * Resource usage of every app the user may see, per service and in total, plus
 * containers DeployNow did not deploy: ?range=1h|6h|24h|7d|30d (default 1h).
 */
export async function GET(request: Request) {
  const gate = await requireUser("monitoring.view");
  if (!gate.ok) return gate.response;
  const url = new URL(request.url);
  const range = url.searchParams.has("range") ? parseRange(url.searchParams.get("range")) : "1h";
  const now = Date.now();
  const h = await readHistory({}, range, now);

  const byApp = appsOf(h, now);
  const appRows = await prisma.application.findMany({
    where: { id: { in: [...byApp.keys()] } },
    select: {
      id: true,
      name: true,
      status: true,
      endpoint: { select: { id: true, name: true } },
      environment: { select: { name: true, project: { select: { id: true, name: true } } } },
    },
  });
  const endpoints = await prisma.endpoint.findMany({ select: { id: true, name: true } });
  const endpointName = new Map(endpoints.map((e) => [e.id, e.name]));

  const apps = appRows
    .filter((a) => can(gate.user, "project.view", { projectId: a.environment.project.id }))
    .map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      endpoint: a.endpoint,
      environment: a.environment.name,
      project: a.environment.project,
      usage: byApp.get(a.id)!,
    }))
    .sort((a, b) => (b.usage.now?.cpu ?? 0) - (a.usage.now?.cpu ?? 0) || b.usage.avg.cpu - a.usage.avg.cpu);

  const unmanaged = unmanagedOf(h, now)
    .filter((s) => can(gate.user, "endpoint.view", { endpointId: s.endpointId }))
    .map((s) => ({ ...s, endpointName: endpointName.get(s.endpointId) ?? "" }));

  return NextResponse.json({ range: h.range, from: h.from, to: h.to, bucketSeconds: h.bucketSeconds, apps, unmanaged });
}
