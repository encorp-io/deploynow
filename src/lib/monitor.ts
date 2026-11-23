/**
 * Monitoring and alerts.
 *
 * Every minute: host metrics (from the agent, or a small probe container every
 * five minutes on other endpoints), crash loops, agents that went offline, and
 * the latest result of deploys, backups and scheduled tasks. An alert is sent
 * once when it starts and once when it clears.
 */
import type Docker from "dockerode";
import type { Endpoint } from "@prisma/client";
import { prisma } from "./prisma";
import { dockerFor, parseMetrics, type HostMetrics } from "./endpoints";
import { notify } from "./notify";
import { runHelper } from "./backup/helper";
import { RESTIC_IMAGE } from "./backup/config";

const MINUTE = 60_000;
const PROBE_EVERY = 5 * MINUTE;
const KEEP_SAMPLES = 7 * 24 * 3600_000;
const CRASH_WINDOW = 10 * MINUTE;
const AGENT_GRACE = 2 * MINUTE;

interface MonState {
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
  lastProbe: Map<string, number>;
  restarts: Map<string, { at: number; count: number }[]>;
}
const g = globalThis as unknown as { __deploynowMonitor?: MonState };
const state: MonState = (g.__deploynowMonitor ??= { timer: null, ticking: false, lastProbe: new Map(), restarts: new Map() });

// ─── Alerts ────────────────────────────────────────────────────────────────────

export async function fireAlert(key: string, kind: string, message: string, endpointId = "") {
  const existing = await prisma.alert.findUnique({ where: { key } });
  if (existing && !existing.resolvedAt) {
    if (existing.message !== message) await prisma.alert.update({ where: { key }, data: { message } });
    return false;
  }
  await prisma.alert.upsert({
    where: { key },
    create: { key, kind, message, endpointId },
    update: { kind, message, endpointId, firedAt: new Date(), resolvedAt: null },
  });
  await notify({ event: "alert.firing", ok: false, title: message, text: "", fields: { Alert: kind } });
  return true;
}

export async function resolveAlert(key: string) {
  const existing = await prisma.alert.findUnique({ where: { key } });
  if (!existing || existing.resolvedAt) return false;
  await prisma.alert.update({ where: { key }, data: { resolvedAt: new Date() } });
  await notify({ event: "alert.resolved", ok: true, title: `Resolved: ${existing.message}`, text: "", fields: { Alert: existing.kind } });
  return true;
}

async function setAlert(on: boolean, key: string, kind: string, message: string, endpointId = "") {
  return on ? fireAlert(key, kind, message, endpointId) : resolveAlert(key);
}

// ─── Host metrics ──────────────────────────────────────────────────────────────

const PROBE_SCRIPT = [
  'echo "cpus=$(nproc)"',
  'echo "load=$(cut -d" " -f1 /proc/loadavg)"',
  "awk '/^MemTotal:/{print \"memtotal=\"$2} /^MemAvailable:/{print \"memavail=\"$2}' /proc/meminfo",
  "df -Pk /host 2>/dev/null | awk 'NR==2{print \"disktotal=\"$2; print \"diskfree=\"$4}'",
].join("; ");

/** Host metrics from a probe container (endpoints without an agent). */
export async function probeHost(docker: Docker, diskPath = "/var/lib/docker"): Promise<HostMetrics> {
  const res = await runHelper(docker, { image: RESTIC_IMAGE, entrypoint: ["sh", "-c"], cmd: [PROBE_SCRIPT], binds: [`${diskPath}:/host:ro`], timeoutMs: 60_000 });
  return parseProbe(res.stdout, diskPath);
}

export function parseProbe(out: string, diskPath: string): HostMetrics {
  const v: Record<string, number> = {};
  for (const line of out.split("\n")) {
    const m = /^(\w+)=([\d.]+)$/.exec(line.trim());
    if (m) v[m[1]] = Number(m[2]);
  }
  return {
    cpus: v.cpus || 0,
    load1: v.load || 0,
    load5: 0,
    memTotal: (v.memtotal || 0) * 1024,
    memAvailable: (v.memavail || 0) * 1024,
    diskPath,
    diskTotal: (v.disktotal || 0) * 1024,
    diskFree: (v.diskfree || 0) * 1024,
  };
}

async function recordSample(e: Endpoint, m: HostMetrics) {
  await prisma.metricSample.create({
    data: { endpointId: e.id, cpus: m.cpus, load1: m.load1, memTotal: m.memTotal, memUsed: Math.max(0, m.memTotal - m.memAvailable), diskTotal: m.diskTotal, diskUsed: Math.max(0, m.diskTotal - m.diskFree) },
  });
}

export function usage(m: HostMetrics) {
  return {
    disk: m.diskTotal > 0 ? Math.round(((m.diskTotal - m.diskFree) / m.diskTotal) * 100) : 0,
    mem: m.memTotal > 0 ? Math.round(((m.memTotal - m.memAvailable) / m.memTotal) * 100) : 0,
  };
}

async function checkHost(e: Endpoint, thresholds: { disk: number; mem: number }) {
  let m: HostMetrics | null = null;
  if (e.type === "agent") {
    if (e.hostMetricsAt && Date.now() - e.hostMetricsAt.getTime() < 3 * MINUTE) m = parseMetrics(e.hostMetrics);
  } else if (process.env.MONITOR_PROBE !== "off" && Date.now() - (state.lastProbe.get(e.id) ?? 0) >= PROBE_EVERY) {
    state.lastProbe.set(e.id, Date.now());
    m = await probeHost(dockerFor(e)).catch(() => null);
    if (m) await prisma.endpoint.update({ where: { id: e.id }, data: { hostMetrics: JSON.stringify(m), hostMetricsAt: new Date() } });
  }
  if (!m || !m.memTotal) return;
  await recordSample(e, m);
  const u = usage(m);
  await setAlert(m.diskTotal > 0 && u.disk >= thresholds.disk, `disk:${e.id}`, "disk", `Disk ${u.disk}% full on ${e.name} (${m.diskPath})`, e.id);
  await setAlert(u.mem >= thresholds.mem, `memory:${e.id}`, "memory", `Memory ${u.mem}% used on ${e.name}`, e.id);
}

// ─── Crash loops ───────────────────────────────────────────────────────────────

/** True when the restart count rose by `limit` or more within the window. */
export function isCrashLoop(history: { at: number; count: number }[], now: number, limit: number): boolean {
  const recent = history.filter((h) => now - h.at <= CRASH_WINDOW);
  if (recent.length < 2) return false;
  return recent[recent.length - 1].count - recent[0].count >= limit;
}

async function checkCrashLoops(e: Endpoint, limit: number) {
  const docker = dockerFor(e);
  const containers = await docker.listContainers({ all: true });
  const now = Date.now();
  const seen = new Set<string>();
  for (const c of containers) {
    if (c.Labels?.["deploynow.helper"]) continue;
    const name = (c.Names?.[0] ?? c.Id).replace(/^\//, "");
    const key = `crash:${e.id}:${name}`;
    seen.add(key);
    const recentlyStarted = c.State === "restarting" || /^Up (Less than a second|\d+ seconds?|About a minute)/.test(c.Status ?? "");
    const tracked = state.restarts.get(key);
    if (!recentlyStarted && !tracked) continue;
    const info = await docker.getContainer(c.Id).inspect().catch(() => null);
    if (!info) continue;
    const hist = (tracked ?? []).filter((h) => now - h.at <= CRASH_WINDOW);
    hist.push({ at: now, count: info.RestartCount ?? 0 });
    state.restarts.set(key, hist);
    const looping = info.State.Restarting || isCrashLoop(hist, now, limit);
    if (looping) {
      await fireAlert(key, "crash_loop", `${name} on ${e.name} is restarting repeatedly (${info.RestartCount} restarts${info.State.ExitCode ? `, last exit code ${info.State.ExitCode}` : ""})`, e.id);
    } else if (hist.length > 1 && hist[hist.length - 1].count === hist[0].count && now - hist[0].at >= CRASH_WINDOW - MINUTE) {
      await resolveAlert(key);
      state.restarts.delete(key);
    }
  }
  // Containers that are gone
  for (const key of [...state.restarts.keys()]) {
    if (key.startsWith(`crash:${e.id}:`) && !seen.has(key)) {
      state.restarts.delete(key);
      await resolveAlert(key);
    }
  }
}

// ─── Results of deploys, backups and tasks ─────────────────────────────────────

async function checkResults() {
  for (const p of await prisma.backupPolicy.findMany({ include: { endpoint: true } })) {
    await setAlert(p.enabled && p.lastStatus === "failed", `backup:${p.id}`, "backup_failed", `Backup ${p.name} on ${p.endpoint?.name ?? "DeployNow"} failed`, p.endpointId ?? "");
  }
  for (const r of await prisma.backupRepo.findMany({ where: { lastDrillOk: false } })) {
    await fireAlert(`drill:${r.id}`, "drill_failed", `The restore drill failed for a backup repository (${r.scope === "instance" ? "DeployNow" : "endpoint"})`, r.scope === "instance" ? "" : r.scope);
  }
  for (const r of await prisma.backupRepo.findMany({ where: { lastDrillOk: true } })) await resolveAlert(`drill:${r.id}`);
  for (const t of await prisma.scheduledTask.findMany({ include: { endpoint: true } })) {
    await setAlert(t.enabled && t.lastStatus === "failed", `task:${t.id}`, "task_failed", `Task ${t.name} on ${t.endpoint.name} failed`, t.endpointId);
  }
  // The latest finished deployment of each app
  const apps = await prisma.application.findMany({ select: { id: true, name: true, endpointId: true } });
  for (const a of apps) {
    const last = await prisma.deployment.findFirst({ where: { applicationId: a.id, status: { in: ["success", "failed"] } }, orderBy: { createdAt: "desc" }, select: { status: true } });
    await setAlert(last?.status === "failed", `deploy:${a.id}`, "deploy_failed", `The last deploy of ${a.name} failed`, a.endpointId);
  }
}

export async function monitorTick() {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
    const thresholds = { disk: s?.alertDiskPercent ?? 90, mem: s?.alertMemPercent ?? 95 };
    const limit = s?.alertCrashRestarts ?? 3;
    const endpoints = await prisma.endpoint.findMany();
    for (const e of endpoints) {
      if (e.type === "agent") {
        const enrolled = !!e.agentCertSerial;
        const away = e.status !== "online" && (!e.lastSeenAt || Date.now() - e.lastSeenAt.getTime() > AGENT_GRACE);
        await setAlert(enrolled && away, `agent:${e.id}`, "agent_offline", `The agent on ${e.name} is offline`, e.id);
      }
      if (e.status !== "online") continue;
      await checkHost(e, thresholds).catch(() => {});
      await checkCrashLoops(e, limit).catch(() => {});
    }
    await checkResults();
    await prisma.metricSample.deleteMany({ where: { at: { lt: new Date(Date.now() - KEEP_SAMPLES) } } });
  } catch (err) {
    console.error("[monitor] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    state.ticking = false;
  }
}

export function startMonitor() {
  if (state.timer) return;
  state.timer = setInterval(() => void monitorTick(), MINUTE);
  state.timer.unref?.();
  setTimeout(() => void monitorTick(), 15_000).unref?.();
}

export function stopMonitor() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
