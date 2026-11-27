import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import { parseMetrics } from "@/lib/endpoints";
import { usage } from "@/lib/monitor";
import { visibleProjectFilter } from "@/lib/apps/access";
import { readHistory } from "@/lib/containerMetrics";
import { appsOf, hostTrends } from "@/lib/usageSummary";
import { readLog } from "@/lib/deploy/log";

const HOUR = 3600_000;
const TREND_HOURS = 24;
const LOG_LINES = 14;
/** Host snapshots older than this (machine offline, probing stopped) are not current usage. */
const HOST_FRESH = 10 * 60_000; // same window as /api/metrics

/**
 * Everything the Overview page shows, limited to what the user may see:
 * machines with their load, apps, the busiest apps right now, recent
 * deployments (with the tail of the latest log), backups and alerts.
 */
export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  const now = Date.now();

  // Machines
  const allEndpoints = await prisma.endpoint.findMany({ orderBy: { name: "asc" } });
  const endpoints = allEndpoints.filter((e) => can(user, "endpoint.view", { endpointId: e.id }));
  const from = Math.floor((now - TREND_HOURS * HOUR) / HOUR) * HOUR + HOUR;
  const samples = endpoints.length
    ? await prisma.metricSample.findMany({
        where: { endpointId: { in: endpoints.map((e) => e.id) }, at: { gte: new Date(from) } },
        select: { endpointId: true, at: true, cpus: true, load1: true, memTotal: true, memUsed: true },
      })
    : [];
  const trends = hostTrends(samples, from, HOUR, TREND_HOURS);
  const current = (e: (typeof endpoints)[number]) =>
    e.status === "online" && e.hostMetricsAt && now - e.hostMetricsAt.getTime() < HOST_FRESH ? parseMetrics(e.hostMetrics) : null;
  const machines = endpoints.map((e) => {
    const m = current(e);
    const u = m ? usage(m) : null;
    return {
      id: e.id,
      name: e.name,
      type: e.type,
      status: e.status,
      containers: e.containers,
      labels: e.labels,
      cpu: m && m.cpus ? Math.min(100, Math.round((m.load1 / m.cpus) * 100)) : null,
      mem: u?.mem ?? null,
      disk: u?.disk ?? null,
      cpus: m?.cpus ?? e.cpus,
      memTotal: m?.memTotal ?? e.memoryBytes,
      trend: trends.endpoints.get(e.id)?.cpu ?? [],
    };
  });
  const measured = endpoints.map(current).filter((m): m is NonNullable<typeof m> => !!m && m.memTotal > 0);
  const sum = (f: (m: (typeof measured)[number]) => number) => measured.reduce((s, m) => s + f(m), 0);
  const fleet = {
    online: endpoints.filter((e) => e.status === "online").length,
    total: endpoints.length,
    containers: endpoints.reduce((s, e) => s + e.containers, 0),
    cpu: sum((m) => m.cpus) ? Math.min(100, Math.round((sum((m) => m.load1) / sum((m) => m.cpus)) * 100)) : null,
    memUsed: sum((m) => m.memTotal - m.memAvailable),
    memTotal: sum((m) => m.memTotal),
    cpuTrend: trends.fleet.cpu,
    memTrend: trends.fleet.mem,
  };

  // Apps
  const apps = await prisma.application.findMany({
    where: { environment: { project: visibleProjectFilter(user) } },
    select: { id: true, name: true, status: true, previewOfId: true, environment: { select: { name: true, project: { select: { id: true, name: true } } } } },
  });
  const byStatus: Record<string, number> = {};
  for (const a of apps) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  const projects = await prisma.project.count({ where: visibleProjectFilter(user) });
  const usageH = apps.length ? await readHistory({ applicationId: { in: apps.map((a) => a.id) } }, "1h", now) : null;
  const usageByApp = usageH ? appsOf(usageH, now) : new Map();
  const appById = new Map(apps.map((a) => [a.id, a]));
  const topApps = [...usageByApp.values()]
    .filter((u) => u.now)
    .sort((a, b) => b.now!.cpu - a.now!.cpu || b.now!.mem - a.now!.mem)
    .slice(0, 6)
    .map((u) => {
      const a = appById.get(u.appId)!;
      return { id: a.id, name: a.name, project: a.environment.project, environment: a.environment.name, services: u.services.length, now: u.now, trend: u.trend };
    });
  // Containers of all apps added up, per minute over the last hour
  const appsCpuTrend = (() => {
    const list = [...usageByApp.values()];
    if (!list.length) return [];
    return list[0].trend.map((_: number, i: number) => Math.round(list.reduce((s, u) => s + (u.trend[i] ?? 0), 0) * 100) / 100);
  })();

  // Deployments
  const deployments = await prisma.deployment.findMany({
    where: { application: { environment: { project: visibleProjectFilter(user) } } },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      id: true,
      status: true,
      trigger: true,
      commitSha: true,
      createdAt: true,
      finishedAt: true,
      startedByEmail: true,
      application: { select: { id: true, name: true, environment: { select: { name: true, project: { select: { id: true, name: true } } } } } },
    },
  });
  const live = deployments.find((d) => d.status === "running" || d.status === "queued") ?? deployments[0];
  let log: { deploymentId: string; lines: string[] } | null = null;
  if (live && can(user, "app.logs", { projectId: live.application.environment.project.id })) {
    try {
      const text = readLog(live.id).text;
      log = { deploymentId: live.id, lines: text.split("\n").filter(Boolean).slice(-LOG_LINES) };
    } catch {
      log = { deploymentId: live.id, lines: [] };
    }
  }

  // Backups
  let backups: { last: { status: string; at: string; bytes: number } | null; ok7d: number; failed7d: number; days: number[] } | null = null;
  if (can(user, "backup.view")) {
    const week = new Date(now - 7 * 24 * HOUR);
    const runs = await prisma.backupRun.findMany({ where: { kind: "backup", createdAt: { gte: week } }, select: { status: true, createdAt: true, finishedAt: true, bytes: true }, orderBy: { createdAt: "desc" } });
    const last = runs.find((r) => r.status === "success" || r.status === "failed") ?? (await prisma.backupRun.findFirst({ where: { kind: "backup", status: { in: ["success", "failed"] } }, orderBy: { createdAt: "desc" } }));
    const days = Array.from({ length: 7 }, (_, i) => {
      const start = now - (7 - i) * 24 * HOUR;
      return runs.filter((r) => r.status === "success" && r.createdAt.getTime() >= start && r.createdAt.getTime() < start + 24 * HOUR).length;
    });
    backups = {
      last: last ? { status: last.status, at: (last.finishedAt ?? last.createdAt).toISOString(), bytes: last.bytes } : null,
      ok7d: runs.filter((r) => r.status === "success").length,
      failed7d: runs.filter((r) => r.status === "failed").length,
      days,
    };
  }

  // Alerts
  const alerts = can(user, "monitoring.view") ? await prisma.alert.findMany({ where: { resolvedAt: null }, orderBy: { firedAt: "desc" }, take: 5 }) : [];
  const visibleAlerts = alerts.filter((a) => !a.endpointId || can(user, "endpoint.view", { endpointId: a.endpointId }));

  return NextResponse.json({
    at: new Date(now).toISOString(),
    fleet,
    machines,
    apps: { total: apps.length, previews: apps.filter((a) => a.previewOfId).length, projects, byStatus, cpuTrend: appsCpuTrend },
    topApps,
    deployments: deployments.map((d) => ({
      id: d.id,
      status: d.status,
      trigger: d.trigger,
      commitSha: d.commitSha,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt,
      startedBy: d.startedByEmail,
      app: { id: d.application.id, name: d.application.name },
      project: d.application.environment.project,
      environment: d.application.environment.name,
    })),
    log,
    backups,
    alerts: visibleAlerts.map((a) => ({ id: a.id, kind: a.kind, message: a.message, firedAt: a.firedAt })),
  });
}
