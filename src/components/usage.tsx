"use client";

/**
 * Small building blocks for resource usage: sparklines, stat tiles in the
 * style of the landing page's dashboard, meters, and the per-service usage
 * rows shown under an app on the project page and in Monitoring.
 */
import { useId, type ReactNode } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { formatBytes } from "./ui";

export interface UsageNow { cpu: number; mem: number; memLimit: number; rx: number; tx: number }
export interface UsageAvg extends UsageNow { cpuMax: number; memMax: number }
export interface ServiceUsage {
  key: string;
  service: string;
  container: string;
  endpointId: string;
  replicas: number;
  now: UsageNow | null;
  avg: UsageAvg;
  lastSeen: string | null;
  trend: number[];
  memTrend: number[];
}
export interface AppUsage {
  appId: string;
  services: ServiceUsage[];
  now: UsageNow | null;
  avg: UsageAvg;
  lastSeen: string | null;
  trend: number[];
  memTrend: number[];
}

export const fmtCpu = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
export const fmtRate = (v: number) => `${formatBytes(v)}/s`;

const TONES = {
  sky: "var(--dn-accent-soft)",
  blue: "var(--dn-accent)",
  violet: "#a78bfa",
  mint: "var(--dn-success)",
  warn: "var(--dn-warning)",
  danger: "var(--dn-danger)",
} as const;
export type Tone = keyof typeof TONES;

/** A line with a soft fill under it. `max` fixes the top of the scale (e.g. 100 for percentages). */
export function Sparkline({ values, tone = "sky", max, className, fill = true }: { values: number[]; tone?: Tone; max?: number; className?: string; fill?: boolean }) {
  const id = useId().replace(/:/g, "");
  const color = TONES[tone];
  if (values.length < 2) {
    return <svg className={clsx("block w-full", className ?? "h-7")} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden><line x1="0" y1="26" x2="100" y2="26" stroke="var(--dn-border-bright)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" /></svg>;
  }
  const top = Math.max(max ?? 0, ...values, 1e-9);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 26 - (Math.max(0, v) / top) * 23] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  return (
    <svg className={clsx("block w-full overflow-visible", className ?? "h-7")} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      {fill && (
        <>
          <defs>
            <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.28" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L100 28 L0 28 Z`} fill={`url(#g${id})`} />
        </>
      )}
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The landing page's stat card: label, big value with a small unit, a line under it. */
export function StatTile({ label, value, unit, sub, trend, tone = "sky", max, href, icon, footer }: { label: string; value: ReactNode; unit?: ReactNode; sub?: ReactNode; trend?: number[]; tone?: Tone; max?: number; href?: string; icon?: ReactNode; footer?: ReactNode }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-text-muted">{label}</span>
        {icon && <span className="text-text-muted">{icon}</span>}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5 min-w-0">
        <span className="text-[26px] leading-none font-semibold tracking-[-0.03em] text-text-primary tabular-nums">{value}</span>
        {unit && <span className="text-xs text-text-muted truncate">{unit}</span>}
      </div>
      {sub && <div className="mt-1 text-[11.5px] text-text-muted truncate">{sub}</div>}
      <div className="mt-2 -mx-1">{footer ?? (trend ? <Sparkline values={trend} tone={tone} max={max} /> : <div className="h-7" />)}</div>
    </>
  );
  const cls = "dn-surface border border-border rounded-2xl px-4 pt-3.5 pb-2 overflow-hidden block min-w-0";
  return href ? (
    <Link href={href} className={clsx(cls, "hover:border-border-bright transition-colors")}>{body}</Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Thin horizontal meter; turns amber from 75% and red from 90%. */
export function Meter({ pct, className, tone }: { pct: number; className?: string; tone?: "accent" | "violet" }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <div className={clsx("h-1.5 w-full rounded-full bg-bg-primary/80 ring-1 ring-inset ring-border overflow-hidden", className)} role="presentation">
      <div
        className={clsx("h-full rounded-full transition-[width] duration-500", p >= 90 ? "bg-danger" : p >= 75 ? "bg-warning" : tone === "violet" ? "bg-[#a78bfa]" : "bg-gradient-to-r from-accent-soft to-accent")}
        style={{ width: `${Math.max(p, p > 0 ? 2 : 0)}%` }}
      />
    </div>
  );
}

/** Small status dot with a glow when on. */
export function Dot({ state }: { state: "on" | "warn" | "off" | "idle" }) {
  return (
    <span
      className={clsx(
        "inline-block w-2 h-2 rounded-full flex-shrink-0",
        state === "on" && "bg-success shadow-[0_0_8px_var(--dn-success)]",
        state === "warn" && "bg-warning shadow-[0_0_8px_var(--dn-warning)]",
        state === "off" && "bg-danger",
        state === "idle" && "bg-text-muted/50",
      )}
    />
  );
}

/** "web", "web ×2" for compose replicas */
export const serviceLabel = (s: Pick<ServiceUsage, "service" | "container" | "replicas">) => `${s.service || s.container}${s.replicas > 1 ? ` ×${s.replicas}` : ""}`;

/**
 * Two numbers with a meter: CPU against one core per 100%, memory against the
 * limit when there is one. `mode` picks now (latest sample) or the range average.
 */
export function UsageCells({ u, cpuScale = 100, compact }: { u: UsageNow | null; cpuScale?: number; compact?: boolean }) {
  if (!u) return <span className="text-xs text-text-muted">not running</span>;
  const memPct = u.memLimit > 0 ? (u.mem / u.memLimit) * 100 : 0;
  return (
    <div className={clsx("grid items-center gap-x-4", compact ? "grid-cols-2 w-full sm:w-[260px]" : "grid-cols-2 sm:grid-cols-[110px_190px_110px] w-full sm:w-auto")}>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-text-muted">CPU</span>
          <span className="font-mono tabular-nums text-text-primary">{fmtCpu(u.cpu)}</span>
        </div>
        <Meter pct={(u.cpu / cpuScale) * 100} className="mt-1" />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-text-muted">Mem</span>
          <span className="font-mono tabular-nums text-text-primary truncate">
            {formatBytes(u.mem)}
            {u.memLimit > 0 && !compact && <span className="text-text-muted hidden sm:inline"> / {formatBytes(u.memLimit)}</span>}
          </span>
        </div>
        <Meter pct={memPct} tone="violet" className="mt-1" />
      </div>
      {!compact && (
        <div className="hidden sm:block text-[11px] font-mono tabular-nums text-text-muted leading-4 text-right">
          <div>↓ {fmtRate(u.rx)}</div>
          <div>↑ {fmtRate(u.tx)}</div>
        </div>
      )}
    </div>
  );
}

/**
 * The services (containers) of one app, each with its CPU, memory and network
 * on the right, and the app total under them when there is more than one.
 */
export function AppServicesUsage({ usage, mode = "now", trendLabel = "last hour", className }: { usage: AppUsage; mode?: "now" | "avg"; trendLabel?: string; className?: string }) {
  const pick = (x: { now: UsageNow | null; avg: UsageAvg }) => (mode === "now" ? x.now : x.avg);
  const runningCount = usage.services.filter((s) => s.now).length;
  return (
    <div className={clsx("px-4 pb-3", className)}>
      <div className="rounded-xl border border-border bg-bg-primary/40 overflow-hidden">
        <div className="hidden sm:flex items-center justify-between px-3 h-8 text-[10.5px] uppercase tracking-[0.1em] text-text-muted border-b border-border">
          <span>{usage.services.length} {usage.services.length === 1 ? "service" : "services"}{runningCount < usage.services.length ? ` · ${runningCount} running` : ""}</span>
          <span>{mode === "now" ? "Now" : "Average"} · trend {trendLabel}</span>
        </div>
        <ul className="divide-y divide-border">
          {usage.services.map((s) => (
            <li key={s.key + s.endpointId} className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 px-3 py-2">
              <span className="flex items-center gap-2.5 min-w-0 flex-1">
                <Dot state={s.now ? "on" : "idle"} />
                <span className="min-w-0">
                  <span className="block text-sm text-text-primary truncate">{serviceLabel(s)}</span>
                  <span className="block text-[11px] text-text-muted font-mono truncate">{s.now ? s.container : `stopped · last seen ${lastSeen(s.lastSeen)}`}</span>
                </span>
              </span>
              <span className="w-20 hidden md:block flex-shrink-0"><Sparkline values={s.trend} className="h-5" fill={false} /></span>
              <UsageCells u={pick(s)} />
            </li>
          ))}
          {usage.services.length > 1 && (
            <li className="flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2 px-3 py-2 bg-accent/[0.04]">
              <span className="flex-1 text-sm font-medium text-text-primary">Total for the app</span>
              <span className="w-20 hidden md:block flex-shrink-0"><Sparkline values={usage.trend} className="h-5" tone="blue" fill={false} /></span>
              <UsageCells u={pick(usage)} />
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function lastSeen(iso: string | null) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
