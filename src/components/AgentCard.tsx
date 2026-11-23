"use client";

import { useState } from "react";
import { Radio, ShieldOff, KeyRound } from "lucide-react";
import type { EndpointView } from "./EndpointForm";
import AgentJoin, { type JoinInfo } from "./AgentJoin";
import { Badge, Button, Card, ErrorText, formatBytes, timeAgo } from "./ui";

type Api = <T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) => Promise<{ ok: boolean; status: number; data: T & { error?: string } }>;

function Meter({ label, used, total, detail }: { label: string; used: number; total: number; detail: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 90 ? "bg-danger" : pct >= 75 ? "bg-warning" : "bg-accent";
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-text-secondary">{label}</span>
        <span className="text-text-muted">{detail}</span>
      </div>
      <div className="h-1.5 rounded bg-bg-primary overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function AgentCard({ api, endpoint, onChange }: { api: Api; endpoint: EndpointView; onChange: () => void }) {
  const [join, setJoin] = useState<JoinInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const a = endpoint.agent;
  const m = endpoint.hostMetrics;

  async function newToken() {
    setBusy("join");
    setError("");
    const res = await api<JoinInfo>(`/api/endpoints/${endpoint.id}/agent`, { body: { action: "join" } });
    setBusy("");
    if (res.ok) setJoin(res.data as JoinInfo);
    else setError(res.data.error ?? "Could not create a join token");
  }

  async function revoke() {
    if (!confirm(`Revoke the agent on ${endpoint.name}? It is disconnected at once and has to be enrolled again with a new join command.`)) return;
    setBusy("revoke");
    setError("");
    const res = await api(`/api/endpoints/${endpoint.id}/agent`, { body: { action: "revoke" } });
    setBusy("");
    if (res.ok) {
      setJoin(null);
      onChange();
    } else setError(res.data.error ?? "Could not revoke");
  }

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Radio className="w-5 h-5 text-accent" />
          <div>
            <p className="text-sm font-medium text-text-primary flex items-center gap-2">
              Agent
              {a?.enrolled ? <Badge tone={endpoint.status === "online" ? "success" : "warning"}>{endpoint.status === "online" ? "connected" : "not connected"}</Badge> : <Badge tone="muted">not enrolled</Badge>}
            </p>
            <p className="text-xs text-text-muted">
              {a?.enrolled
                ? <>{a.hostname || "unknown host"} · agent {a.version || "?"} · connected {a.connectedAt ? timeAgo(a.connectedAt) : "never"}</>
                : a?.joinPending ? "Waiting for the agent to enrol with its join command" : "Generate a join command and run it on the server"}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" loading={busy === "join"} onClick={newToken}><KeyRound className="w-4 h-4" /> {a?.enrolled ? "Re-enrol" : "Join command"}</Button>
          {a?.enrolled && <Button variant="danger" loading={busy === "revoke"} onClick={revoke}><ShieldOff className="w-4 h-4" /> Revoke</Button>}
        </div>
      </div>
      {m && (
        <div className="grid grid-cols-3 gap-4 mt-4">
          <Meter label="CPU load" used={m.load1} total={m.cpus || 1} detail={`${m.load1.toFixed(2)} on ${m.cpus} CPU`} />
          <Meter label="Memory" used={m.memTotal - m.memAvailable} total={m.memTotal} detail={`${formatBytes(m.memTotal - m.memAvailable)} of ${formatBytes(m.memTotal)}`} />
          <Meter label={`Disk ${m.diskPath}`} used={m.diskTotal - m.diskFree} total={m.diskTotal} detail={`${formatBytes(m.diskFree)} free`} />
        </div>
      )}
      {join && <div className="mt-4"><AgentJoin join={join} /></div>}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}
