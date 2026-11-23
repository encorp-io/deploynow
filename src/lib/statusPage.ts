import { prisma } from "./prisma";
import { summarize } from "./uptime";

export interface PublicStatus {
  title: string;
  overall: "up" | "degraded" | "down" | "unknown";
  updatedAt: string;
  checks: { id: string; name: string; status: string; uptime90d: number | null; days: { day: string; up: number; total: number }[] }[];
  incidents: { name: string; startedAt: string; endedAt: string | null }[];
}

/** What the public status page shows, or null when it's off. */
export async function publicStatus(now = new Date()): Promise<PublicStatus | null> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!s?.statusPageEnabled) return null;
  const checks = await prisma.uptimeCheck.findMany({ where: { public: true, enabled: true }, orderBy: { name: "asc" } });
  const sums = await summarize(checks, 90, now);
  const incidents = checks.length
    ? await prisma.uptimeIncident.findMany({ where: { checkId: { in: checks.map((c) => c.id) }, startedAt: { gte: new Date(now.getTime() - 14 * 86400_000) } }, orderBy: { startedAt: "desc" }, take: 20 })
    : [];
  const names = new Map(checks.map((c) => [c.id, c.name]));
  const down = checks.filter((c) => c.status === "down").length;
  return {
    title: s.statusPageTitle || "Status",
    overall: !checks.length ? "unknown" : down === 0 ? "up" : down === checks.length ? "down" : "degraded",
    updatedAt: now.toISOString(),
    checks: checks.map((c) => {
      const sum = sums.get(c.id)!;
      return { id: c.id, name: c.name, status: c.status, uptime90d: sum.uptime90d, days: sum.series.map((d) => ({ day: d.day, up: d.up, total: d.total })) };
    }),
    incidents: incidents.map((i) => ({ name: names.get(i.checkId) ?? "", startedAt: i.startedAt.toISOString(), endedAt: i.endedAt?.toISOString() ?? null })),
  };
}
