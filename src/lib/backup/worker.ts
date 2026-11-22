/**
 * Queue for backup runs. Runs execute in the background, at most two at a time
 * and one per repository (restic locks the repository anyway).
 */
import type { BackupRun } from "@prisma/client";
import { prisma } from "../prisma";
import { encryptSecret } from "../secretsCrypto";
import { newRepoPassword } from "./config";
import { executeRun } from "./engine";

const MAX_PARALLEL = Number(process.env.BACKUP_PARALLEL ?? 2) || 2;

interface WorkerState {
  timer: ReturnType<typeof setInterval> | null;
  running: Map<string, string>; // runId → repoId
  ticking: boolean;
}
const g = globalThis as unknown as { __deploynowBackupWorker?: WorkerState };
const state: WorkerState = (g.__deploynowBackupWorker ??= { timer: null, running: new Map(), ticking: false });

export async function getOrCreateRepo(destinationId: string, scope: string) {
  const existing = await prisma.backupRepo.findUnique({ where: { destinationId_scope: { destinationId, scope } } });
  if (existing) return { repo: existing, created: false };
  try {
    const repo = await prisma.backupRepo.create({ data: { destinationId, scope, password: encryptSecret(newRepoPassword()) } });
    return { repo, created: true };
  } catch {
    // Created concurrently
    return { repo: await prisma.backupRepo.findUniqueOrThrow({ where: { destinationId_scope: { destinationId, scope } } }), created: false };
  }
}

export async function enqueueRun(input: { kind: string; repoId: string; policyId?: string | null; trigger?: string; params?: unknown; actorEmail?: string }): Promise<BackupRun> {
  const run = await prisma.backupRun.create({
    data: {
      kind: input.kind,
      repoId: input.repoId,
      policyId: input.policyId ?? null,
      trigger: input.trigger ?? "schedule",
      params: input.params ? JSON.stringify(input.params) : "",
      actorEmail: input.actorEmail ?? "",
    },
  });
  kickBackups();
  return run;
}

export function kickBackups() {
  setImmediate(() => void tick());
}

async function tick() {
  if (state.ticking) return;
  state.ticking = true;
  try {
    while (state.running.size < MAX_PARALLEL) {
      const busyRepos = [...state.running.values()];
      const next = await prisma.backupRun.findFirst({
        where: { status: "queued", repoId: { notIn: busyRepos } },
        orderBy: { createdAt: "asc" },
      });
      if (!next) break;
      state.running.set(next.id, next.repoId);
      void executeRun(next.id)
        .catch((err) => console.error("[backup] run failed:", err instanceof Error ? err.message : err))
        .finally(() => {
          state.running.delete(next.id);
          kickBackups();
        });
    }
  } catch (err) {
    console.error("[backup] queue error:", err instanceof Error ? err.message : err);
  } finally {
    state.ticking = false;
  }
}

/** Runs left "running" by a restart can't finish; mark them failed. */
export async function recoverBackupRuns() {
  await prisma.backupRun.updateMany({
    where: { status: "running" },
    data: { status: "failed", error: "Interrupted by a DeployNow restart", finishedAt: new Date() },
  });
}

export function startBackupWorker() {
  if (state.timer) return;
  void recoverBackupRuns().then(kickBackups);
  state.timer = setInterval(() => void tick(), 10_000);
  state.timer.unref?.();
}

export function stopBackupWorker() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

export function runningBackups(): number {
  return state.running.size;
}

/** Wait until no run is queued or running (tests). */
export async function drainBackups(timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const queued = await prisma.backupRun.count({ where: { status: { in: ["queued", "running"] } } });
    if (queued === 0 && state.running.size === 0) return;
    kickBackups();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Backups did not finish in time");
}
