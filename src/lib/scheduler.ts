/**
 * The cron scheduler: backup policies, retention, weekly repository checks,
 * monthly restore drills and scheduled tasks. Ticks every 30 seconds.
 */
import { prisma } from "./prisma";
import { nextRun } from "./backup/config";
import { enqueueRun, getOrCreateRepo } from "./backup/worker";
import { runTask } from "./tasks";

const DAY = 24 * 3600_000;
const CHECK_EVERY = 7 * DAY;
const DRILL_EVERY = 30 * DAY;
const PRUNE_EVERY = 20 * 3600_000;

interface SchedState {
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
}
const g = globalThis as unknown as { __deploynowScheduler?: SchedState };
const state: SchedState = (g.__deploynowScheduler ??= { timer: null, ticking: false });

function safeNext(schedule: string, from: Date): Date | null {
  try {
    return nextRun(schedule, from);
  } catch {
    return null;
  }
}

async function pendingOrRecent(where: { repoId: string; kind: string; policyId?: string }, within: number) {
  return prisma.backupRun.findFirst({
    where: { ...where, OR: [{ status: { in: ["queued", "running"] } }, { createdAt: { gte: new Date(Date.now() - within) } }] },
    select: { id: true },
  });
}

export async function schedulerTick(now = new Date()) {
  if (state.ticking) return;
  state.ticking = true;
  try {
    // Policies without a next run (new, or schedule changed) get one
    for (const p of await prisma.backupPolicy.findMany({ where: { enabled: true, nextRunAt: null } })) {
      await prisma.backupPolicy.update({ where: { id: p.id }, data: { nextRunAt: safeNext(p.schedule, now) } });
    }
    // Due backups
    const due = await prisma.backupPolicy.findMany({ where: { enabled: true, nextRunAt: { lte: now } } });
    for (const p of due) {
      await prisma.backupPolicy.update({ where: { id: p.id }, data: { nextRunAt: safeNext(p.schedule, now) } });
      const { repo } = await getOrCreateRepo(p.destinationId, p.endpointId ?? "instance");
      if (await prisma.backupRun.findFirst({ where: { policyId: p.id, kind: "backup", status: { in: ["queued", "running"] } } })) continue;
      await enqueueRun({ kind: "backup", repoId: repo.id, policyId: p.id });
    }
    // Retention after successful backups, at most daily per policy
    for (const p of await prisma.backupPolicy.findMany({ where: { enabled: true, lastStatus: "success" } })) {
      const { repo } = await getOrCreateRepo(p.destinationId, p.endpointId ?? "instance");
      if (await pendingOrRecent({ repoId: repo.id, kind: "prune", policyId: p.id }, PRUNE_EVERY)) continue;
      await enqueueRun({ kind: "prune", repoId: repo.id, policyId: p.id });
    }
    // Weekly check and monthly restore drill per repository that has data
    for (const repo of await prisma.backupRepo.findMany({ where: { initializedAt: { not: null } } })) {
      if ((!repo.lastCheckAt || now.getTime() - repo.lastCheckAt.getTime() > CHECK_EVERY) && !(await pendingOrRecent({ repoId: repo.id, kind: "check" }, CHECK_EVERY))) {
        await enqueueRun({ kind: "check", repoId: repo.id });
      }
      if ((!repo.lastDrillAt || now.getTime() - repo.lastDrillAt.getTime() > DRILL_EVERY) && !(await pendingOrRecent({ repoId: repo.id, kind: "drill" }, DRILL_EVERY))) {
        await enqueueRun({ kind: "drill", repoId: repo.id });
      }
    }
    // Scheduled tasks
    for (const t of await prisma.scheduledTask.findMany({ where: { enabled: true, nextRunAt: null } })) {
      await prisma.scheduledTask.update({ where: { id: t.id }, data: { nextRunAt: safeNext(t.schedule, now) } });
    }
    for (const t of await prisma.scheduledTask.findMany({ where: { enabled: true, nextRunAt: { lte: now } } })) {
      await prisma.scheduledTask.update({ where: { id: t.id }, data: { nextRunAt: safeNext(t.schedule, now) } });
      void runTask(t.id).catch((err) => console.error("[tasks] run failed:", err instanceof Error ? err.message : err));
    }
  } catch (err) {
    console.error("[scheduler] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    state.ticking = false;
  }
}

export function startScheduler() {
  if (state.timer) return;
  state.timer = setInterval(() => void schedulerTick(), 30_000);
  state.timer.unref?.();
  setTimeout(() => void schedulerTick(), 5_000).unref?.();
}

export function stopScheduler() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
