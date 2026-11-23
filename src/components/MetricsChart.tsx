"use client";

import { useEffect, useState } from "react";
import { Card } from "./ui";

interface Sample {
  at: string;
  cpus: number;
  load1: number;
  memTotal: number;
  memUsed: number;
  diskTotal: number;
  diskUsed: number;
}

type Api = <T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) => Promise<{ ok: boolean; status: number; data: T & { error?: string } }>;

function Spark({ values, label, latest, color }: { values: number[]; label: string; latest: string; color: string }) {
  const w = 240;
  const h = 40;
  const pts = values.map((v, i) => `${values.length > 1 ? (i / (values.length - 1)) * w : 0},${h - Math.max(0, Math.min(1, v)) * h}`).join(" ");
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-text-secondary">{label}</span>
        <span className="text-text-muted">{latest}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10" preserveAspectRatio="none" role="img" aria-label={`${label} over the last 24 hours`}>
        <line x1="0" x2={w} y1={h * 0.1} y2={h * 0.1} stroke="currentColor" className="text-border" strokeDasharray="2 3" />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/** Host CPU, memory and disk over the last 24 hours. */
export default function MetricsChart({ api, endpointId }: { api: Api; endpointId: string }) {
  const [samples, setSamples] = useState<Sample[] | null>(null);
  useEffect(() => {
    api<Sample[]>(`/api/endpoints/${endpointId}/metrics?hours=24`).then((r) => setSamples(r.ok ? (r.data as unknown as Sample[]) : []));
  }, [api, endpointId]);
  if (!samples || samples.length < 2) return null;
  const last = samples[samples.length - 1];
  const pct = (a: number, b: number) => (b > 0 ? a / b : 0);
  return (
    <Card className="p-4 mb-4">
      <p className="text-xs text-text-muted mb-3">Last 24 hours</p>
      <div className="grid sm:grid-cols-3 gap-6">
        <Spark label="CPU load" values={samples.map((s) => pct(s.load1, s.cpus || 1))} latest={`${last.load1.toFixed(2)} / ${last.cpus} CPU`} color="var(--color-accent, #6366f1)" />
        <Spark label="Memory" values={samples.map((s) => pct(s.memUsed, s.memTotal))} latest={`${Math.round(pct(last.memUsed, last.memTotal) * 100)}%`} color="var(--color-warning, #f59e0b)" />
        <Spark label="Disk" values={samples.map((s) => pct(s.diskUsed, s.diskTotal))} latest={`${Math.round(pct(last.diskUsed, last.diskTotal) * 100)}%`} color="var(--color-success, #10b981)" />
      </div>
    </Card>
  );
}
