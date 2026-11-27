"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle, FolderKanban, GitCommit, Rocket, Server } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, EmptyState, ErrorText, PageHeader, PageSkeleton, formatBytes, timeAgo } from "@/components/ui";
import { Dot, Meter, Sparkline, StatTile, UsageCells, type UsageNow } from "@/components/usage";

interface Machine { id: string; name: string; type: string; status: string; containers: number; labels: string; cpu: number | null; mem: number | null; disk: number | null; cpus: number; memTotal: number; trend: number[] }
interface Deployment { id: string; status: string; trigger: string; commitSha: string; createdAt: string; finishedAt: string | null; startedBy: string; app: { id: string; name: string }; project: { id: string; name: string }; environment: string }
interface TopApp { id: string; name: string; project: { id: string; name: string }; environment: string; services: number; now: UsageNow; trend: number[] }
interface Overview {
  at: string;
  fleet: { online: number; total: number; containers: number; cpu: number | null; memUsed: number; memTotal: number; cpuTrend: number[]; memTrend: number[] };
  machines: Machine[];
  apps: { total: number; previews: number; projects: number; byStatus: Record<string, number>; cpuTrend: number[] };
  topApps: TopApp[];
  deployments: Deployment[];
  log: { deploymentId: string; lines: string[] } | null;
  backups: { last: { status: string; at: string; bytes: number } | null; ok7d: number; failed7d: number; days: number[] } | null;
  alerts: { id: string; kind: string; message: string; firedAt: string }[];
}

const TYPE_LABEL: Record<string, string> = { socket: "local socket", ssh: "SSH", tls: "TLS", agent: "agent · mTLS" };
const DEPLOY_TONE: Record<string, "success" | "warning" | "danger" | "accent" | "muted"> = { success: "success", running: "accent", queued: "warning", failed: "danger", cancelled: "muted" };

function LogLine({ line }: { line: string }) {
  const m = /^(\d\d:\d\d:\d\d) (.*)$/.exec(line);
  const text = m ? m[2] : line;
  const tone = /error|failed|fatal/i.test(text) ? "text-danger" : /success|healthy|done|ready|finished|✓/i.test(text) ? "text-success" : /pull|build|step|start|creat|deploy/i.test(text) ? "text-accent-soft" : "text-text-secondary";
  return (
    <div className="truncate">
      {m && <span className="text-text-muted mr-2">{m[1]}</span>}
      <span className={tone}>{text}</span>
    </div>
  );
}

function machineState(m: Machine): "on" | "warn" | "off" | "idle" {
  if (m.status === "offline") return "off";
  if (m.status !== "online") return "idle";
  return Math.max(m.cpu ?? 0, m.mem ?? 0, m.disk ?? 0) >= 85 ? "warn" : "on";
}

export default function OverviewPage() {
  const api = useApi();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await api<Overview>("/api/overview");
    if (res.ok) {
      setData(res.data as Overview);
      setError("");
    } else setError(res.data.error ?? "Could not load the overview");
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return error ? <div className="max-w-6xl"><ErrorText>{error}</ErrorText></div> : <PageSkeleton rows={4} />;

  const { fleet, apps, backups } = data;
  const memPct = fleet.memTotal ? Math.round((fleet.memUsed / fleet.memTotal) * 100) : null;
  const running = apps.byStatus.running ?? 0;
  const failed = apps.byStatus.failed ?? 0;
  const live = data.log ? data.deployments.find((d) => d.id === data.log!.deploymentId) : undefined;
  const isLive = live && (live.status === "running" || live.status === "queued");

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Overview"
        subtitle="Every machine, app and deploy at a glance."
        actions={
          <>
            <span className="inline-flex items-center gap-2 text-xs text-text-muted mr-1"><Dot state="on" /> updated {timeAgo(data.at)}</span>
            <Link href="/projects"><Button variant="secondary"><FolderKanban className="w-4 h-4" /> Projects</Button></Link>
          </>
        }
      />
      <ErrorText>{error}</ErrorText>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
        <StatTile label="Machines" value={fleet.online} unit={`/ ${fleet.total} online`} sub={`${fleet.containers} containers running`} footer={<div className="flex flex-wrap gap-1 h-7 items-end pb-1.5">{data.machines.slice(0, 24).map((m) => <span key={m.id} title={`${m.name}: ${m.status}`} className={machineState(m) === "on" ? "w-2.5 h-2.5 rounded-[3px] bg-success/80" : machineState(m) === "warn" ? "w-2.5 h-2.5 rounded-[3px] bg-warning" : machineState(m) === "off" ? "w-2.5 h-2.5 rounded-[3px] bg-danger" : "w-2.5 h-2.5 rounded-[3px] bg-text-muted/40"} />)}</div>} href="/endpoints" />
        <StatTile label="Apps" value={apps.total} unit={apps.previews ? `${apps.previews} previews` : `in ${apps.projects} projects`} sub={`${running} running${failed ? ` · ${failed} failed` : ""}`} trend={apps.cpuTrend} tone="blue" href="/projects" />
        <StatTile label="CPU" value={fleet.cpu ?? "–"} unit={fleet.cpu != null ? "% load" : undefined} sub="all machines, last 24 h" trend={fleet.cpuTrend} max={100} tone="sky" href="/monitoring" />
        <StatTile label="Memory" value={memPct ?? "–"} unit={memPct != null ? "% used" : undefined} sub={fleet.memTotal ? `${formatBytes(fleet.memUsed)} of ${formatBytes(fleet.memTotal)}` : "no measurements yet"} trend={fleet.memTrend} max={100} tone="violet" href="/monitoring" />
        {backups ? (
          <StatTile
            label="Last backup"
            value={backups.last ? timeAgo(backups.last.at).replace(/ ago$/, "") : "–"}
            unit={backups.last ? (backups.last.status === "success" ? "ago" : "ago · failed") : "none yet"}
            sub={`${backups.ok7d} in 7 days${backups.failed7d ? ` · ${backups.failed7d} failed` : ""}`}
            trend={backups.days}
            tone={backups.failed7d ? "warn" : "mint"}
            href="/backups"
          />
        ) : (
          <StatTile label="Projects" value={apps.projects} trend={undefined} href="/projects" />
        )}
      </div>

      {/* Deploy log + machines */}
      <div className="grid lg:grid-cols-5 gap-3 mb-4">
        <Card className="lg:col-span-3 overflow-hidden flex flex-col min-w-0">
          <div className="flex items-center justify-between gap-3 px-4 h-11 border-b border-border">
            <div className="flex items-center gap-2 min-w-0 text-sm">
              <Rocket className="w-4 h-4 text-accent flex-shrink-0" />
              {live ? (
                <Link href={`/apps/${live.app.id}?tab=deployments`} className="truncate text-text-primary font-medium hover:underline">
                  Deploy of {live.app.name} <span className="text-text-muted font-normal">· {live.project.name} / {live.environment}</span>
                </Link>
              ) : (
                <span className="text-text-primary font-medium">Deployments</span>
              )}
            </div>
            {live && (isLive ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-success font-medium"><span className="relative flex w-2 h-2"><span className="absolute inset-0 rounded-full bg-success animate-ping opacity-60" /><span className="relative w-2 h-2 rounded-full bg-success" /></span>live</span>
            ) : (
              <Badge tone={DEPLOY_TONE[live.status] ?? "muted"}>{live.status}</Badge>
            ))}
          </div>
          {data.log && (data.log.lines.length > 0 || isLive) ? (
            <div className="px-4 py-3 font-mono text-[11.8px] leading-[1.75] h-[214px] overflow-hidden bg-bg-primary/40 flex flex-col justify-end">
              {data.log.lines.length ? data.log.lines.map((l, i) => <LogLine key={i} line={l} />) : <span className="text-text-muted">No log lines yet.</span>}
            </div>
          ) : data.deployments.length === 0 ? (
            <div className="p-8 text-center text-sm text-text-muted flex-1 flex flex-col items-center justify-center gap-3">
              <p>No deployments yet. Create an app in a project and deploy it.</p>
              <Link href="/projects"><Button><FolderKanban className="w-4 h-4" /> Go to projects</Button></Link>
            </div>
          ) : null}
          {data.deployments.length > 0 && (
            <ul className="border-t border-border divide-y divide-border text-sm">
              {data.deployments.slice(0, 5).map((d) => (
                <li key={d.id}>
                  <Link href={`/apps/${d.app.id}?tab=deployments`} className="flex items-center gap-3 px-4 py-2 hover:bg-bg-card-hover">
                    <Badge tone={DEPLOY_TONE[d.status] ?? "muted"}>{d.status}</Badge>
                    <span className="text-text-primary truncate">{d.app.name}</span>
                    <span className="text-xs text-text-muted truncate hidden sm:inline">{d.project.name} / {d.environment}</span>
                    {d.commitSha && <span className="hidden md:inline-flex items-center gap-1 text-xs font-mono text-text-muted"><GitCommit className="w-3 h-3" />{d.commitSha.slice(0, 7)}</span>}
                    <span className="ml-auto text-xs text-text-muted whitespace-nowrap">{d.trigger} · {timeAgo(d.finishedAt ?? d.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2 overflow-hidden min-w-0">
          <div className="flex items-center justify-between px-4 h-11 border-b border-border">
            <span className="text-sm font-medium text-text-primary flex items-center gap-2"><Server className="w-4 h-4 text-accent" /> Machines</span>
            <span className="text-xs text-text-muted">{fleet.online} of {fleet.total} online</span>
          </div>
          {data.machines.length === 0 ? (
            <p className="p-6 text-sm text-text-muted">No machines you can see yet. <Link className="text-accent hover:underline" href="/endpoints">Add one</Link>.</p>
          ) : (
            <ul className="divide-y divide-border max-h-[420px] overflow-y-auto">
              {data.machines.map((m) => (
                <li key={m.id}>
                  <Link href={`/endpoints/${m.id}`} className="grid grid-cols-[auto_1fr_64px_60px] items-center gap-3 px-4 py-2.5 hover:bg-bg-card-hover">
                    <Dot state={machineState(m)} />
                    <span className="min-w-0">
                      <span className="block text-sm text-text-primary truncate">{m.name}</span>
                      <span className="block text-[11px] text-text-muted truncate">{TYPE_LABEL[m.type] ?? m.type}{m.status === "online" ? ` · ${m.containers} containers` : ` · ${m.status}`}</span>
                    </span>
                    <Sparkline values={m.trend} max={100} className="h-6" tone={machineState(m) === "warn" ? "warn" : "sky"} />
                    <span className="text-right">
                      <span className="block text-sm font-semibold tabular-nums text-text-primary">{m.cpu != null ? `${m.cpu}%` : "–"}</span>
                      {m.mem != null && <span className="block text-[10.5px] text-text-muted tabular-nums whitespace-nowrap">mem {m.mem}%</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Busiest apps + alerts */}
      <div className="grid lg:grid-cols-5 gap-3">
        <Card className="lg:col-span-3 overflow-hidden min-w-0">
          <div className="flex items-center justify-between px-4 h-11 border-b border-border">
            <span className="text-sm font-medium text-text-primary">Busiest apps right now</span>
            <Link href="/monitoring" className="text-xs text-accent hover:underline inline-flex items-center gap-1">All usage <ArrowRight className="w-3 h-3" /></Link>
          </div>
          {data.topApps.length === 0 ? (
            <p className="p-6 text-sm text-text-muted">No running app containers measured yet. Usage shows up a minute or two after an app starts.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.topApps.map((a) => (
                <li key={a.id}>
                  <Link href={`/apps/${a.id}`} className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 px-4 py-2.5 hover:bg-bg-card-hover">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-text-primary truncate">{a.name}</span>
                      <span className="block text-[11px] text-text-muted truncate">{a.project.name} / {a.environment} · {a.services} {a.services === 1 ? "service" : "services"}</span>
                    </span>
                    <span className="w-24 hidden md:block"><Sparkline values={a.trend} className="h-6" /></span>
                    <UsageCells u={a.now} compact />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2 overflow-hidden min-w-0">
          <div className="flex items-center justify-between px-4 h-11 border-b border-border">
            <span className="text-sm font-medium text-text-primary">Alerts</span>
            <Link href="/monitoring" className="text-xs text-accent hover:underline">Monitoring</Link>
          </div>
          {data.alerts.length === 0 ? (
            <p className="p-4 text-sm text-success flex items-center gap-2"><CheckCircle className="w-4 h-4" /> Nothing needs attention.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 px-4 py-2.5 text-sm">
                  <AlertTriangle className="w-4 h-4 text-danger flex-shrink-0 mt-0.5" />
                  <span className="flex-1 text-text-primary">{a.message}</span>
                  <span className="text-xs text-text-muted whitespace-nowrap">{timeAgo(a.firedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          {data.machines.some((m) => m.disk != null) && (
            <div className="border-t border-border px-4 py-3 space-y-2">
              <p className="text-[11px] uppercase tracking-[0.1em] text-text-muted">Disk</p>
              {data.machines.filter((m) => m.disk != null).slice(0, 4).map((m) => (
                <div key={m.id} className="text-xs">
                  <div className="flex justify-between text-text-secondary mb-1"><span className="truncate">{m.name}</span><span className="tabular-nums">{m.disk}%</span></div>
                  <Meter pct={m.disk ?? 0} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {data.machines.length === 0 && data.apps.total === 0 && (
        <div className="mt-6">
          <EmptyState icon={Server} title="Connect your first machine" action={<Link href="/onboarding"><Button>Get started</Button></Link>}>
            Connect the local Docker socket, a machine over SSH or TLS, or one behind NAT with the agent.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
