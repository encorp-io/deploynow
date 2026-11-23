/** Backup, scheduled task and monitoring routes, against a real temp database. */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-api-backup-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), notify: vi.fn(async () => {}) }));
// Runs are queued but not executed here; the integration test runs them for real
vi.mock("@/lib/backup/engine", () => ({ executeRun: vi.fn(async () => {}) }));
vi.mock("@/lib/backup/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/backup/service")>()),
  testDestination: vi.fn(async () => ({ ok: true, message: "Connected" })),
  snapshotsFor: vi.fn(async () => [{ id: "abcdef0123456789", shortId: "abcdef01", source: "volume:data" }]),
}));
vi.mock("@/lib/tasks", async (orig) => ({ ...(await orig<typeof import("@/lib/tasks")>()), runTask: vi.fn(async () => ({ id: "run", status: "success", exitCode: 0 })) }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import { notify } from "@/lib/notify";
import { runTask } from "@/lib/tasks";
import { fireAlert, resolveAlert } from "@/lib/monitor";
import { schedulerTick } from "@/lib/scheduler";
import * as destinations from "@/app/api/backups/destinations/route";
import * as destination from "@/app/api/backups/destinations/[id]/route";
import * as destTest from "@/app/api/backups/destinations/test/route";
import * as policies from "@/app/api/backups/policies/route";
import * as policy from "@/app/api/backups/policies/[id]/route";
import * as repos from "@/app/api/backups/repos/route";
import * as repo from "@/app/api/backups/repos/[id]/route";
import * as runs from "@/app/api/backups/runs/route";
import * as runRoute from "@/app/api/backups/runs/[id]/route";
import * as tasks from "@/app/api/tasks/route";
import * as task from "@/app/api/tasks/[id]/route";
import * as monitoring from "@/app/api/monitoring/route";
import * as metrics from "@/app/api/endpoints/[id]/metrics/route";
import * as settings from "@/app/api/settings/route";

const req = (method: string, body?: unknown, url = "http://dn.local/x") => new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

let endpointId = "";

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  endpointId = (await prisma.endpoint.create({ data: { name: "prod-1", type: "socket", host: "/var/run/docker.sock", status: "online" } })).id;
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

const R2 = { name: "R2", provider: "r2", endpointUrl: "0123456789abcdef0123456789abcdef", bucket: "dn-backups", accessKeyId: "AK", secretKey: "SECRET" };

describe("backup destinations", () => {
  it("needs operator to view and admin to change", async () => {
    expect((await destinations.GET()).status).toBe(401);
    signInAs("viewer");
    expect((await destinations.GET()).status).toBe(403);
    signInAs("operator");
    expect((await destinations.GET()).status).toBe(200);
    expect((await destinations.POST(req("POST", R2))).status).toBe(403);
  });

  it("creates, masks, tests, updates and refuses duplicates", async () => {
    signInAs("admin");
    expect((await destinations.POST(req("POST", { ...R2, bucket: "X" }))).status).toBe(400);
    const created = await json(await destinations.POST(req("POST", R2)));
    expect(created.status).toBe(201);
    expect(created.body.secretKey).toBe("••••••••");
    expect(created.body.endpointUrl).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect((await destinations.POST(req("POST", R2))).status).toBe(409);
    const row = await prisma.backupDestination.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.secretKey).not.toContain("SECRET");

    expect((await json(await destination.POST(req("POST"), p(created.body.id)))).body).toEqual({ ok: true, message: "Connected" });
    expect((await destTest.POST(req("POST", R2))).status).toBe(200);
    const upd = await json(await destination.PATCH(req("PATCH", { pruneKeyId: "PK", pruneSecretKey: "PS", secretKey: "••••••••" }), p(created.body.id)));
    expect(upd.status).toBe(200);
    expect(upd.body.pruneSecretKey).toBe("••••••••");
    expect((await destination.PATCH(req("PATCH", {}), p("cnotfound00000000000000000"))).status).toBe(404);
  });
});

describe("backup policies, repositories and runs", () => {
  let destId = "";
  let policyId = "";
  let repoId = "";

  beforeAll(async () => {
    destId = (await prisma.backupDestination.findFirstOrThrow()).id;
  });

  it("creates a policy and offers the recovery kit once", async () => {
    signInAs("admin");
    expect((await policies.POST(req("POST", { name: "x", endpointId, destinationId: destId, sources: [] }))).status).toBe(400);
    expect((await policies.POST(req("POST", { name: "x", endpointId, destinationId: destId, sources: [{ type: "volume", name: "data" }], schedule: "nope" }))).status).toBe(400);
    const created = await json(
      await policies.POST(req("POST", { name: "nightly", endpointId, destinationId: destId, sources: [{ type: "volume", name: "data" }, { type: "db", engine: "postgres", container: "db" }], mode: "stop" })),
    );
    expect(created.status).toBe(201);
    expect(created.body.kitAvailable).toBe(true);
    expect(created.body.nextRunAt).toBeTruthy();
    expect(created.body).toMatchObject({ keepDaily: 7, keepWeekly: 4, keepMonthly: 6, schedule: "0 3 * * *" });
    policyId = created.body.id;
    repoId = created.body.repoId;

    // Step-up is required when 2FA is on
    signInAs("admin", { totpEnabled: true });
    const blocked = await json(await repo.POST(req("POST", { action: "kit" }), p(repoId)));
    expect(blocked.body.stepUpRequired).toBe(true);
    signInAs("operator");
    expect((await repo.POST(req("POST", { action: "kit" }), p(repoId))).status).toBe(403);
    signInAs("admin");
    const kit = await json(await repo.POST(req("POST", { action: "kit" }), p(repoId)));
    expect(kit.status).toBe(200);
    expect(kit.body.kit).toMatch(/Password: {7}\S{40,}/);
    const again = await json(await repo.POST(req("POST", { action: "kit" }), p(repoId)));
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already shown/);

    const list = await json(await repos.GET());
    expect(list.body[0]).toMatchObject({ id: repoId, scopeName: "prod-1", kitAvailable: false });
    expect((await json(await repo.GET(req("GET"), p(repoId)))).body[0].source).toBe("volume:data");
  });

  it("updates a policy but not its destination", async () => {
    signInAs("admin");
    const other = await prisma.backupDestination.create({ data: { name: "other", endpointUrl: "https://s3.example.com", bucket: "bucket", accessKeyId: "a", secretKey: "x" } });
    expect((await policy.PATCH(req("PATCH", { destinationId: other.id }), p(policyId))).status).toBe(400);
    const upd = await json(await policy.PATCH(req("PATCH", { keepDaily: 3, enabled: false }), p(policyId)));
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ keepDaily: 3, enabled: false, nextRunAt: null });
    expect((await json(await policy.GET(req("GET"), p(policyId)))).body.repoId).toBe(repoId);
    expect((await json(await policies.GET(req("GET", undefined, `http://dn.local/x?endpointId=${endpointId}`)))).body).toHaveLength(1);
  });

  it("queues a backup once, and lists runs", async () => {
    signInAs("viewer");
    expect((await policy.POST(req("POST", { action: "run" }), p(policyId))).status).toBe(403);
    signInAs("operator");
    const r = await json(await policy.POST(req("POST", { action: "run" }), p(policyId)));
    expect(r.status).toBe(202);
    await prisma.backupRun.update({ where: { id: r.body.runId }, data: { status: "queued" } });
    expect((await policy.POST(req("POST", { action: "run" }), p(policyId))).status).toBe(409);
    expect((await policy.POST(req("POST", { action: "nope" }), p(policyId))).status).toBe(400);
    const list = await json(await runs.GET(req("GET", undefined, `http://dn.local/x?policyId=${policyId}`)));
    expect(list.body[0]).toMatchObject({ id: r.body.runId, kind: "backup", trigger: "manual", actorEmail: "operator@test.local" });
    expect((await json(await runRoute.GET(req("GET"), p(r.body.runId)))).body).toHaveProperty("log");
    expect((await runRoute.GET(req("GET"), p("bad"))).status).toBe(404);
  });

  it("queues checks and drills, and restores only for admins with valid input", async () => {
    signInAs("operator");
    expect((await repo.POST(req("POST", { action: "drill" }), p(repoId))).status).toBe(202);
    expect((await repo.POST(req("POST", { action: "drill" }), p(repoId))).status).toBe(409);
    expect((await repo.POST(req("POST", { action: "check" }), p(repoId))).status).toBe(202);
    expect((await repo.POST(req("POST", { action: "restore", snapshotId: "abcdef01", target: "same" }), p(repoId))).status).toBe(403);
    signInAs("admin");
    expect((await repo.POST(req("POST", { action: "restore", snapshotId: "abcdef01", target: "elsewhere" }), p(repoId))).status).toBe(400);
    expect((await repo.POST(req("POST", { action: "restore", snapshotId: "zz", target: "same" }), p(repoId))).status).toBe(400);
    const ok = await json(await repo.POST(req("POST", { action: "restore", snapshotId: "abcdef01", target: "volume", name: "data-copy" }), p(repoId)));
    expect(ok.status).toBe(202);
    const run = await prisma.backupRun.findUniqueOrThrow({ where: { id: ok.body.runId } });
    expect(JSON.parse(run.params)).toMatchObject({ snapshotId: "abcdef01", target: "volume", name: "data-copy" });
    expect((await repo.POST(req("POST", { action: "zap" }), p(repoId))).status).toBe(400);
    expect((await repo.POST(req("POST", { action: "check" }), p("cnotfound00000000000000000"))).status).toBe(404);
  });

  it("schedules due backups, retention, checks and drills", async () => {
    await prisma.backupRun.deleteMany({});
    await prisma.backupPolicy.update({ where: { id: policyId }, data: { enabled: true, nextRunAt: new Date(Date.now() - 1000), lastStatus: "success" } });
    await prisma.backupRepo.update({ where: { id: repoId }, data: { initializedAt: new Date() } });
    await schedulerTick();
    const kinds = (await prisma.backupRun.findMany({ where: { repoId } })).map((r) => r.kind).sort();
    expect(kinds).toEqual(["backup", "check", "drill", "prune"]);
    const pol = await prisma.backupPolicy.findUniqueOrThrow({ where: { id: policyId } });
    expect(pol.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    // Nothing new on the next tick
    await schedulerTick();
    expect(await prisma.backupRun.count({ where: { repoId } })).toBe(4);
  });

  it("deletes a policy, then the destination with step-up", async () => {
    signInAs("admin");
    expect((await policy.DELETE(req("DELETE"), p(policyId))).status).toBe(200);
    signInAs("admin", { totpEnabled: true });
    expect((await destination.DELETE(req("DELETE"), p(destId))).status).toBe(403);
    signInAs("admin", { totpEnabled: true, stepUpAt: new Date() });
    expect((await destination.DELETE(req("DELETE"), p(destId))).status).toBe(200);
    expect(await prisma.backupRepo.count({ where: { destinationId: destId } })).toBe(0);
  });
});

describe("scheduled tasks", () => {
  let taskId = "";
  it("validates and creates tasks", async () => {
    signInAs("operator");
    expect((await tasks.POST(req("POST", {}))).status).toBe(403);
    signInAs("admin");
    expect((await tasks.POST(req("POST", { name: "x", endpointId: "nope" }))).status).toBe(400);
    expect((await tasks.POST(req("POST", { name: "x", endpointId, schedule: "0 4 * * *", mode: "exec", command: "echo" }))).status).toBe(400);
    expect((await tasks.POST(req("POST", { name: "x", endpointId, schedule: "0 4 * * *", mode: "run", image: "alpine", command: "echo", env: "not valid" }))).status).toBe(400);
    const created = await json(await tasks.POST(req("POST", { name: "cache", endpointId, schedule: "0 4 * * *", mode: "exec", container: "web", command: "php artisan cache:clear" })));
    expect(created.status).toBe(201);
    taskId = created.body.id;
    expect(created.body.nextRunAt).toBeTruthy();
    const list = await json(await tasks.GET(req("GET")));
    expect(list.body[0]).toMatchObject({ name: "cache", endpointName: "prod-1" });
  });

  it("updates, runs and deletes a task", async () => {
    signInAs("admin");
    expect((await json(await task.PATCH(req("PATCH", { enabled: false }), p(taskId)))).body.nextRunAt).toBeNull();
    expect((await task.PATCH(req("PATCH", { schedule: "bad" }), p(taskId))).status).toBe(400);
    signInAs("operator");
    expect((await task.POST(req("POST"), p(taskId))).status).toBe(200);
    expect(runTask).toHaveBeenCalledWith(taskId, "manual", "operator@test.local");
    expect((await json(await task.GET(req("GET"), p(taskId)))).body.runs).toEqual([]);
    expect((await task.DELETE(req("DELETE"), p(taskId))).status).toBe(403);
    signInAs("admin");
    expect((await task.DELETE(req("DELETE"), p(taskId))).status).toBe(200);
    expect((await task.GET(req("GET"), p(taskId))).status).toBe(404);
  });

  it("runs due tasks from the scheduler", async () => {
    const t = await prisma.scheduledTask.create({ data: { name: "due", endpointId, schedule: "* * * * *", command: "true", container: "web", nextRunAt: new Date(Date.now() - 1000) } });
    await schedulerTick();
    expect(runTask).toHaveBeenCalledWith(t.id);
  });
});

describe("monitoring", () => {
  it("fires an alert once and resolves it once", async () => {
    expect(await fireAlert("disk:x", "disk", "Disk 95% full on prod-1", endpointId)).toBe(true);
    expect(await fireAlert("disk:x", "disk", "Disk 96% full on prod-1", endpointId)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notify).mock.calls[0][0]).toMatchObject({ event: "alert.firing", title: "Disk 95% full on prod-1" });
    signInAs("viewer");
    const m = await json(await monitoring.GET());
    expect(m.body.active).toHaveLength(1);
    expect(m.body.active[0].message).toBe("Disk 96% full on prod-1");
    expect(m.body.endpoints[0].name).toBe("prod-1");

    expect(await resolveAlert("disk:x")).toBe(true);
    expect(await resolveAlert("disk:x")).toBe(false);
    expect(vi.mocked(notify).mock.calls[1][0]).toMatchObject({ event: "alert.resolved", ok: true });
    const after = await json(await monitoring.GET());
    expect(after.body.active).toHaveLength(0);
    expect(after.body.resolved).toHaveLength(1);
    // It can fire again later
    expect(await fireAlert("disk:x", "disk", "Disk full again", endpointId)).toBe(true);
  });

  it("returns metric samples for an endpoint", async () => {
    await prisma.metricSample.create({ data: { endpointId, cpus: 2, load1: 0.5, memTotal: 100, memUsed: 50, diskTotal: 1000, diskUsed: 10 } });
    signInAs("viewer");
    const r = await json(await metrics.GET(req("GET", undefined, "http://dn.local/x?hours=2"), p(endpointId)));
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ cpus: 2, memUsed: 50 });
  });

  it("validates alert thresholds in settings", async () => {
    signInAs("admin");
    expect((await settings.PUT(req("PUT", { alertDiskPercent: 20 }))).status).toBe(400);
    expect((await settings.PUT(req("PUT", { alertDiskPercent: 85, alertCrashRestarts: 5 }))).status).toBe(200);
    const s = await json(await settings.GET());
    expect(s.body).toMatchObject({ alertDiskPercent: 85, alertCrashRestarts: 5, alertMemPercent: 95 });
    expect((await settings.PUT(req("PUT", { agentPublicUrl: "http://x" }))).status).toBe(400);
    expect((await settings.PUT(req("PUT", { agentPublicUrl: "https://dn.example.com:8444/" }))).status).toBe(200);
    expect((await json(await settings.GET())).body.agentPublicUrl).toBe("https://dn.example.com:8444");
  });
});
