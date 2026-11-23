/**
 * Uptime checks, StatusCake style: DeployNow requests a URL (or opens a TCP
 * port) on an interval, keeps the response times, opens an incident and sends
 * "uptime.down" after a few failures in a row, "uptime.up" when it answers
 * again, and "uptime.cert" when an HTTPS certificate is about to expire.
 *
 * Results are kept 14 days, daily totals 90 days. Checks marked public are
 * listed on the status page (/status) when it is turned on.
 */
import net from "net";
import tls from "tls";
import type { UptimeCheck } from "@prisma/client";
import { prisma } from "./prisma";
import { notify } from "./notify";
import { publicBaseUrl } from "./publicOrigin";

export const CHECK_TYPES = ["http", "tcp"] as const;
const TICK_MS = 15_000;
const PARALLEL = 10;
const KEEP_RESULTS_MS = 14 * 86400_000;
const KEEP_DAYS = 90;
const CERT_EVERY_MS = 6 * 3600_000;
const MAX_BODY = 1024 * 1024;
const HOST_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export class UptimeError extends Error {}

export interface CheckInput {
  name: string;
  type: (typeof CHECK_TYPES)[number];
  target: string;
  applicationId: string | null;
  intervalSec: number;
  timeoutMs: number;
  expectStatus: string;
  keyword: string;
  failThreshold: number;
  certWarnDays: number;
  enabled: boolean;
  public: boolean;
}

function int(v: unknown, fallback: number, min: number, max: number, what: string): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UptimeError(`${what} must be between ${min} and ${max}`);
  return n;
}

export function parseTcpTarget(target: string): { host: string; port: number } {
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target.trim());
  if (!m) throw new UptimeError("Enter the TCP target as host:port, e.g. db.example.com:5432");
  const host = m[1];
  const port = Number(m[2]);
  if (!(HOST_RE.test(host) || net.isIP(host))) throw new UptimeError(`"${host}" is not a valid host name`);
  if (port < 1 || port > 65535) throw new UptimeError("The port must be between 1 and 65535");
  return { host, port };
}

export function validateCheck(body: Record<string, unknown>, existing?: UptimeCheck | null): CheckInput {
  const pick = <K extends keyof CheckInput>(k: K): unknown => (body[k] !== undefined ? body[k] : existing?.[k]);
  const name = String(pick("name") ?? "").trim();
  if (!name || name.length > 80) throw new UptimeError("Give the check a name (up to 80 characters)");
  const type = String(pick("type") ?? "http") as CheckInput["type"];
  if (!CHECK_TYPES.includes(type)) throw new UptimeError("The type must be http or tcp");
  let target = String(pick("target") ?? "").trim();
  if (type === "http") {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) target = `https://${target}`;
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new UptimeError("Enter a URL such as https://example.com/health");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new UptimeError("The URL must start with http:// or https://");
    if (target.length > 2000) throw new UptimeError("The URL is too long");
    target = u.toString();
  } else {
    const t = parseTcpTarget(target);
    target = `${t.host.includes(":") ? `[${t.host}]` : t.host}:${t.port}`;
  }
  const expectStatus = type === "http" ? String(pick("expectStatus") ?? "").replace(/\s+/g, "") : "";
  if (expectStatus && !/^([1-5]\d\d)(,[1-5]\d\d)*$/.test(expectStatus)) throw new UptimeError("Expected status codes look like 200 or 200,204");
  const keyword = type === "http" ? String(pick("keyword") ?? "").slice(0, 200) : "";
  const appId = pick("applicationId");
  const applicationId = appId ? String(appId) : null;
  if (applicationId && !/^c[a-z0-9]{20,30}$/.test(applicationId)) throw new UptimeError("Invalid application");
  return {
    name,
    type,
    target,
    applicationId,
    intervalSec: int(pick("intervalSec"), 60, 30, 86400, "The interval"),
    timeoutMs: int(pick("timeoutMs"), 10_000, 1000, 60_000, "The timeout"),
    expectStatus,
    keyword,
    failThreshold: int(pick("failThreshold"), 2, 1, 10, "Failures before down"),
    certWarnDays: type === "http" && target.startsWith("https:") ? int(pick("certWarnDays"), 14, 0, 90, "The certificate warning") : 0,
    enabled: pick("enabled") === undefined ? true : Boolean(pick("enabled")),
    public: Boolean(pick("public") ?? false),
  };
}

// ─── Probing ───────────────────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  statusCode: number | null;
  error: string;
}

function errorText(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "Timed out";
  const code = e?.cause?.code;
  const known: Record<string, string> = {
    ENOTFOUND: "The host name doesn't resolve",
    ECONNREFUSED: "Connection refused",
    ECONNRESET: "Connection reset",
    EHOSTUNREACH: "Host unreachable",
    ETIMEDOUT: "Timed out",
    CERT_HAS_EXPIRED: "The certificate has expired",
    DEPTH_ZERO_SELF_SIGNED_CERT: "Self-signed certificate",
    ERR_TLS_CERT_ALTNAME_INVALID: "The certificate doesn't match the host name",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The certificate can't be verified",
  };
  if (code && known[code]) return known[code];
  return String(e?.cause?.message || e?.message || err).slice(0, 300);
}

async function readBody(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8");
}

export async function probeHttp(c: Pick<UptimeCheck, "target" | "timeoutMs" | "expectStatus" | "keyword">, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const res = await fetchImpl(c.target, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "DeployNow-Uptime/1.0", Accept: "*/*" },
      signal: AbortSignal.timeout(c.timeoutMs),
      cache: "no-store",
    });
    const latencyMs = Math.round(performance.now() - start);
    const expected = c.expectStatus ? c.expectStatus.split(",").map(Number) : null;
    const statusOk = expected ? expected.includes(res.status) : res.status >= 200 && res.status < 400;
    if (!statusOk) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, latencyMs, statusCode: res.status, error: `Answered ${res.status}${expected ? `, expected ${c.expectStatus}` : ""}` };
    }
    if (c.keyword) {
      const body = await readBody(res);
      if (!body.includes(c.keyword)) return { ok: false, latencyMs, statusCode: res.status, error: `The page doesn't contain "${c.keyword}"` };
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return { ok: true, latencyMs, statusCode: res.status, error: "" };
  } catch (err) {
    return { ok: false, latencyMs: null, statusCode: null, error: errorText(err) };
  }
}

export function probeTcp(target: string, timeoutMs: number): Promise<ProbeResult> {
  const { host, port } = parseTcpTarget(target);
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (r: ProbeResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, latencyMs: null, statusCode: null, error: "Timed out" }));
    socket.once("connect", () => done({ ok: true, latencyMs: Math.round(performance.now() - start), statusCode: null, error: "" }));
    socket.once("error", (err) => done({ ok: false, latencyMs: null, statusCode: null, error: errorText({ cause: err, message: err.message }) }));
  });
}

/** When the HTTPS certificate expires, or null when it can't be read. */
export function certExpiry(target: string, timeoutMs = 10_000): Promise<Date | null> {
  const u = new URL(target);
  if (u.protocol !== "https:") return Promise.resolve(null);
  return new Promise((resolve) => {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const socket = tls.connect({ host, port: Number(u.port || 443), servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const done = (d: Date | null) => {
      socket.destroy();
      resolve(d);
    };
    socket.setTimeout(timeoutMs, () => done(null));
    socket.once("secureConnect", () => {
      const validTo = socket.getPeerCertificate()?.valid_to;
      const d = validTo ? new Date(validTo) : null;
      done(d && !isNaN(d.getTime()) ? d : null);
    });
    socket.once("error", () => done(null));
  });
}

export function probe(c: UptimeCheck, fetchImpl?: typeof fetch): Promise<ProbeResult> {
  return c.type === "tcp" ? probeTcp(c.target, c.timeoutMs) : probeHttp(c, fetchImpl);
}

// ─── Recording ─────────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function link(): string | undefined {
  const base = publicBaseUrl();
  return base ? `${base}/uptime` : undefined;
}

/** Save a result, move the check between up and down, and notify on changes. */
export async function recordResult(c: UptimeCheck, r: ProbeResult, now = new Date()): Promise<UptimeCheck> {
  const day = now.toISOString().slice(0, 10);
  await prisma.uptimeResult.create({ data: { checkId: c.id, at: now, ok: r.ok, latencyMs: r.latencyMs, statusCode: r.statusCode, error: r.error } });
  await prisma.uptimeDay.upsert({
    where: { checkId_day: { checkId: c.id, day } },
    create: { checkId: c.id, day, total: 1, up: r.ok ? 1 : 0, latencySum: r.ok ? (r.latencyMs ?? 0) : 0 },
    update: { total: { increment: 1 }, up: { increment: r.ok ? 1 : 0 }, latencySum: { increment: r.ok ? (r.latencyMs ?? 0) : 0 } },
  });

  const fails = r.ok ? 0 : c.consecutiveFails + 1;
  let status = c.status;
  let changed = false;
  if (r.ok && status !== "up") {
    status = "up";
    changed = true;
  } else if (!r.ok && fails >= c.failThreshold && status !== "down") {
    status = "down";
    changed = true;
  }
  const updated = await prisma.uptimeCheck.update({
    where: { id: c.id },
    data: {
      status,
      consecutiveFails: fails,
      lastCheckedAt: now,
      lastLatencyMs: r.latencyMs,
      lastError: r.error,
      nextCheckAt: new Date(now.getTime() + c.intervalSec * 1000),
      ...(changed ? { lastChangeAt: now } : {}),
    },
  });

  if (changed && status === "down") {
    await prisma.uptimeIncident.create({ data: { checkId: c.id, startedAt: now, error: r.error } });
    await notify({ event: "uptime.down", ok: false, title: `${c.name} is down`, text: r.error, link: link(), fields: { Target: c.target, "Failed checks": String(fails) } });
  } else if (changed && c.status === "down") {
    const open = await prisma.uptimeIncident.findFirst({ where: { checkId: c.id, endedAt: null }, orderBy: { startedAt: "desc" } });
    if (open) await prisma.uptimeIncident.update({ where: { id: open.id }, data: { endedAt: now } });
    const since = open?.startedAt ?? c.lastChangeAt;
    await notify({
      event: "uptime.up",
      ok: true,
      title: `${c.name} is up again`,
      text: since ? `It was down for ${formatDuration(now.getTime() - since.getTime())}.` : "It answers again.",
      link: link(),
      fields: { Target: c.target, ...(r.latencyMs !== null ? { "Response time": `${r.latencyMs} ms` } : {}) },
    });
  }
  return updated;
}

/** Read the certificate every 6 hours and warn once when it's about to expire. */
export async function checkCertificate(c: UptimeCheck, now = new Date(), read = certExpiry): Promise<void> {
  if (c.type !== "http" || !c.target.startsWith("https:") || c.certWarnDays <= 0) return;
  if (c.certCheckedAt && now.getTime() - c.certCheckedAt.getTime() < CERT_EVERY_MS) return;
  const expires = await read(c.target, c.timeoutMs);
  const soon = !!expires && expires.getTime() - now.getTime() < c.certWarnDays * 86400_000;
  await prisma.uptimeCheck.update({ where: { id: c.id }, data: { certExpiresAt: expires, certCheckedAt: now, certWarned: soon } });
  if (soon && !c.certWarned && expires) {
    const days = Math.max(0, Math.floor((expires.getTime() - now.getTime()) / 86400_000));
    await notify({
      event: "uptime.cert",
      ok: false,
      title: `The certificate of ${new URL(c.target).hostname} expires ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`,
      text: `${c.name}: valid until ${expires.toISOString().slice(0, 10)}. Let's Encrypt certificates renew by themselves 30 days ahead, so one this close usually means renewal is failing.`,
      link: link(),
      fields: { Target: c.target },
    });
  }
}

export async function runCheck(c: UptimeCheck): Promise<UptimeCheck> {
  const r = await probe(c);
  const updated = await recordResult(c, r);
  await checkCertificate(updated).catch(() => {});
  return updated;
}

/** Drop results older than 14 days and daily totals older than 90. */
export async function pruneUptime(now = new Date()): Promise<void> {
  await prisma.uptimeResult.deleteMany({ where: { at: { lt: new Date(now.getTime() - KEEP_RESULTS_MS) } } });
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  await prisma.uptimeDay.deleteMany({ where: { day: { lt: cutoff } } });
  await prisma.uptimeIncident.deleteMany({ where: { endedAt: { lt: new Date(now.getTime() - KEEP_DAYS * 86400_000) } } });
}

// ─── Summaries ─────────────────────────────────────────────────────────────────

export interface DaySummary {
  day: string;
  total: number;
  up: number;
  avgLatencyMs: number | null;
}

/** The last n days, oldest first, with empty days filled in. */
export function daySeries(rows: { day: string; total: number; up: number; latencySum: number }[], days: number, now = new Date()): DaySummary[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DaySummary[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({ day, total: r?.total ?? 0, up: r?.up ?? 0, avgLatencyMs: r && r.up ? Math.round(r.latencySum / r.up) : null });
  }
  return out;
}

/** Percentage of successful checks, or null with no data. */
export function uptimePercent(days: DaySummary[]): number | null {
  const total = days.reduce((n, d) => n + d.total, 0);
  if (!total) return null;
  return Math.round((days.reduce((n, d) => n + d.up, 0) / total) * 10000) / 100;
}

export async function summarize(checks: UptimeCheck[], days = 90, now = new Date()) {
  const ids = checks.map((c) => c.id);
  const cutoff = new Date(now.getTime() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  const rows = ids.length ? await prisma.uptimeDay.findMany({ where: { checkId: { in: ids }, day: { gte: cutoff } } }) : [];
  return new Map(
    checks.map((c) => {
      const series = daySeries(rows.filter((r) => r.checkId === c.id), days, now);
      return [c.id, { series, uptime7d: uptimePercent(series.slice(-7)), uptime30d: uptimePercent(series.slice(-30)), uptime90d: uptimePercent(series) }];
    }),
  );
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────

interface UptimeState {
  timer: ReturnType<typeof setInterval> | null;
  running: Set<string>;
  lastPrune: number;
}
const g = globalThis as unknown as { __deploynowUptime?: UptimeState };
const state: UptimeState = (g.__deploynowUptime ??= { timer: null, running: new Set(), lastPrune: 0 });

export async function runDueChecks(now = new Date()): Promise<number> {
  const due = await prisma.uptimeCheck.findMany({
    where: { enabled: true, OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }] },
    orderBy: { nextCheckAt: "asc" },
    take: 200,
  });
  const todo = due.filter((c) => !state.running.has(c.id));
  for (let i = 0; i < todo.length; i += PARALLEL) {
    await Promise.all(
      todo.slice(i, i + PARALLEL).map(async (c) => {
        state.running.add(c.id);
        try {
          await runCheck(c);
        } catch (err) {
          console.warn(`[deployer] Uptime check ${c.name} failed to run:`, err instanceof Error ? err.message : err);
        } finally {
          state.running.delete(c.id);
        }
      }),
    );
  }
  if (now.getTime() - state.lastPrune > 3600_000) {
    state.lastPrune = now.getTime();
    await pruneUptime(now).catch(() => {});
  }
  return todo.length;
}

export function startUptimeChecker() {
  if (state.timer || process.env.NODE_ENV === "test") return;
  let ticking = false;
  state.timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runDueChecks();
    } catch (err) {
      console.warn("[deployer] Uptime checks failed:", err instanceof Error ? err.message : err);
    } finally {
      ticking = false;
    }
  }, TICK_MS);
  state.timer.unref?.();
}
