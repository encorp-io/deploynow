/** The job queue and worker, against a real SQLite database with a fake deploy runner. */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-jobs-"));
  process.env.DATABASE_URL = `file:${d}/jobs.db`;
  return d as string;
});

const runDeployment = vi.hoisted(() => vi.fn());
vi.mock("@/lib/deploy/runner", () => ({ runDeployment }));

import { prisma } from "@/lib/prisma";
import { cancelDeployment, DeployBusyError, enqueueDeploy, pruneJobs, recoverInterrupted, runningCount, startWorker, stopWorker } from "@/lib/jobs";

let appId = "";
let app2 = "";

async function until(fn: () => Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out");
}

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  const ep = await prisma.endpoint.create({ data: { name: "e", type: "socket", host: "/x" } });
  const pr = await prisma.project.create({ data: { name: "P", slug: "p", environments: { create: { name: "production", slug: "production" } } }, include: { environments: true } });
  const mk = (slug: string) => prisma.application.create({ data: { name: slug, slug, sourceType: "image", image: "x", environment: { connect: { id: pr.environments[0].id } }, endpoint: { connect: { id: ep.id } } } });
  appId = (await mk("a")).id;
  app2 = (await mk("b")).id;
}, 60_000);

afterAll(async () => {
  stopWorker();
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("queue", () => {
  it("refuses a second queued deployment and cancels a queued one", async () => {
    const d = await enqueueDeploy(appId, { trigger: "manual", commitMessage: "x".repeat(400), actor: { id: "u", email: "u@x" } });
    expect(d.commitMessage).toHaveLength(300);
    await expect(enqueueDeploy(appId, { trigger: "manual" })).rejects.toBeInstanceOf(DeployBusyError);
    expect(await cancelDeployment(d.id)).toBe("cancelled");
    const job = (await prisma.job.findMany()).find((j) => JSON.parse(j.payload).deploymentId === d.id);
    expect(job?.status).toBe("cancelled");
    expect(await cancelDeployment(d.id)).toBe("finished");
    expect(await cancelDeployment("nope")).toBe("finished");
  });

  it("marks work left by an earlier process as interrupted", async () => {
    const dep = await prisma.deployment.create({ data: { applicationId: app2, trigger: "manual", status: "running" } });
    await prisma.job.create({ data: { type: "deploy", payload: "{}", status: "running", lockedBy: "old-host-1" } });
    await prisma.application.update({ where: { id: app2 }, data: { status: "deploying" } });
    await recoverInterrupted();
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: dep.id } })).status).toBe("failed");
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app2 } })).status).toBe("failed");
    expect(await prisma.job.count({ where: { status: "running" } })).toBe(0);
  });

  it("prunes old finished jobs", async () => {
    await prisma.job.create({ data: { type: "deploy", payload: "{}", status: "done", finishedAt: new Date(Date.now() - 40 * 86400_000) } });
    const before = await prisma.job.count();
    await pruneJobs();
    expect(await prisma.job.count()).toBe(before - 1);
  });
});

describe("worker", () => {
  it("runs queued deployments, records failures and can cancel a running one", async () => {
    let release: () => void = () => {};
    runDeployment.mockImplementationOnce(async (_id: string, { signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => reject(new Error("Cancelled")));
      });
    });
    runDeployment.mockImplementationOnce(async () => {
      throw new Error("build failed");
    });

    startWorker();
    startWorker(); // idempotent
    const slow = await enqueueDeploy(appId, { trigger: "manual" });
    const failing = await enqueueDeploy(app2, { trigger: "manual" });
    await until(async () => runningCount() === 2 || (await prisma.job.count({ where: { status: "failed", error: "build failed" } })) === 1);
    await until(async () => (await prisma.job.count({ where: { status: "failed", error: "build failed" } })) === 1);
    expect(runDeployment).toHaveBeenCalledWith(failing.id, expect.anything());

    expect(await cancelDeployment(slow.id)).toBe("stopping");
    await until(async () => (await prisma.job.count({ where: { status: "failed", error: "Cancelled" } })) === 1);
    expect(runningCount()).toBe(0);
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: slow.id } })).status).toBe("cancelled");
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: failing.id } })).status).toBe("failed");
    void release;

    runDeployment.mockResolvedValueOnce(undefined);
    const ok = await enqueueDeploy(appId, { trigger: "manual" });
    await until(async () => (await prisma.job.findMany({ where: { status: "done" } })).some((j) => JSON.parse(j.payload).deploymentId === ok.id));
    stopWorker();
  }, 15_000);
});
