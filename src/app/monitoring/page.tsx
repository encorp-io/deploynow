"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Card, ErrorText, PageHeader, formatBytes, formatTime, stateTone, timeAgo } from "@/components/ui";

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
}

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

function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full rounded bg-bg-primary overflow-hidden">
      <div className={clsx("h-full", pct >= 90 ? "bg-danger" : pct >= 75 ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export default function MonitoringPage() {
  const api = useApi();
  const [data, setData] = useState<{ active: Alert[]; resolved: Alert[]; endpoints: EndpointRow[] } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ active: Alert[]; resolved: Alert[]; endpoints: EndpointRow[] }>("/api/monitoring");
    if (res.ok) setData(res.data as { active: Alert[]; resolved: Alert[]; endpoints: EndpointRow[] });
    else setError(res.data.error ?? "Could not load");
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="max-w-6xl">
      <PageHeader title="Monitoring" subtitle="Host usage and alerts. Alerts go to your notification channels when they start and when they clear." />
      <ErrorText>{error}</ErrorText>
      {data && (
        <div className="space-y-6">
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
            <h2 className="text-sm font-semibold text-text-primary mb-2">Hosts</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {data.endpoints.map((e) => (
                <Card key={e.id} className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <Link href={`/endpoints/${e.id}`} className="text-sm font-medium text-accent hover:underline">{e.name}</Link>
                    <Badge tone={stateTone(e.status)}>{e.status}</Badge>
                  </div>
                  {e.metrics && e.usage ? (
                    <div className="space-y-2 text-xs">
                      <div>
                        <div className="flex justify-between text-text-secondary mb-1"><span>CPU load</span><span>{e.metrics.load1.toFixed(2)} on {e.metrics.cpus} CPU</span></div>
                        <Bar pct={e.metrics.cpus ? (e.metrics.load1 / e.metrics.cpus) * 100 : 0} />
                      </div>
                      <div>
                        <div className="flex justify-between text-text-secondary mb-1"><span>Memory</span><span>{e.usage.mem}% of {formatBytes(e.metrics.memTotal)}</span></div>
                        <Bar pct={e.usage.mem} />
                      </div>
                      <div>
                        <div className="flex justify-between text-text-secondary mb-1"><span>Disk {e.metrics.diskPath}</span><span>{formatBytes(e.metrics.diskFree)} free</span></div>
                        <Bar pct={e.usage.disk} />
                      </div>
                      <p className="text-text-muted">{e.containers} containers · measured {timeAgo(e.metricsAt)}</p>
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted">{e.status === "online" ? "No measurements yet; they arrive within five minutes." : "Offline"}</p>
                  )}
                </Card>
              ))}
            </div>
          </section>

          {data.resolved.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-text-primary mb-2">Resolved in the last 7 days</h2>
              <Card className="overflow-hidden">
                <div className="divide-y divide-border">
                  {data.resolved.map((a) => (
                    <div key={a.id} className="p-3 flex items-center gap-3 text-sm">
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
      )}
    </div>
  );
}
