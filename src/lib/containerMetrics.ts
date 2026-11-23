/**
 * Container resource history.
 *
 * Every minute, each online endpoint's running containers are sampled (CPU,
 * memory, network, block I/O, processes) and stored as ContainerSample rows.
 * Each hour the raw samples are rolled up into ContainerUsageHourly. Raw
 * samples are kept for RAW_KEEP (a little over a day); hourly rollups for
 * DEPLOYNOW_METRICS_RETENTION_DAYS (default 30, at most 365). Set
 * CONTAINER_METRICS=off to stop collecting.
 *
 * The same rows feed the charts in the app and the Prometheus endpoint
 * (/api/metrics), which reads the latest sample of each container.
 */
import type Docker from "dockerode";
import type { Endpoint } from "@prisma/client";
import { prisma } from "./prisma";
import { dockerFor } from "./endpoints";
import { summarizeStats } from "./docker/stats";
import { withTimeout } from "./docker/client";

const MINUTE = 60_000;
const HOUR = 3600_000;
export const RAW_KEEP = 26 * HOUR;
const STATS_TIMEOUT = 15_000;
const PER_ENDPOINT_CONCURRENCY = 4;

export function retentionDays(): number {
  const n = Number(process.env.DEPLOYNOW_METRICS_RETENTION_DAYS ?? 30);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 365) : 30;
}

// ─── Sampling ──────────────────────────────────────────────────────────────────

export interface RawSample {
  containerId: string;
  containerName: string;
  applicationId: string;
  service: string;
  at: number; // ms
  cpuNs: number; // cumulative container CPU time
  memUsage: number;
  memLimit: number;
  netRx: number; // cumulative
  netTx: number;
  blkRead: number;
  blkWrite: number;
  pids: number;
}

interface Prev {
  at: number;
  cpuNs: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
}

interface CollectorState {
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  prev: Map<string, Prev>; // by container id
  rolledHour: number; // start of the last hour that was rolled up
}
const g = globalThis as unknown as { __deploynowContainerMetrics?: CollectorState };
const state: CollectorState = (g.__deploynowContainerMetrics ??= { timer: null, ticking: false, prev: new Map(), rolledHour: 0 });

/** Series key: stable across redeploys for app containers. */
export function seriesKey(applicationId: string, service: string, containerName: string): string {
  return applicationId ? `app:${applicationId}:${service || "app"}` : `name:${containerName}`;
}

/** Counter delta that survives a reset (container restarted): the new value counts from zero. */
export function counterDelta(cur: number, prev: number): number {
  return cur >= prev ? cur - prev : cur;
}

/** Turns a raw reading and the previous one into the values stored for the interval. */
export function intervalValues(cur: RawSample, prev: Prev | undefined) {
  const seconds = prev && cur.at > prev.at ? (cur.at - prev.at) / 1000 : 0;
  if (!prev || seconds <= 0 || seconds > 15 * 60) {
    return { seconds: 0, cpuPercent: 0, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 };
  }
  const cpuNs = counterDelta(cur.cpuNs, prev.cpuNs);
  return {
    seconds,
    cpuPercent: Math.round((cpuNs / 1e9 / seconds) * 100 * 100) / 100,
    netRx: counterDelta(cur.netRx, prev.netRx),
    netTx: counterDelta(cur.netTx, prev.netTx),
    blkRead: counterDelta(cur.blkRead, prev.blkRead),
    blkWrite: counterDelta(cur.blkWrite, prev.blkWrite),
  };
}

export function rawFromStats(c: Docker.ContainerInfo, s: Docker.ContainerStats, at: number, appBySlug: Map<string, string>): RawSample {
  const sum = summarizeStats(s);
  const labels = c.Labels ?? {};
  const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
  const composeProject = labels["com.docker.compose.project"] ?? "";
  const applicationId = labels["deploynow.app"] || (composeProject ? appBySlug.get(composeProject) ?? "" : "");
  const service = labels["deploynow.service"] || labels["com.docker.compose.service"] || "";
  return {
    containerId: c.Id,
    containerName: name,
    applicationId,
    service,
    at,
    cpuNs: s.cpu_stats?.cpu_usage?.total_usage ?? 0,
    memUsage: sum.memoryUsage,
    memLimit: sum.memoryLimit,
    netRx: sum.networkRx,
    netTx: sum.networkTx,
    blkRead: sum.blockRead,
    blkWrite: sum.blockWrite,
    pids: sum.pids,
  };
}

async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

async function previousFor(containerId: string, now: number): Promise<Prev | undefined> {
  const mem = state.prev.get(containerId);
  if (mem) return mem;
  // After a restart of DeployNow: the last stored sample, if recent
  const row = await prisma.containerSample.findFirst({
    where: { containerId, at: { gte: new Date(now - 10 * MINUTE) } },
    orderBy: { at: "desc" },
  });
  if (!row) return undefined;
  return { at: row.at.getTime(), cpuNs: row.cpuSecondsTotal * 1e9, netRx: row.netRxTotal, netTx: row.netTxTotal, blkRead: row.blkReadTotal, blkWrite: row.blkWriteTotal };
}

/** Stores one sample. Exported for tests. */
export async function storeSample(endpointId: string, raw: RawSample) {
  const prev = await previousFor(raw.containerId, raw.at);
  const iv = intervalValues(raw, prev);
  state.prev.set(raw.containerId, { at: raw.at, cpuNs: raw.cpuNs, netRx: raw.netRx, netTx: raw.netTx, blkRead: raw.blkRead, blkWrite: raw.blkWrite });
  await prisma.containerSample.create({
    data: {
      endpointId,
      key: seriesKey(raw.applicationId, raw.service, raw.containerName),
      containerId: raw.containerId,
      containerName: raw.containerName,
      applicationId: raw.applicationId,
      service: raw.service,
      at: new Date(raw.at),
      ...iv,
      memUsage: raw.memUsage,
      memLimit: raw.memLimit,
      pids: raw.pids,
      cpuSecondsTotal: raw.cpuNs / 1e9,
      netRxTotal: raw.netRx,
      netTxTotal: raw.netTx,
      blkReadTotal: raw.blkRead,
      blkWriteTotal: raw.blkWrite,
    },
  });
}

/** Samples every running container on one endpoint. Returns how many were stored. */
export async function collectEndpoint(e: Endpoint, docker: Docker = dockerFor(e)): Promise<number> {
  const containers = await withTimeout(docker.listContainers({ all: false }), 15_000, "Listing containers");
  const apps = await prisma.application.findMany({ where: { endpointId: e.id }, select: { id: true, slug: true } });
  const appBySlug = new Map(apps.map((a) => [a.slug, a.id]));
  let stored = 0;
  const running = containers.filter((c) => !c.Labels?.["deploynow.helper"]);
  await mapLimit(running, PER_ENDPOINT_CONCURRENCY, async (c) => {
    try {
      // one-shot: no second reading for precpu; CPU is worked out from our own minute-apart samples
      const s = (await withTimeout(
        docker.getContainer(c.Id).stats({ stream: false, "one-shot": true } as { stream: false }) as Promise<Docker.ContainerStats>,
        STATS_TIMEOUT,
        "Reading stats",
      )) as Docker.ContainerStats;
      await storeSample(e.id, rawFromStats(c, s, Date.now(), appBySlug));
      stored++;
    } catch {
      // the container stopped in between, or the daemon is slow: skip it this minute
    }
  });
  // Forget containers that are gone
  const live = new Set(running.map((c) => c.Id));
  for (const id of state.prev.keys()) if (!live.has(id) && (state.prev.get(id)?.at ?? 0) < Date.now() - 30 * MINUTE) state.prev.delete(id);
  return stored;
}

// ─── Rollups and retention ─────────────────────────────────────────────────────

/** Aggregates raw rows (one series, one hour) into an hourly rollup. */
export function aggregate(rows: { seconds: number; cpuPercent: number; memUsage: number; memLimit: number; netRx: number; netTx: number; blkRead: number; blkWrite: number }[]) {
  const withRate = rows.filter((r) => r.seconds > 0);
  const out = { samples: rows.length, cpuAvg: 0, cpuMax: 0, memAvg: 0, memMax: 0, memLimit: 0, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 };
  if (!rows.length) return out;
  let secs = 0;
  let cpuWeighted = 0;
  for (const r of withRate) {
    secs += r.seconds;
    cpuWeighted += r.cpuPercent * r.seconds;
    out.cpuMax = Math.max(out.cpuMax, r.cpuPercent);
    out.netRx += r.netRx;
    out.netTx += r.netTx;
    out.blkRead += r.blkRead;
    out.blkWrite += r.blkWrite;
  }
  out.cpuAvg = secs > 0 ? Math.round((cpuWeighted / secs) * 100) / 100 : 0;
  let mem = 0;
  for (const r of rows) {
    mem += r.memUsage;
    out.memMax = Math.max(out.memMax, r.memUsage);
    out.memLimit = Math.max(out.memLimit, r.memLimit);
  }
  out.memAvg = Math.round(mem / rows.length);
  return out;
}

/** (Re)builds the hourly rollups for hours starting in [fromHour, toHour). Idempotent. */
export async function rollup(fromHour: number, toHour: number) {
  if (toHour <= fromHour) return 0;
  const rows = await prisma.containerSample.findMany({
    where: { at: { gte: new Date(fromHour), lt: new Date(toHour) } },
    orderBy: { at: "asc" },
    select: { endpointId: true, key: true, containerName: true, applicationId: true, service: true, at: true, seconds: true, cpuPercent: true, memUsage: true, memLimit: true, netRx: true, netTx: true, blkRead: true, blkWrite: true },
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const hour = Math.floor(r.at.getTime() / HOUR) * HOUR;
    const k = `${r.endpointId}\u0000${r.key}\u0000${hour}`;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  const data = [...groups.entries()].map(([k, list]) => {
    const [endpointId, key, hour] = k.split("\u0000");
    const last = list[list.length - 1];
    return { endpointId, key, hour: new Date(Number(hour)), containerName: last.containerName, applicationId: last.applicationId, service: last.service, ...aggregate(list) };
  });
  await prisma.$transaction([
    prisma.containerUsageHourly.deleteMany({ where: { hour: { gte: new Date(fromHour), lt: new Date(toHour) } } }),
    prisma.containerUsageHourly.createMany({ data }),
  ]);
  return data.length;
}

export async function prune(now = Date.now()) {
  await prisma.containerSample.deleteMany({ where: { at: { lt: new Date(now - RAW_KEEP) } } });
  await prisma.containerUsageHourly.deleteMany({ where: { hour: { lt: new Date(now - retentionDays() * 24 * HOUR) } } });
}

/** Rolls up finished hours not done yet (on start: the whole raw window), then prunes. */
export async function maybeRollup(now = Date.now()) {
  const thisHour = Math.floor(now / HOUR) * HOUR;
  if (state.rolledHour >= thisHour) return;
  // Only hours whose raw samples are all still kept
  const earliest = Math.floor((now - RAW_KEEP) / HOUR) * HOUR + HOUR;
  await rollup(Math.max(state.rolledHour, earliest), thisHour);
  state.rolledHour = thisHour;
  await prune(now);
}

// ─── Loop ──────────────────────────────────────────────────────────────────────

export async function collectTick() {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const endpoints = await prisma.endpoint.findMany({ where: { status: "online" } });
    await Promise.all(endpoints.map((e) => collectEndpoint(e).catch(() => 0)));
    await maybeRollup();
  } catch (err) {
    console.error("[metrics] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    state.ticking = false;
  }
}

export function startContainerMetrics() {
  if (state.timer || process.env.CONTAINER_METRICS === "off") return;
  state.timer = setInterval(() => void collectTick(), MINUTE);
  state.timer.unref?.();
  setTimeout(() => void collectTick(), 20_000).unref?.();
}

export function stopContainerMetrics() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** For tests */
export function resetCollectorState() {
  state.prev.clear();
  state.rolledHour = 0;
}

// ─── Reading ───────────────────────────────────────────────────────────────────

export const RANGES = {
  "1h": { ms: HOUR, bucket: MINUTE, source: "raw" },
  "6h": { ms: 6 * HOUR, bucket: 2 * MINUTE, source: "raw" },
  "24h": { ms: 24 * HOUR, bucket: 5 * MINUTE, source: "raw" },
  "7d": { ms: 7 * 24 * HOUR, bucket: HOUR, source: "hourly" },
  "30d": { ms: 30 * 24 * HOUR, bucket: 3 * HOUR, source: "hourly" },
} as const;
export type Range = keyof typeof RANGES;

export function parseRange(v: string | null): Range {
  return v && v in RANGES ? (v as Range) : "24h";
}

export interface Point {
  t: string; // bucket start (ISO)
  cpu: number; // average %, 100 = one core
  cpuMax: number;
  mem: number; // average bytes
  memMax: number;
  memLimit: number;
  rx: number; // bytes per second
  tx: number;
  read: number;
  write: number;
}

export interface Series {
  key: string;
  service: string;
  container: string;
  endpointId: string;
  points: Point[];
  summary: { cpuAvg: number; cpuMax: number; memAvg: number; memMax: number; memLimit: number; netRx: number; netTx: number; blkRead: number; blkWrite: number };
}

interface Unit {
  endpointId: string;
  key: string;
  containerName: string;
  service: string;
  at: number;
  seconds: number; // seconds of activity this row covers (rates)
  samples: number; // weight for memory averages
  cpuAvg: number;
  cpuMax: number;
  memAvg: number;
  memMax: number;
  memLimit: number;
  netRx: number;
  netTx: number;
  blkRead: number;
  blkWrite: number;
}

/** Buckets rows of one series into points and a summary. Exported for tests. */
export function toSeries(units: Unit[], from: number, bucketMs: number): Omit<Series, "key" | "service" | "container" | "endpointId"> {
  const buckets = new Map<number, Unit[]>();
  for (const u of units) {
    const b = from + Math.floor((u.at - from) / bucketMs) * bucketMs;
    const list = buckets.get(b);
    if (list) list.push(u);
    else buckets.set(b, [u]);
  }
  const points: Point[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([b, list]) => {
      const secs = list.reduce((s, u) => s + u.seconds, 0);
      const n = list.reduce((s, u) => s + u.samples, 0) || 1;
      const sum = (f: (u: Unit) => number) => list.reduce((s, u) => s + f(u), 0);
      const rate = (f: (u: Unit) => number) => (secs > 0 ? Math.round(sum(f) / secs) : 0);
      return {
        t: new Date(b).toISOString(),
        cpu: secs > 0 ? Math.round((sum((u) => u.cpuAvg * u.seconds) / secs) * 100) / 100 : 0,
        cpuMax: Math.max(...list.map((u) => u.cpuMax)),
        mem: Math.round(sum((u) => u.memAvg * u.samples) / n),
        memMax: Math.max(...list.map((u) => u.memMax)),
        memLimit: Math.max(...list.map((u) => u.memLimit)),
        rx: rate((u) => u.netRx),
        tx: rate((u) => u.netTx),
        read: rate((u) => u.blkRead),
        write: rate((u) => u.blkWrite),
      };
    });
  const secs = units.reduce((s, u) => s + u.seconds, 0);
  const n = units.reduce((s, u) => s + u.samples, 0) || 1;
  const total = (f: (u: Unit) => number) => units.reduce((s, u) => s + f(u), 0);
  return {
    points,
    summary: {
      cpuAvg: secs > 0 ? Math.round((total((u) => u.cpuAvg * u.seconds) / secs) * 100) / 100 : 0,
      cpuMax: units.length ? Math.max(...units.map((u) => u.cpuMax)) : 0,
      memAvg: Math.round(total((u) => u.memAvg * u.samples) / n),
      memMax: units.length ? Math.max(...units.map((u) => u.memMax)) : 0,
      memLimit: units.length ? Math.max(...units.map((u) => u.memLimit)) : 0,
      netRx: total((u) => u.netRx),
      netTx: total((u) => u.netTx),
      blkRead: total((u) => u.blkRead),
      blkWrite: total((u) => u.blkWrite),
    },
  };
}

/**
 * Usage history for the series matching `where` (by app, or by endpoint + key).
 * Short ranges read raw samples; 7 and 30 days read the hourly rollups.
 */
export async function readHistory(where: { applicationId?: string; endpointId?: string; key?: string }, range: Range, now = Date.now()): Promise<{ range: Range; from: string; to: string; bucketSeconds: number; series: Series[] }> {
  const r = RANGES[range];
  const from = Math.floor((now - r.ms) / r.bucket) * r.bucket;
  let units: Unit[];
  if (r.source === "raw") {
    const rows = await prisma.containerSample.findMany({
      where: { ...where, at: { gte: new Date(from) } },
      orderBy: { at: "asc" },
      select: { endpointId: true, key: true, containerName: true, service: true, at: true, seconds: true, cpuPercent: true, memUsage: true, memLimit: true, netRx: true, netTx: true, blkRead: true, blkWrite: true },
    });
    units = rows.map((x) => ({ endpointId: x.endpointId, key: x.key, containerName: x.containerName, service: x.service, at: x.at.getTime(), seconds: x.seconds, samples: 1, cpuAvg: x.cpuPercent, cpuMax: x.seconds > 0 ? x.cpuPercent : 0, memAvg: x.memUsage, memMax: x.memUsage, memLimit: x.memLimit, netRx: x.netRx, netTx: x.netTx, blkRead: x.blkRead, blkWrite: x.blkWrite }));
  } else {
    const rows = await prisma.containerUsageHourly.findMany({ where: { ...where, hour: { gte: new Date(from) } }, orderBy: { hour: "asc" } });
    // The hour in progress is not rolled up yet: add it from raw samples so the chart reaches now
    const lastHour = Math.floor(now / HOUR) * HOUR;
    const recent = await prisma.containerSample.findMany({
      where: { ...where, at: { gte: new Date(lastHour) } },
      select: { endpointId: true, key: true, containerName: true, applicationId: true, service: true, seconds: true, cpuPercent: true, memUsage: true, memLimit: true, netRx: true, netTx: true, blkRead: true, blkWrite: true },
    });
    const partial = new Map<string, typeof recent>();
    for (const x of recent) partial.set(`${x.endpointId}\u0000${x.key}`, [...(partial.get(`${x.endpointId}\u0000${x.key}`) ?? []), x]);
    const extra = [...partial.values()].map((list) => {
      const last = list[list.length - 1];
      return { endpointId: last.endpointId, key: last.key, containerName: last.containerName, service: last.service, hour: new Date(lastHour), ...aggregate(list) };
    });
    units = [...rows.filter((x) => x.hour.getTime() < lastHour), ...extra].map((x) => ({
      endpointId: x.endpointId,
      key: x.key,
      containerName: x.containerName,
      service: x.service,
      at: x.hour.getTime(),
      // Rates over the hour: use the covered seconds (samples are a minute apart)
      seconds: x.samples * 60,
      samples: x.samples,
      cpuAvg: x.cpuAvg,
      cpuMax: x.cpuMax,
      memAvg: x.memAvg,
      memMax: x.memMax,
      memLimit: x.memLimit,
      netRx: x.netRx,
      netTx: x.netTx,
      blkRead: x.blkRead,
      blkWrite: x.blkWrite,
    }));
  }
  const bySeries = new Map<string, Unit[]>();
  for (const u of units) {
    const k = `${u.endpointId}\u0000${u.key}`;
    const list = bySeries.get(k);
    if (list) list.push(u);
    else bySeries.set(k, [u]);
  }
  const series: Series[] = [...bySeries.values()].map((list) => {
    const last = list[list.length - 1];
    return { key: last.key, service: last.service, container: last.containerName, endpointId: last.endpointId, ...toSeries(list, from, r.bucket) };
  });
  series.sort((a, b) => (a.service || a.container).localeCompare(b.service || b.container));
  return { range, from: new Date(from).toISOString(), to: new Date(now).toISOString(), bucketSeconds: r.bucket / 1000, series };
}

/** The latest sample of every container seen in the last few minutes (for /api/metrics). */
export async function latestSamples(maxAgeMs = 3 * MINUTE, now = Date.now()) {
  const rows = await prisma.containerSample.findMany({ where: { at: { gte: new Date(now - maxAgeMs) } }, orderBy: { at: "desc" } });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.containerId) ? false : (seen.add(r.containerId), true)));
}
