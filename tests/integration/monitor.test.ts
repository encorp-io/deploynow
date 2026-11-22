/**
 * Scheduled tasks and monitoring against a real Docker daemon: exec and one-off
 * tasks, the host probe, and crash-loop detection. Skipped without Docker.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), notify: vi.fn(async () => {}) }));

const SOCKET = "/var/run/docker.sock";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-mon-it-"));
const BUSYBOX = process.env.IT_BUSYBOX || (process.env.CI ? "busybox:1.37" : "mirror.gcr.io/library/busybox:1.37");
const suffix = Math.random().toString(36).slice(2, 8);
const WORKER = `dn-it-worker-${suffix}`;
const CRASHER = `dn-it-crash-${suffix}`;

async function dockerUp() {
  if (!fs.existsSync(SOCKET)) return false;
  const Docker = (await import("dockerode")).default;
  try {
    await new Docker({ socketPath: SOCKET }).ping();
    return true;
  } catch {
    return false;
  }
}
const ready = await dockerUp();

let docker: import("dockerode");
let prisma: typeof import("@/lib/prisma").prisma;
let endpointId = "";

describe.skipIf(!ready)("tasks and monitoring (real Docker)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = `file:${path.join(dir, "it.db")}`;
    process.env.DEPLOYNOW_DATA_DIR = dir;
    execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
    const Docker = (await import("dockerode")).default;
    docker = new Docker({ socketPath: SOCKET });
    const { ensureImage } = await import("@/lib/backup/helper");
    const { RESTIC_IMAGE } = await import("@/lib/backup/config");
    await ensureImage(docker, BUSYBOX);
    await ensureImage(docker, RESTIC_IMAGE);
    const w = await docker.createContainer({ name: WORKER, Image: BUSYBOX, Cmd: ["sleep", "600"] });
    await w.start();
    ({ prisma } = await import("@/lib/prisma"));
    endpointId = (await prisma.endpoint.create({ data: { name: "local-mon", type: "socket", host: SOCKET, status: "online" } })).id;
  }, 120_000);

  afterAll(async () => {
    for (const c of [WORKER, CRASHER]) await docker?.getContainer(c).remove({ force: true }).catch(() => {});
    if (prisma) await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("runs a task with exec in a container and in a one-off container", async () => {
    const { runTask } = await import("@/lib/tasks");
    const a = await prisma.scheduledTask.create({ data: { name: "exec", endpointId, schedule: "0 4 * * *", mode: "exec", container: WORKER, command: "echo hi from $(hostname); exit 0" } });
    const r1 = await runTask(a.id, "manual");
    expect(r1?.status).toBe("success");
    expect(r1?.log).toMatch(/hi from/);

    const b = await prisma.scheduledTask.create({ data: { name: "oneoff", endpointId, schedule: "0 4 * * *", mode: "run", image: BUSYBOX, env: "GREETING=hello", command: 'echo "$GREETING"; exit 3' } });
    const r2 = await runTask(b.id, "manual");
    expect(r2?.status).toBe("failed");
    expect(r2?.exitCode).toBe(3);
    expect(r2?.log).toContain("hello");
    expect((await prisma.scheduledTask.findUniqueOrThrow({ where: { id: b.id } })).lastStatus).toBe("failed");
    // No leftover task containers (other test files may be running backup helpers meanwhile)
    expect((await docker.listContainers({ all: true, filters: { label: ["deploynow.helper=true"], name: ["deploynow-task-"] } })).length).toBe(0);

    const c = await prisma.scheduledTask.create({ data: { name: "slow", endpointId, schedule: "0 4 * * *", mode: "exec", container: WORKER, command: "sleep 30", timeoutSec: 5 } });
    const r3 = await runTask(c.id, "manual");
    expect(r3?.status).toBe("failed");
    expect(r3?.log).toMatch(/Timed out/);
  }, 90_000);

  it("probes the host's CPU, memory and disk", async () => {
    const { probeHost } = await import("@/lib/monitor");
    const m = await probeHost(docker, "/");
    expect(m.cpus).toBeGreaterThan(0);
    expect(m.memTotal).toBeGreaterThan(0);
    expect(m.diskTotal).toBeGreaterThan(0);
  }, 60_000);

  it("records metrics and spots a crash loop", async () => {
    const crash = await docker.createContainer({ name: CRASHER, Image: BUSYBOX, Cmd: ["sh", "-c", "sleep 0.2; exit 1"], HostConfig: { RestartPolicy: { Name: "always" } } });
    await crash.start();
    const { monitorTick } = await import("@/lib/monitor");
    await new Promise((r) => setTimeout(r, 1500));
    await monitorTick();
    const end = Date.now() + 30_000;
    let alert = null;
    while (Date.now() < end && !alert) {
      await new Promise((r) => setTimeout(r, 2000));
      await monitorTick();
      alert = await prisma.alert.findUnique({ where: { key: `crash:${endpointId}:${CRASHER}` } });
    }
    expect(alert?.kind).toBe("crash_loop");
    expect(alert?.resolvedAt).toBeNull();
    expect(await prisma.metricSample.count({ where: { endpointId } })).toBeGreaterThan(0);
    // The failed task above also raised an alert
    expect(await prisma.alert.findFirst({ where: { kind: "task_failed" } })).not.toBeNull();

    // Removing the container clears it
    await crash.remove({ force: true });
    await monitorTick();
    expect((await prisma.alert.findUnique({ where: { key: `crash:${endpointId}:${CRASHER}` } }))?.resolvedAt).not.toBeNull();
  }, 90_000);
});
