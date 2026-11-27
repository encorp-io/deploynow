"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle, ChevronRight, Search } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Card, ErrorText, Input, PageHeader, PageSkeleton, Select, Tabs, formatBytes, formatTime, stateTone, timeAgo } from "@/components/ui";
import { AppServicesUsage, Meter, Sparkline, StatTile, UsageCells, fmtCpu, fmtRate, serviceLabel, type AppUsage, type ServiceUsage, type UsageAvg, type UsageNow } from "@/components/usage";

interface Alert {
  id: string;
  key: string;
  kind: string;
  endpointId: string;
  message: string;
  firedAt: string;
  resolvedAt: string | null;
}
interface EndpointRow {
  id: string;
  name: string;
  type: string;
  status: string;
  containers: number;
  metrics: { cpus: number; load1: number; memTotal: number; memAvailable: number; diskTotal: number; diskFree: number; diskPath: string } | null;
  metricsAt: string | null;
  usage: { disk: number; mem: number } | null;
  trend: { cpu: number[]; mem: number[] };
}
interface MonitoringData { active: Alert[]; resolved: Alert[]; endpoints: EndpointRow[]; fleet: { cpu: number[]; mem: number[] } }
interface AppRow { id: string; name: string; status: string; endpoint: { id: string; name: string }; environment: string; project: { id: string; name: string }; usage: AppUsage }
interface UsageData { range: string; apps: AppRow[]; unmanaged: (ServiceUsage & { endpointName: string })[] }

const KIND_LABEL: Record<string, string> = {
  disk: "Disk",
  memory: "Memory",
  crash_loop: "Crash loop",
  agent_offline: "Agent offline",
  backup_failed: "Backup",
  drill_failed: "Restore drill",
  task_failed: "Task",
  deploy_failed: "Deploy",
};

const VIEWS = [
  { value: "now", label: "Now" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
] as const;
type View = (typeof VIEWS)[number]["value"];
const TREND_LABEL: Record<View, string> = { now: "last hour", "1h": "last hour", "24h": "last 24 h", "7d": "last 7 days", "30d": "last 30 days" };

type Sort = "cpu" | "mem" | "name";

function HostCard({ e }: { e: EndpointRow }) {
  const cpuPct = e.metrics?.cpus ? (e.metrics.load1 / e.metrics.cpus) * 100 : 0;
  return (
    <Card className="p-4 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-3">
        <Link href={`/endpoints/${e.id}`} className="text-sm font-medium text-text-primary hover:text-accent truncate">{e.name}</Link>
        <Badge tone={stateTone(e.status)}>{e.status}</Badge>
      </div>
      {e.metrics && e.usage ? (
        <div className="space-y-3 text-xs">
          <div>
            <div className="flex justify-between text-text-secondary mb-1"><span>CPU load</span><span className="tabular-nums">{Math.round(cpuPct)}% · {e.metrics.load1.toFixed(2)} on {e.metrics.cpus} CPU</span></div>
            <Meter pct={cpuPct} />
          </div>
          <div>
            <div className="flex justify-between text-text-secondary mb-1"><span>Memory</span><span className="tabular-nums">{e.usage.mem}% of {formatBytes(e.metrics.memTotal)}</span></div>
            <Meter pct={e.usage.mem} tone="violet" />
          </div>
          <div>
            <div className="flex justify-between text-text-secondary mb-1"><span>Disk {e.metrics.diskPath}</span><span className="tabular-nums">{formatBytes(e.metrics.diskFree)} free</span></div>
            <Meter pct={e.usage.disk} />
          </div>
          {e.trend.cpu.length > 1 && (
            <div className="pt-1">
              <div className="flex justify-between text-[10.5px] uppercase tracking-[0.1em] text-text-muted mb-1"><span>Last 24 h</span><span><span className="text-accent-soft">CPU</span> · <span className="text-[#a78bfa]">memory</span></span></div>
              <div className="relative h-9">
                <Sparkline values={e.trend.mem} max={100} tone="violet" className="absolute inset-0 h-9" fill={false} />
                <Sparkline values={e.trend.cpu} max={100} tone="sky" className="absolute inset-0 h-9" />
              </div>
            </div>
          )}
          <p className="text-text-muted">{e.containers} containers · measured {timeAgo(e.metricsAt)}</p>
        </div>
      ) : (
        <p className="text-xs text-text-muted">{e.status === "online" ? "No measurements yet; they arrive within five minutes." : "Offline"}</p>
      )}
    </Card>
  );
}

function Peak({ avg }: { avg: UsageAvg }) {
  return (
    <span className="block text-[10.5px] text-text-muted tabular-nums mt-0.5">peak {fmtCpu(avg.cpuMax)} · {formatBytes(avg.memMax)}</span>
  );
}

export default function MonitoringPage() {
  const api = useApi();
  const [data, setData] = useState<MonitoringData | null>(null);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [view, setView] = useState<View>("now");
  const [sort, setSort] = useState<Sort>("cpu");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await api<MonitoringData>("/api/monitoring");
    if (res.ok) setData(res.data as MonitoringData);
    else setError(res.data.error ?? "Could not load");
  }, [api]);

  const loadUsage = useCallback(async () => {
    const res = await api<UsageData>(`/api/monitoring/usage?range=${view === "now" ? "1h" : view}`);
    if (res.ok) setUsage(res.data as UsageData);
  }, [api, view]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    loadUsage();
    const t = setInterval(loadUsage, view === "now" || view === "1h" ? 20_000 : 120_000);
    return () => clearInterval(t);
  }, [loadUsage, view]);

  const mode = view === "now" ? "now" : "avg";
  const valueOf = useCallback((u: { now: UsageNow | null; avg: UsageAvg }) => (mode === "now" ? u.now : u.avg), [mode]);

  const apps = useMemo(() => {
    if (!usage) return [];
    const term = q.trim().toLowerCase();
    const list = usage.apps.filter((a) => !term || `${a.name} ${a.project.name} ${a.environment} ${a.endpoint.name} ${a.usage.services.map((s) => s.service).join(" ")}`.toLowerCase().includes(term));
    const v = (a: AppRow) => valueOf(a.usage);
    return [...list].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "mem" ? (v(b)?.mem ?? -1) - (v(a)?.mem ?? -1) : (v(b)?.cpu ?? -1) - (v(a)?.cpu ?? -1)));
  }, [usage, q, sort, valueOf]);

  const totals = useMemo(() => {
    const t = { cpu: 0, mem: 0, rx: 0, tx: 0, running: 0, services: 0 };
    for (const a of usage?.apps ?? []) {
      const u = valueOf(a.usage);
      t.services += a.usage.services.length;
      if (a.usage.now) t.running++;
      if (!u) continue;
      t.cpu += u.cpu;
      t.mem += u.mem;
      t.rx += u.rx;
      t.tx += u.tx;
    }
    return t;
  }, [usage, valueOf]);

  if (!data) return error ? <div className="max-w-6xl"><ErrorText>{error}</ErrorText></div> : <PageSkeleton rows={4} />;

  const online = data.endpoints.filter((e) => e.status === "online").length;
  const measured = data.endpoints.filter((e) => e.metrics && e.metrics.memTotal);
  const cpus = measured.reduce((s, e) => s + (e.metrics?.cpus ?? 0), 0);
  const load1 = measured.reduce((s, e) => s + (e.metrics?.load1 ?? 0), 0);
  const memTotal = measured.reduce((s, e) => s + (e.metrics?.memTotal ?? 0), 0);
  const memUsed = measured.reduce((s, e) => s + ((e.metrics?.memTotal ?? 0) - (e.metrics?.memAvailable ?? 0)), 0);
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="max-w-6xl">
      <PageHeader title="Monitoring" subtitle="Machines, apps and their services, and alerts. Alerts go to your notification channels when they start and when they clear." />
      <ErrorText>{error}</ErrorText>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatTile label="Active alerts" value={data.active.length} unit={data.active.length === 1 ? "alert" : "alerts"} sub={data.active.length ? data.active[0].message : "Nothing needs attention"} tone={data.active.length ? "danger" : "mint"} footer={<div className="h-7" />} />
        <StatTile label="Machines" value={online} unit={`/ ${data.endpoints.length} online`} sub={`${data.endpoints.reduce((s, e) => s + e.containers, 0)} containers`} trend={data.fleet.cpu} max={100} />
        <StatTile label="CPU" value={cpus ? Math.min(100, Math.round((load1 / cpus) * 100)) : "–"} unit={cpus ? `% of ${cpus} cores` : undefined} sub="load across machines, last 24 h" trend={data.fleet.cpu} max={100} tone="blue" />
        <StatTile label="Memory" value={memTotal ? Math.round((memUsed / memTotal) * 100) : "–"} unit={memTotal ? "% used" : undefined} sub={memTotal ? `${formatBytes(memUsed)} of ${formatBytes(memTotal)}` : "no measurements yet"} trend={data.fleet.mem} max={100} tone="violet" />
      </div>

      <div className="space-y-8">
        <section>
          <h2 className="text-sm font-semibold text-text-primary mb-2">Active alerts</h2>
          <Card className="overflow-hidden">
            {data.active.length === 0 ? (
              <p className="p-4 text-sm text-success flex items-center gap-2"><CheckCircle className="w-4 h-4" /> Nothing needs attention.</p>
            ) : (
              <div className="divide-y divide-border">
                {data.active.map((a) => (
                  <div key={a.id} className="p-3 flex items-center gap-3">
                    <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0" />
                    <Badge tone="danger">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                    <span className="text-sm text-text-primary flex-1">{a.message}</span>
                    <span className="text-xs text-text-muted">since {timeAgo(a.firedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-text-primary mb-2">Machines</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {data.endpoints.map((e) => <HostCard key={e.id} e={e} />)}
          </div>
        </section>

        <section>
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-3 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Apps and services</h2>
              <p className="text-xs text-text-muted mt-0.5">What every app and each of its services uses. Open an app to see its services.</p>
            </div>
            <Tabs tabs={VIEWS} value={view} onChange={setView} />
          </div>

          <div className="flex flex-col sm:flex-row gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by app, project, machine or service" className="!pl-9" aria-label="Filter apps" />
            </div>
            <div className="sm:w-48">
              <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort apps">
                <option value="cpu">Busiest CPU first</option>
                <option value="mem">Most memory first</option>
                <option value="name">By name</option>
              </Select>
            </div>
          </div>

          <Card className="overflow-hidden">
            <div className="hidden sm:flex items-center gap-4 px-4 h-10 border-b border-border text-[10.5px] uppercase tracking-[0.1em] text-text-muted">
              <span className="flex-1">{usage ? `${usage.apps.length} apps · ${totals.services} services · ${totals.running} running` : "Loading"}</span>
              <span className="w-24 hidden md:block">Trend</span>
              <span className="w-[260px] text-right">{mode === "now" ? "Now" : `Average, ${VIEWS.find((v) => v.value === view)?.label}`}</span>
            </div>
            {!usage ? (
              <p className="p-4 text-sm text-text-muted">Loading usage…</p>
            ) : apps.length === 0 ? (
              <p className="p-6 text-sm text-text-muted">{q ? "No app matches the filter." : "No app containers measured in this range yet. Usage shows up a minute or two after an app starts."}</p>
            ) : (
              <ul className="divide-y divide-border">
                {apps.map((a) => {
                  const isOpen = open.has(a.id);
                  return (
                    <li key={a.id}>
                      <button type="button" onClick={() => toggle(a.id)} aria-expanded={isOpen} className="w-full text-left flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 px-4 py-2.5 hover:bg-bg-card-hover">
                        <span className="flex items-center gap-2 min-w-0 flex-1">
                          <ChevronRight className={clsx("w-4 h-4 text-text-muted flex-shrink-0 transition-transform", isOpen && "rotate-90")} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="text-sm text-text-primary truncate">{a.name}</span>
                              <span className="text-[11px] text-text-muted">{a.usage.services.length} {a.usage.services.length === 1 ? "service" : "services"}</span>
                            </span>
                            <span className="block text-[11px] text-text-muted truncate">{a.project.name} / {a.environment} · {a.endpoint.name}</span>
                          </span>
                        </span>
                        <span className="w-24 hidden md:block flex-shrink-0"><Sparkline values={a.usage.trend} className="h-6" /></span>
                        <span className="w-full sm:w-auto">
                          <UsageCells u={valueOf(a.usage)} compact />
                          {mode === "avg" && <Peak avg={a.usage.avg} />}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="pl-6">
                          <AppServicesUsage usage={a.usage} mode={mode} trendLabel={TREND_LABEL[view]} />
                          <div className="px-4 pb-3 -mt-1 text-xs"><Link href={`/apps/${a.id}`} className="text-accent hover:underline">Open {a.name}</Link></div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {usage && usage.apps.length > 0 && (
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1 px-4 py-2.5 border-t border-border bg-accent/[0.04] text-xs">
                <span className="flex-1 font-medium text-text-primary text-sm">All apps</span>
                <span className="tabular-nums text-text-secondary">CPU <b className="text-text-primary font-mono">{fmtCpu(totals.cpu)}</b></span>
                <span className="tabular-nums text-text-secondary">Memory <b className="text-text-primary font-mono">{formatBytes(totals.mem)}</b></span>
                <span className="tabular-nums text-text-muted font-mono">↓ {fmtRate(totals.rx)} ↑ {fmtRate(totals.tx)}</span>
              </div>
            )}
          </Card>
        </section>

        {usage && usage.unmanaged.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-text-primary">Other containers</h2>
            <p className="text-xs text-text-muted mt-0.5 mb-3">Containers on your machines that DeployNow did not deploy.</p>
            <Card className="overflow-hidden">
              <ul className="divide-y divide-border">
                {usage.unmanaged.map((s) => (
                  <li key={s.endpointId + s.key} className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-text-primary truncate">{serviceLabel(s)}</span>
                      <span className="block text-[11px] text-text-muted truncate">{s.endpointName}{!s.now && s.lastSeen ? ` · stopped, last seen ${timeAgo(s.lastSeen)}` : ""}</span>
                    </span>
                    <span className="w-24 hidden md:block flex-shrink-0"><Sparkline values={s.trend} className="h-6" fill={false} /></span>
                    <span className="w-full sm:w-auto">
                      <UsageCells u={valueOf(s)} compact />
                      {mode === "avg" && <Peak avg={s.avg} />}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}

        {data.resolved.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-text-primary mb-2">Resolved in the last 7 days</h2>
            <Card className="overflow-hidden">
              <div className="divide-y divide-border">
                {data.resolved.map((a) => (
                  <div key={a.id} className="p-3 flex flex-wrap items-center gap-3 text-sm">
                    <Badge>{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                    <span className="text-text-secondary flex-1">{a.message}</span>
                    <span className="text-xs text-text-muted">{formatTime(a.firedAt)} to {formatTime(a.resolvedAt)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
