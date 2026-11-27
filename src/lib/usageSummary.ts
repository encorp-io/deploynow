/**
 * Usage summaries built on the container history (containerMetrics.ts): what
 * each app's services use right now and over a range, the app totals, and
 * small trend lines for the dashboard, the project page and Monitoring.
 */
import type { Range, Series } from "./containerMetrics";

export interface UsageNow {
  cpu: number; // %, 100 = one core
  mem: number; // bytes
  memLimit: number;
  rx: number; // bytes per second
  tx: number;
}

export interface UsageAvg extends UsageNow {
  cpuMax: number;
  memMax: number;
}

export interface ServiceUsage {
  /** Series key without the replica suffix: app:<id>:<service> or name:<container> */
  key: string;
  service: string;
  container: string;
  endpointId: string;
  replicas: number;
  /** Latest sample, when it is recent (the container is running) */
  now: UsageNow | null;
  avg: UsageAvg;
  lastSeen: string | null;
  /** CPU % per bucket over the range, oldest first (at most TREND_POINTS) */
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

export interface History {
  range: Range;
  from: string;
  to: string;
  bucketSeconds: number;
  series: Series[];
}

export const TREND_POINTS = 48;
/** A latest point older than this means the container is not running now. */
const FRESH_MS = 3 * 60_000;

const zero = (): UsageAvg => ({ cpu: 0, cpuMax: 0, mem: 0, memMax: 0, memLimit: 0, rx: 0, tx: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;

/** app:<id>:web#2 → app:<id>:web */
export const baseKey = (key: string) => key.replace(/#\d+$/, "");
export const appIdOf = (key: string) => (key.startsWith("app:") ? key.split(":")[1] : "");

/** Averages adjacent values so a long series fits in `max` points. */
export function downsample(values: number[], max = TREND_POINTS): number[] {
  if (values.length <= max) return values.map(round2);
  const out: number[] = [];
  const step = values.length / max;
  for (let i = 0; i < max; i++) {
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.floor((i + 1) * step));
    const slice = values.slice(a, b);
    out.push(round2(slice.reduce((s, v) => s + v, 0) / slice.length));
  }
  return out;
}

interface Grid {
  start: number;
  step: number;
  n: number;
}

function gridOf(h: Pick<History, "from" | "to" | "bucketSeconds">): Grid {
  const start = new Date(h.from).getTime();
  const step = h.bucketSeconds * 1000;
  return { start, step, n: Math.max(1, Math.floor((new Date(h.to).getTime() - start) / step) + 1) };
}

/** Sums the series bucket by bucket on the full grid (missing buckets count as zero). */
function sumOnGrid(series: Series[], g: Grid, f: (p: Series["points"][number]) => number): number[] {
  const out = Array<number>(g.n).fill(0);
  for (const s of series) {
    for (const p of s.points) {
      const i = Math.round((new Date(p.t).getTime() - g.start) / g.step);
      if (i >= 0 && i < g.n) out[i] += f(p);
    }
  }
  return out;
}

function latestOf(series: Series[], now: number): { now: UsageNow | null; lastSeen: string | null } {
  let last = 0;
  const cur: UsageNow = { cpu: 0, mem: 0, memLimit: 0, rx: 0, tx: 0 };
  let live = 0;
  for (const s of series) {
    const p = s.points[s.points.length - 1];
    if (!p) continue;
    const t = new Date(p.t).getTime();
    last = Math.max(last, t);
    // the last bucket starts up to one bucket before the sample, so allow for it
    if (now - t > FRESH_MS + bucketMs(s)) continue;
    live++;
    cur.cpu += p.cpu;
    cur.mem += p.mem;
    cur.memLimit += p.memLimit;
    cur.rx += p.rx;
    cur.tx += p.tx;
  }
  return { now: live ? { ...cur, cpu: round2(cur.cpu) } : null, lastSeen: last ? new Date(last).toISOString() : null };
}

function bucketMs(s: Series): number {
  const [a, b] = s.points.slice(-2);
  return a && b ? new Date(b.t).getTime() - new Date(a.t).getTime() : 60_000;
}

/** Averages over the range: rates are the mean of the bucket values, peaks the highest bucket. */
function averageOf(series: Series[], g: Grid): UsageAvg {
  if (!series.length) return zero();
  const covered = new Set<number>();
  for (const s of series) for (const p of s.points) covered.add(Math.round((new Date(p.t).getTime() - g.start) / g.step));
  const n = covered.size || 1;
  const cpu = sumOnGrid(series, g, (p) => p.cpu);
  const cpuMax = sumOnGrid(series, g, (p) => p.cpuMax);
  const mem = sumOnGrid(series, g, (p) => p.mem);
  const memMax = sumOnGrid(series, g, (p) => p.memMax);
  const rx = sumOnGrid(series, g, (p) => p.rx);
  const tx = sumOnGrid(series, g, (p) => p.tx);
  const total = (a: number[]) => a.reduce((s, v) => s + v, 0);
  return {
    cpu: round2(total(cpu) / n),
    cpuMax: round2(Math.max(0, ...cpuMax)),
    mem: Math.round(total(mem) / n),
    memMax: Math.round(Math.max(0, ...memMax)),
    memLimit: series.reduce((s, x) => s + x.summary.memLimit, 0),
    rx: Math.round(total(rx) / n),
    tx: Math.round(total(tx) / n),
  };
}

/** Index of the last bucket any series has a point in, so trends do not end in an empty bucket. */
function lastFilled(series: Series[], g: Grid): number {
  let last = -1;
  for (const s of series) {
    const p = s.points[s.points.length - 1];
    if (p) last = Math.max(last, Math.round((new Date(p.t).getTime() - g.start) / g.step));
  }
  return Math.min(last, g.n - 1);
}

function combine(series: Series[], g: Grid, now: number) {
  const latest = latestOf(series, now);
  // The bucket in progress usually has no sample yet: stop the line at the last one with data
  const end = Math.max(lastFilled(series, g), g.n - 2) + 1;
  return {
    ...latest,
    avg: averageOf(series, g),
    trend: downsample(sumOnGrid(series, g, (p) => p.cpu).slice(0, end)),
    memTrend: downsample(sumOnGrid(series, g, (p) => p.mem).slice(0, end)),
  };
}

/** Groups compose replicas into one row per service. */
export function servicesOf(h: History, now = Date.now()): ServiceUsage[] {
  const g = gridOf(h);
  const groups = new Map<string, Series[]>();
  for (const s of h.series) {
    const k = `${s.endpointId}\u0000${baseKey(s.key)}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups.values()]
    .map((list) => {
      const first = list[0];
      return {
        key: baseKey(first.key),
        service: first.service,
        container: list[list.length - 1].container,
        endpointId: first.endpointId,
        replicas: list.length,
        ...combine(list, g, now),
      };
    })
    .sort((a, b) => (b.now?.cpu ?? -1) - (a.now?.cpu ?? -1) || b.avg.cpu - a.avg.cpu || (a.service || a.container).localeCompare(b.service || b.container));
}

/** One entry per app (by id) with its services and the app total. Non-app series are left out. */
export function appsOf(h: History, now = Date.now()): Map<string, AppUsage> {
  const g = gridOf(h);
  const byApp = new Map<string, Series[]>();
  for (const s of h.series) {
    const id = appIdOf(s.key);
    if (!id) continue;
    byApp.set(id, [...(byApp.get(id) ?? []), s]);
  }
  const out = new Map<string, AppUsage>();
  for (const [appId, list] of byApp) {
    const services = servicesOf({ ...h, series: list }, now);
    out.set(appId, { appId, services, ...combine(list, g, now) });
  }
  return out;
}

/** Series of containers DeployNow did not deploy (name:<container>), grouped like services. */
export function unmanagedOf(h: History, now = Date.now()): ServiceUsage[] {
  return servicesOf({ ...h, series: h.series.filter((s) => !appIdOf(s.key)) }, now);
}

// ─── Hosts ─────────────────────────────────────────────────────────────────────

export interface HostSample {
  endpointId: string;
  at: Date;
  cpus: number;
  load1: number;
  memTotal: number;
  memUsed: number;
}

/**
 * Host CPU (load per core, %) and memory (% used) per bucket for each endpoint,
 * and for the whole fleet (load and memory added up across hosts). A bucket with
 * no samples repeats the previous one so the lines stay continuous; buckets
 * before a host's first sample stay empty.
 */
export function hostTrends(samples: HostSample[], from: number, bucketMs: number, n: number) {
  const per = new Map<string, { cpu: number[]; mem: number[]; load: number[]; cpus: number[]; used: number[]; total: number[] }>();
  const acc = new Map<string, { load: number; cpus: number; used: number; total: number; c: number }[]>();
  for (const s of samples) {
    const i = Math.floor((s.at.getTime() - from) / bucketMs);
    if (i < 0 || i >= n) continue;
    let a = acc.get(s.endpointId);
    if (!a) acc.set(s.endpointId, (a = Array.from({ length: n }, () => ({ load: 0, cpus: 0, used: 0, total: 0, c: 0 }))));
    a[i].load += s.load1;
    a[i].cpus += s.cpus;
    a[i].used += s.memUsed;
    a[i].total += s.memTotal;
    a[i].c++;
  }
  for (const [id, a] of acc) {
    const row = { cpu: [] as number[], mem: [] as number[], load: [] as number[], cpus: [] as number[], used: [] as number[], total: [] as number[] };
    // Before the first sample nothing was observed: those buckets stay empty (zero, and left out of the fleet)
    let prev = { load: 0, cpus: 0, used: 0, total: 0, c: 0 };
    for (const b of a) {
      const cur = b.c ? b : prev;
      prev = cur;
      const c = cur.c || 1;
      const load = cur.load / c;
      const cpus = cur.cpus / c;
      const used = cur.used / c;
      const total = cur.total / c;
      row.load.push(load);
      row.cpus.push(cpus);
      row.used.push(used);
      row.total.push(total);
      row.cpu.push(round2(cpus ? Math.min(100, (load / cpus) * 100) : 0));
      row.mem.push(round2(total ? (used / total) * 100 : 0));
    }
    per.set(id, row);
  }
  const fleetCpu: number[] = [];
  const fleetMem: number[] = [];
  for (let i = 0; i < n; i++) {
    let load = 0, cpus = 0, used = 0, total = 0;
    for (const r of per.values()) {
      load += r.load[i];
      cpus += r.cpus[i];
      used += r.used[i];
      total += r.total[i];
    }
    fleetCpu.push(round2(cpus ? Math.min(100, (load / cpus) * 100) : 0));
    fleetMem.push(round2(total ? (used / total) * 100 : 0));
  }
  return {
    endpoints: new Map([...per].map(([id, r]) => [id, { cpu: r.cpu, mem: r.mem }])),
    fleet: { cpu: fleetCpu, mem: fleetMem },
  };
}
