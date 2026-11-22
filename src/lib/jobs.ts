/**
 * Background jobs: a Job table and a worker loop.
 *
 * The worker runs in the server process (started from instrumentation.ts) but
 * every slow step it drives (git, docker build, compose) runs in a child
 * process, so the UI stays responsive. Jobs survive restarts: whatever was
 * running when the process stopped is marked as interrupted on the next start.
 */
import os from "os";
import { prisma } from "./prisma";

export const WORKER_ID = `${os.hostname()}-${process.pid}`;
const POLL_MS = 2000;
const CONCURRENCY = 2;

export interface DeployRequest {
  trigger: "manual" | "push" | "digest" | "rollback" | "redeploy";
  commitSha?: string;
  commitMessage?: string;
  rollbackOfId?: string;
  actor?: { id: string; email: string } | null;
}

export class DeployBusyError extends Error {
  constructor() {
    super("A deployment of this app is already queued");
  }
}

/** Queue a deployment. Refuses a second queued one for the same app (a running one may continue). */
export async function enqueueDeploy(applicationId: string, req: DeployRequest) {
  const queued = await prisma.deployment.findFirst({ where: { applicationId, status: "queued" } });
  if (queued) throw new DeployBusyError();
  const deployment = await prisma.deployment.create({
    data: {
      applicationId,
      trigger: req.trigger,
      commitSha: req.commitSha ?? "",
      commitMessage: (req.commitMessage ?? "").slice(0, 300),
      rollbackOfId: req.rollbackOfId ?? null,
      startedById: req.actor?.id ?? null,
      startedByEmail: req.actor?.email ?? "",
    },
  });
  await prisma.job.create({ data: { type: "deploy", payload: JSON.stringify({ deploymentId: deployment.id, applicationId }) } });
  kick();
  return deployment;
}

const running = new Map<string, { appId: string; controller: AbortController; deploymentId: string }>();

export async function cancelDeployment(deploymentId: string): Promise<"cancelled" | "stopping" | "finished"> {
  const dep = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!dep) return "finished";
  // A claimed job may still show "queued" until the runner starts: abort it first
  for (const r of running.values()) {
    if (r.deploymentId === deploymentId) {
      r.controller.abort();
      return "stopping";
    }
  }
  if (dep.status === "queued") {
    await prisma.deployment.update({ where: { id: dep.id }, data: { status: "cancelled", finishedAt: new Date() } });
    const jobs = await prisma.job.findMany({ where: { type: "deploy", status: "queued" } });
    for (const j of jobs) {
      if (JSON.parse(j.payload).deploymentId === dep.id) await prisma.job.update({ where: { id: j.id }, data: { status: "cancelled", finishedAt: new Date() } });
    }
    return "cancelled";
  }
  return "finished";
}

/** Mark what an earlier process left running as interrupted. */
export async function recoverInterrupted(): Promise<void> {
  const stale = await prisma.job.findMany({ where: { status: "running", NOT: { lockedBy: WORKER_ID } } });
  for (const j of stale) {
    await prisma.job.update({ where: { id: j.id }, data: { status: "failed", error: "Interrupted by a restart", finishedAt: new Date() } });
  }
  await prisma.deployment.updateMany({
    where: { status: "running" },
    data: { status: "failed", error: "Interrupted by a restart of DeployNow", finishedAt: new Date() },
  });
  const deploying = await prisma.application.findMany({ where: { status: "deploying" } });
  for (const a of deploying) {
    await prisma.application.update({ where: { id: a.id }, data: { status: a.currentDeploymentId ? "running" : "failed" } });
  }
}

type Handler = (payload: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
const handlers: Record<string, Handler> = {
  deploy: async (payload, signal) => {
    const { runDeployment } = await import("./deploy/runner");
    await runDeployment(String(payload.deploymentId), { signal });
  },
};

/** Claim one queued job; skips apps that already have a deploy running. */
async function claim() {
  const busyApps = new Set([...running.values()].map((r) => r.appId));
  const candidates = await prisma.job.findMany({ where: { status: "queued", runAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: 20 });
  for (const job of candidates) {
    const payload = JSON.parse(job.payload || "{}");
    if (payload.applicationId && busyApps.has(payload.applicationId)) continue;
    const won = await prisma.job.updateMany({
      where: { id: job.id, status: "queued" },
      data: { status: "running", lockedBy: WORKER_ID, lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (won.count === 1) return { job, payload };
  }
  return null;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
let started = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    while (running.size < CONCURRENCY) {
      const next = await claim();
      if (!next) break;
      const { job, payload } = next;
      const controller = new AbortController();
      running.set(job.id, { appId: payload.applicationId ?? "", controller, deploymentId: payload.deploymentId ?? "" });
      const handler = handlers[job.type];
      void (async () => {
        try {
          if (!handler) throw new Error(`Unknown job type ${job.type}`);
          await handler(payload, controller.signal);
          await prisma.job.update({ where: { id: job.id }, data: { status: "done", finishedAt: new Date() } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Job failed";
          console.error(`[jobs] ${job.type} ${job.id} failed:`, msg);
          await prisma.job.update({ where: { id: job.id }, data: { status: "failed", error: msg.slice(0, 2000), finishedAt: new Date() } }).catch(() => {});
          // The runner normally records the outcome; if it never got that far, don't leave the deployment open
          if (payload.deploymentId) {
            await prisma.deployment
              .updateMany({
                where: { id: String(payload.deploymentId), status: { in: ["queued", "running"] } },
                data: { status: controller.signal.aborted ? "cancelled" : "failed", error: msg.slice(0, 2000), finishedAt: new Date() },
              })
              .catch(() => {});
          }
        } finally {
          running.delete(job.id);
          kick();
        }
      })();
    }
  } catch (err) {
    console.error("[jobs] Worker error:", err instanceof Error ? err.message : "unknown error");
  } finally {
    ticking = false;
  }
}

/** Look for work now instead of at the next poll. */
export function kick() {
  if (started) setTimeout(() => void tick(), 0);
}

export function startWorker() {
  if (started) return;
  started = true;
  void recoverInterrupted()
    .catch((err) => console.error("[jobs] Recovery failed:", err instanceof Error ? err.message : "unknown error"))
    .finally(() => {
      const loop = async () => {
        await tick();
        timer = setTimeout(loop, POLL_MS);
      };
      void loop();
    });
  console.log("[deployer] Job worker started");
}

export function stopWorker() {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Remove finished jobs older than 30 days. */
export async function pruneJobs() {
  await prisma.job.deleteMany({ where: { status: { in: ["done", "failed", "cancelled"] }, finishedAt: { lt: new Date(Date.now() - 30 * 86400_000) } } });
}

export function runningCount() {
  return running.size;
}
