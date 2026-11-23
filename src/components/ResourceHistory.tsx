"use client";

/**
 * Container resource history: CPU, memory, network and disk I/O over time, with
 * a summary of averages, peaks and totals. Self-contained, drop it anywhere:
 *
 *   <ResourceHistory appId={app.id} />                         an app (all its services)
 *   <ResourceHistory endpointId={id} containerId={cid} />      one container
 *   <ContainerUsageTable endpointId={id} />                    every container on an endpoint
 */
import { useEffect, useMemo, useState, type PointerEvent } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { useApi } from "./AppShell";
import { Card, formatBytes } from "./ui";

const RANGES = ["1h", "6h", "24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];

interface Point { t: string; cpu: number; cpuMax: number; mem: number; memMax: number; memLimit: number; rx: number; tx: number; read: number; write: number }
interface Summary { cpuAvg: number; cpuMax: number; memAvg: number; memMax: number; memLimit: number; netRx: number; netTx: number; blkRead: number; blkWrite: number }
interface Series { key: string; service: string; container: string; endpointId: string; points: Point[]; summary: Summary }
interface History { range: Range; from: string | null; to: string; bucketSeconds: number; series: Series[] }

// Two series colours checked for colour-blind separation on the dark card surface
const C1 = "#3b82f6";
const C2 = "#ec4899";

/** "web", or "web #2" for a second compose replica */
const seriesLabel = (key: string, service: string, container: string) => {
  const replica = /#(\d+)$/.exec(key)?.[1];
  return `${service || container}${replica ? ` #${replica}` : ""}`;
};
const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
const rate = (v: number) => `${formatBytes(v)}/s`;

function fmtTime(iso: string, range: Range) {
  const d = new Date(iso);
  return range === "7d" || range === "30d"
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Adds series bucket by bucket (the "All services" view). */
function combine(series: Series[]): { points: Point[]; summary: Summary } {
  if (series.length === 1) return series[0];
  const byT = new Map<string, Point>();
  for (const s of series) {
    for (const p of s.points) {
      const a = byT.get(p.t);
      if (!a) byT.set(p.t, { ...p });
      else for (const k of ["cpu", "cpuMax", "mem", "memMax", "memLimit", "rx", "tx", "read", "write"] as const) a[k] += p[k];
    }
  }
  const points = [...byT.values()].sort((a, b) => a.t.localeCompare(b.t));
  const sum = (k: keyof Summary) => series.reduce((n, s) => n + s.summary[k], 0);
  return {
    points,
    summary: {
      cpuAvg: sum("cpuAvg"),
      cpuMax: Math.max(0, ...points.map((p) => p.cpuMax)),
      memAvg: sum("memAvg"),
      memMax: Math.max(0, ...points.map((p) => p.memMax)),
      memLimit: sum("memLimit"),
      netRx: sum("netRx"),
      netTx: sum("netTx"),
      blkRead: sum("blkRead"),
      blkWrite: sum("blkWrite"),
    },
  };
}

/** Places points on the full bucket grid so missing samples show as gaps. */
function grid(points: Point[], from: string, to: string, bucketSeconds: number): (Point | null)[] {
  const start = new Date(from).getTime();
  const step = bucketSeconds * 1000;
  const n = Math.max(1, Math.floor((new Date(to).getTime() - start) / step) + 1);
  const out: (Point | null)[] = Array(n).fill(null);
  for (const p of points) {
    const i = Math.round((new Date(p.t).getTime() - start) / step);
    if (i >= 0 && i < n) out[i] = p;
  }
  return out;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}

interface Line { label: string; color: string; value: (p: Point) => number; dashed?: boolean; band?: (p: Point) => number }

const W = 600;
const H = 120;

function Chart({ title, slots, lines, format, hover, setHover, range, yMin }: {
  title: string;
  slots: (Point | null)[];
  lines: Line[];
  format: (v: number) => string;
  hover: number | null;
  setHover: (i: number | null) => void;
  range: Range;
  yMin?: number;
}) {
  const max = niceMax(Math.max(yMin ?? 0, ...slots.flatMap((p) => (p ? lines.map((l) => Math.max(l.value(p), l.band?.(p) ?? 0)) : []))));
  const x = (i: number) => (slots.length > 1 ? (i / (slots.length - 1)) * W : W / 2);
  const y = (v: number) => H - (Math.max(0, v) / max) * H;
  const path = (f: (p: Point) => number) => {
    let d = "";
    let pen = false;
    slots.forEach((p, i) => {
      if (!p) return void (pen = false);
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(f(p)).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const area = (top: (p: Point) => number, bottom: (p: Point) => number) => {
    // Runs of consecutive points become closed shapes
    const runs: number[][] = [];
    slots.forEach((p, i) => {
      if (!p) return;
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1) last.push(i);
      else runs.push([i]);
    });
    return runs
      .filter((r) => r.length > 1)
      .map((r) => `M${r.map((i) => `${x(i).toFixed(1)},${y(top(slots[i]!)).toFixed(1)}`).join("L")}L${[...r].reverse().map((i) => `${x(i).toFixed(1)},${y(bottom(slots[i]!)).toFixed(1)}`).join("L")}Z`)
      .join("");
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (slots.length - 1));
    setHover(Math.max(0, Math.min(slots.length - 1, i)));
  };
  const hp = hover !== null ? slots[hover] : null;
  const first = slots.findIndex((p) => p);

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h4 className="text-xs font-medium text-text-secondary">{title}</h4>
        {lines.length > 1 && (
          <div className="flex gap-3 text-[11px] text-text-muted">
            {lines.filter((l) => !l.dashed).map((l) => (
              <span key={l.label} className="flex items-center gap-1"><span className="inline-block w-2.5 h-0.5 rounded" style={{ background: l.color }} />{l.label}</span>
            ))}
          </div>
        )}
      </div>
      <div className="relative pt-4">
        <span className="absolute left-0 top-0 text-[10px] text-text-muted pointer-events-none">{format(max)}</span>
        <div className="relative touch-none" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28 overflow-visible" preserveAspectRatio="none" role="img" aria-label={`${title} over the last ${range}`}>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--color-border)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
            ))}
            <line x1="0" x2={W} y1="0" y2="0" stroke="var(--color-border)" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
            <line x1="0" x2={W} y1={H} y2={H} stroke="var(--color-border-bright)" vectorEffect="non-scaling-stroke" />
            {lines.map((l) => l.band && <path key={`${l.label}-band`} d={area(l.band, l.value)} fill={l.color} opacity="0.15" />)}
            {lines.map((l) => (
              <path key={l.label} d={path(l.value)} fill="none" stroke={l.dashed ? "var(--color-text-muted)" : l.color} strokeWidth="2" strokeDasharray={l.dashed ? "4 4" : undefined} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            ))}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} stroke="var(--color-text-muted)" vectorEffect="non-scaling-stroke" />}
          </svg>
          {hp && hover !== null && (
            <div
              className="absolute top-2 z-10 pointer-events-none rounded-md border border-border-bright bg-bg-secondary px-2 py-1.5 text-[11px] shadow-lg whitespace-nowrap"
              style={hover / Math.max(1, slots.length - 1) > 0.6 ? { right: `${100 - (hover / Math.max(1, slots.length - 1)) * 100 + 2}%` } : { left: `${(hover / Math.max(1, slots.length - 1)) * 100 + 2}%` }}
            >
              <p className="text-text-muted mb-0.5">{fmtTime(hp.t, range)}</p>
              {lines.map((l) => (
                <p key={l.label} className="flex items-center gap-1.5 text-text-primary">
                  <span className="inline-block w-2 h-0.5 rounded" style={{ background: l.dashed ? "var(--color-text-muted)" : l.color }} />
                  <span className="text-text-secondary">{l.label}</span> <span className="ml-auto pl-2 tabular-nums">{format(l.value(hp))}</span>
                </p>
              ))}
              {lines[0].band && <p className="text-text-muted">peak {format(lines[0].band(hp))}</p>}
            </div>
          )}
        </div>
        <div className="flex justify-between text-[10px] text-text-muted mt-1">
          <span>{first >= 0 ? fmtTime(slots[first]!.t, range) : ""}</span>
          <span>now</span>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-text-muted">{label}</p>
      <p className="text-sm font-semibold text-text-primary tabular-nums truncate">{value}</p>
      {sub && <p className="text-[11px] text-text-muted truncate">{sub}</p>}
    </div>
  );
}

function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-lg border border-border p-0.5">
      {RANGES.map((r) => (
        <button key={r} role="radio" aria-checked={value === r} onClick={() => onChange(r)} className={clsx("px-2 py-0.5 text-xs rounded-md", value === r ? "bg-accent text-white" : "text-text-muted hover:text-text-primary")}>
          {r}
        </button>
      ))}
    </div>
  );
}

function savedRange(): Range {
  try {
    const v = localStorage.getItem("dn.resourceRange");
    return (RANGES as readonly string[]).includes(v ?? "") ? (v as Range) : "24h";
  } catch {
    return "24h";
  }
}

export default function ResourceHistory({ appId, endpointId, containerId, title = "Resource usage" }: { appId?: string; endpointId?: string; containerId?: string; title?: string }) {
  const api = useApi();
  const [range, setRangeState] = useState<Range>("24h");
  const [data, setData] = useState<History | null>(null);
  const [failed, setFailed] = useState(false);
  const [pick, setPick] = useState<string>("all");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => setRangeState(savedRange()), []);
  const setRange = (r: Range) => {
    setRangeState(r);
    try {
      localStorage.setItem("dn.resourceRange", r);
    } catch {
      /* private mode */
    }
  };

  const url = appId ? `/api/apps/${appId}/metrics` : endpointId && containerId ? `/api/endpoints/${endpointId}/containers/${containerId}/metrics` : "";
  useEffect(() => {
    if (!url) return;
    let stop = false;
    const load = () =>
      api<History>(`${url}?range=${range}`).then((r) => {
        if (stop) return;
        if (r.ok) {
          setData(r.data as unknown as History);
          setFailed(false);
        } else setFailed(true);
      });
    load();
    const t = setInterval(load, 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [api, url, range]);

  const series = data?.series ?? [];
  const chosen = useMemo(() => {
    const list = pick === "all" ? series : series.filter((s) => s.key === pick);
    return list.length ? combine(list) : null;
  }, [series, pick]);
  const slots = useMemo(() => (chosen && data?.from ? grid(chosen.points, data.from, data.to, data.bucketSeconds) : []), [chosen, data]);

  if (!url) return null;
  const hasData = !!chosen && chosen.points.length > 0;
  const s = chosen?.summary;
  const memLimitShown = s && s.memLimit > 0 && s.memMax > 0 && s.memMax > s.memLimit * 0.05;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <h3 className="text-sm font-semibold text-text-primary mr-auto">{title}</h3>
        {series.length > 1 && (
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Service" className="bg-bg-secondary border border-border rounded-lg text-xs px-2 py-1 text-text-primary">
            <option value="all">All services</option>
            {series.map((x) => <option key={x.key} value={x.key}>{seriesLabel(x.key, x.service, x.container)}</option>)}
          </select>
        )}
        <RangePicker value={range} onChange={setRange} />
        {hasData && (
          <button onClick={() => setTable((v) => !v)} className="text-xs text-accent hover:underline">{table ? "Charts" : "Table"}</button>
        )}
      </div>

      {!data && !failed && <div className="h-40 animate-pulse rounded-lg bg-bg-secondary" />}
      {failed && <p className="text-sm text-text-muted">Couldn&apos;t load usage history.</p>}
      {data && !hasData && (
        <p className="text-sm text-text-muted">No usage recorded for this range yet. DeployNow samples running containers every minute, so the first points appear a couple of minutes after a container starts.</p>
      )}

      {hasData && s && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
            <Stat label="CPU average" value={pct(s.cpuAvg)} sub={`peak ${pct(s.cpuMax)}`} />
            <Stat label="Memory average" value={formatBytes(s.memAvg)} sub={`peak ${formatBytes(s.memMax)}${memLimitShown ? ` of ${formatBytes(s.memLimit)}` : ""}`} />
            <Stat label="Network in / out" value={`${formatBytes(s.netRx)} / ${formatBytes(s.netTx)}`} sub={`over ${range}`} />
            <Stat label="Disk read / write" value={`${formatBytes(s.blkRead)} / ${formatBytes(s.blkWrite)}`} sub={`over ${range}`} />
          </div>

          {!table ? (
            <div className="grid gap-6 md:grid-cols-2">
              <Chart title="CPU (100% = one core)" slots={slots} range={range} hover={hover} setHover={setHover} format={pct} yMin={1}
                lines={[{ label: "CPU", color: C1, value: (p) => p.cpu, band: range === "1h" ? undefined : (p) => p.cpuMax }]} />
              <Chart title="Memory" slots={slots} range={range} hover={hover} setHover={setHover} format={formatBytes} yMin={1024 * 1024}
                lines={[{ label: "Memory", color: C1, value: (p) => p.mem, band: range === "1h" ? undefined : (p) => p.memMax }]} />
              <Chart title="Network" slots={slots} range={range} hover={hover} setHover={setHover} format={rate} yMin={1024}
                lines={[{ label: "In", color: C1, value: (p) => p.rx }, { label: "Out", color: C2, value: (p) => p.tx }]} />
              <Chart title="Disk I/O" slots={slots} range={range} hover={hover} setHover={setHover} format={rate} yMin={1024}
                lines={[{ label: "Read", color: C1, value: (p) => p.read }, { label: "Write", color: C2, value: (p) => p.write }]} />
            </div>
          ) : (
            <div className="max-h-80 overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs tabular-nums">
                <thead className="sticky top-0 bg-bg-secondary text-text-muted">
                  <tr>{["Time", "CPU", "CPU peak", "Memory", "Memory peak", "Net in", "Net out", "Disk read", "Disk write"].map((h) => <th key={h} className="text-left font-medium px-2 py-1.5 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {[...chosen!.points].reverse().map((p) => (
                    <tr key={p.t} className="border-t border-border text-text-secondary">
                      <td className="px-2 py-1 whitespace-nowrap">{fmtTime(p.t, range)}</td>
                      <td className="px-2 py-1">{pct(p.cpu)}</td>
                      <td className="px-2 py-1">{pct(p.cpuMax)}</td>
                      <td className="px-2 py-1">{formatBytes(p.mem)}</td>
                      <td className="px-2 py-1">{formatBytes(p.memMax)}</td>
                      <td className="px-2 py-1">{rate(p.rx)}</td>
                      <td className="px-2 py-1">{rate(p.tx)}</td>
                      <td className="px-2 py-1">{rate(p.read)}</td>
                      <td className="px-2 py-1">{rate(p.write)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

interface UsageRow extends Summary { key: string; container: string; service: string; app: { id: string; name: string } | null }

/** Every container on an endpoint, busiest first, over a range. */
export function ContainerUsageTable({ endpointId }: { endpointId: string }) {
  const api = useApi();
  const [range, setRange] = useState<Range>("24h");
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  useEffect(() => {
    api<{ containers: UsageRow[] }>(`/api/endpoints/${endpointId}/container-usage?range=${range}`).then((r) => setRows(r.ok ? (r.data as { containers: UsageRow[] }).containers : []));
  }, [api, endpointId, range]);
  if (rows && rows.length === 0 && range === "24h") return null;
  return (
    <Card className="p-5 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-text-primary mr-auto">Container usage</h3>
        <RangePicker value={range} onChange={setRange} />
      </div>
      {!rows ? (
        <div className="h-24 animate-pulse rounded-lg bg-bg-secondary" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing recorded in this range.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead className="text-text-muted">
              <tr>{["Container", "CPU avg", "CPU peak", "Memory avg", "Memory peak", "Net in / out", "Disk read / write"].map((h) => <th key={h} className="text-left font-medium px-2 py-1.5 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border text-text-secondary">
                  <td className="px-2 py-1.5 min-w-0">
                    {r.app ? (
                      <Link href={`/apps/${r.app.id}`} className="text-text-primary hover:text-accent">{r.app.name}{r.service ? ` / ${seriesLabel(r.key, r.service, r.container)}` : ""}</Link>
                    ) : (
                      <span className="font-mono text-text-primary">{r.container}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">{pct(r.cpuAvg)}</td>
                  <td className="px-2 py-1.5">{pct(r.cpuMax)}</td>
                  <td className="px-2 py-1.5">{formatBytes(r.memAvg)}</td>
                  <td className="px-2 py-1.5">{formatBytes(r.memMax)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{formatBytes(r.netRx)} / {formatBytes(r.netTx)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{formatBytes(r.blkRead)} / {formatBytes(r.blkWrite)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
