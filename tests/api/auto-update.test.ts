/**
 * Auto-update of image, compose and Git apps against a real SQLite database:
 * finding updates, the maintenance window, health checks, rollback, the API.
 * Git, registries and Docker are faked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-autoupdate-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

const docker = vi.hoisted(() => ({
  listContainers: vi.fn(async () => [] as unknown[]),
  getImage: vi.fn((_id: string) => ({ inspect: vi.fn(async () => ({ RepoDigests: [] as string[], Architecture: "amd64" })) })),
  getContainer: vi.fn(),
}));

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(() => docker) }));
vi.mock("@/lib/registryAuth", async (orig) => ({ ...(await orig<typeof import("@/lib/registryAuth")>()), registryAuthFor: vi.fn(async () => undefined) }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { notify } from "@/lib/notify";
import { prisma } from "@/lib/prisma";
import { advanceRuns, checkApp, runAutoUpdates, type Finder } from "@/lib/apps/autoUpdate";
import * as appRoute from "@/app/api/apps/[id]/route";
import * as autoRoute from "@/app/api/apps/[id]/auto-update/route";

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);
const D = (c: string) => `sha256:${c.repeat(64)}`;

let envId = "";
let endpointId = "";
let seq = 0;

const finder = (head = SHA_NEW, digests: Record<string, string> = {}): Finder & { branchHead: ReturnType<typeof vi.fn>; digests: ReturnType<typeof vi.fn> } => ({
  branchHead: vi.fn(async () => head),
  digests: vi.fn(async (image: string) => (digests[image] ? { config: digests[image], manifest: digests[image] } : null)),
});

async function makeApp(data: Record<string, unknown>, dep: Record<string, unknown> = {}) {
  const app = await prisma.application.create({
    data: { environmentId: envId, endpointId, name: `app-${++seq}`, slug: `app-${seq}`, sourceType: "image", status: "running", autoUpdate: true, ...data },
  });
  const d = await prisma.deployment.create({ data: { applicationId: app.id, trigger: "manual", status: "success", finishedAt: new Date(), ...dep } });
  await prisma.application.update({ where: { id: app.id }, data: { currentDeploymentId: d.id } });
  return { app, current: d };
}

/** Finish the queued deployment of an app as the worker would. */
async function finishDeployment(id: string, status: "success" | "failed", extra: Record<string, unknown> = {}) {
  const d = await prisma.deployment.update({ where: { id }, data: { status, finishedAt: new Date(Date.now() - 120_000), ...extra } });
  if (status === "success") await prisma.application.update({ where: { id: d.applicationId }, data: { currentDeploymentId: id } });
  return d;
}

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  endpointId = (await prisma.endpoint.create({ data: { name: "local", type: "socket", host: "/var/run/docker.sock" } })).id;
  const project = await prisma.project.create({ data: { name: "Shop", slug: "shop" } });
  envId = (await prisma.environment.create({ data: { projectId: project.id, name: "production", slug: "production" } })).id;
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

describe("Git apps", () => {
  it("deploys a new commit on the branch, once", async () => {
    const { app, current } = await makeApp({ sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/api", gitBranch: "main" }, { commitSha: SHA_OLD });
    const f = finder();
    const r = await checkApp(app.id, { finder: f });
    expect(r.state).toBe("queued");
    expect(f.branchHead).toHaveBeenCalledWith("https://github.com/acme/api", "main");
    const dep = await prisma.deployment.findFirstOrThrow({ where: { applicationId: app.id, trigger: "auto-update" } });
    expect(dep.commitSha).toBe(SHA_NEW);
    const run = await prisma.autoUpdateRun.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(run).toMatchObject({ status: "deploying", deploymentId: dep.id, previousDeploymentId: current.id });

    // While it runs, nothing new starts
    expect((await checkApp(app.id, { finder: f })).state).toBe("busy");

    // Deployed and healthy a minute later
    await finishDeployment(dep.id, "success", { commitSha: SHA_NEW });
    const verifier = { check: vi.fn(async () => null) };
    await advanceRuns({ verifier });
    expect((await prisma.autoUpdateRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("verifying");
    await advanceRuns({ verifier });
    expect((await prisma.autoUpdateRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("success");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "autoupdate.success", ok: true }));

    // Up to date now
    expect((await checkApp(app.id, { finder: f })).state).toBe("up-to-date");
  });

  it("waits for the maintenance window", async () => {
    const { app } = await makeApp(
      { sourceType: "git-compose", gitRepo: "https://github.com/acme/shop", autoUpdateFrom: "02:00", autoUpdateTo: "04:00", autoUpdateTimezone: "UTC" },
      { commitSha: SHA_OLD, renderedCompose: "services:\n  web:\n    build: .\n" },
    );
    const r = await checkApp(app.id, { finder: finder(), now: new Date("2026-11-27T13:00:00Z") });
    expect(r.state).toBe("waiting");
    const a = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
    expect(a.autoUpdatePending).toMatch(/Waiting for the maintenance window/);
    expect(await prisma.deployment.count({ where: { applicationId: app.id, trigger: "auto-update" } })).toBe(0);

    expect((await checkApp(app.id, { finder: finder(), now: new Date("2026-11-28T02:30:00Z") })).state).toBe("queued");
  });

  it("records a failed check", async () => {
    const { app } = await makeApp({ sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/gone" }, { commitSha: SHA_OLD });
    const f = finder();
    f.branchHead.mockRejectedValueOnce(new Error("The branch main isn't in the repository"));
    expect((await checkApp(app.id, { finder: f })).state).toBe("error");
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).autoUpdateError).toMatch(/isn't in the repository/);
  });
});

describe("image apps", () => {
  it("deploys a new digest; a failed deploy keeps the old container and isn't retried", async () => {
    const { app } = await makeApp({ image: "ghcr.io/acme/web:latest" }, { imageDigest: D("1") });
    const f = finder(SHA_NEW, { "ghcr.io/acme/web:latest": D("2") });
    expect((await checkApp(app.id, { finder: f })).state).toBe("queued");
    const dep = await prisma.deployment.findFirstOrThrow({ where: { applicationId: app.id, trigger: "auto-update" } });
    await finishDeployment(dep.id, "failed", { error: "Timed out waiting for the container to become healthy" });
    await advanceRuns();
    const run = await prisma.autoUpdateRun.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(run.status).toBe("failed");
    expect(run.rollbackDeploymentId).toBe("");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "autoupdate.failure", ok: false }));

    // Same broken digest: not tried again; a retry clears that
    const again = await checkApp(app.id, { finder: f });
    expect(again.state).toBe("already-tried");
    expect(again.summary).toMatch(/Not tried again/);
    // A newer digest is tried
    expect((await checkApp(app.id, { finder: finder(SHA_NEW, { "ghcr.io/acme/web:latest": D("3") }) })).state).toBe("queued");
  });

  it("is due on the interval in the poll cycle", async () => {
    const { app } = await makeApp({ image: "nginx:latest", autoUpdateEvery: 15, autoUpdateCheckedAt: new Date() }, { imageDigest: D("1") });
    const f = finder(SHA_NEW, { "nginx:latest": D("4") });
    await runAutoUpdates({ finder: f });
    expect(f.digests).not.toHaveBeenCalledWith("nginx:latest", expect.anything());
    await prisma.application.update({ where: { id: app.id }, data: { autoUpdateCheckedAt: new Date(Date.now() - 16 * 60_000) } });
    await runAutoUpdates({ finder: f });
    expect(f.digests).toHaveBeenCalledWith("nginx:latest", expect.anything());
  });
});

describe("compose apps", () => {
  const rendered = "services:\n  web:\n    image: nginx:latest\n  api:\n    build: .\n    image: dn/x-api:1\n";

  it("finds new image digests, rolls back when unhealthy afterwards", async () => {
    const { app, current } = await makeApp({ sourceType: "compose", composeInline: "services: {}" }, { renderedCompose: rendered });
    docker.listContainers.mockResolvedValue([
      { Id: "c1", ImageID: D("5"), Labels: { "com.docker.compose.service": "web" } },
      { Id: "c2", ImageID: D("6"), Labels: { "com.docker.compose.service": "api" } },
    ]);
    const f = finder(SHA_NEW, { "nginx:latest": D("7") });
    const r = await checkApp(app.id, { finder: f });
    expect(r.state).toBe("queued");
    expect(r.summary).toMatch(/^web \(nginx:latest\): new/);
    expect(f.digests).toHaveBeenCalledTimes(1); // the built service isn't looked up

    const dep = await prisma.deployment.findFirstOrThrow({ where: { applicationId: app.id, trigger: "auto-update" } });
    await finishDeployment(dep.id, "success");
    const verifier = { check: vi.fn(async () => "web keeps restarting") };
    await advanceRuns({ verifier });
    await advanceRuns({ verifier });
    const run = await prisma.autoUpdateRun.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(run.status).toBe("rolling-back");
    const rb = await prisma.deployment.findUniqueOrThrow({ where: { id: run.rollbackDeploymentId } });
    expect(rb).toMatchObject({ trigger: "rollback", rollbackOfId: current.id });

    await finishDeployment(rb.id, "success");
    await advanceRuns({ verifier });
    const done = await prisma.autoUpdateRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(done.status).toBe("rolled-back");
    expect(done.error).toMatch(/keeps restarting/);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "autoupdate.failure", title: expect.stringMatching(/rolled back/) }));
  });

  it("rolls back a compose deployment that failed, unless rollback is off", async () => {
    docker.listContainers.mockResolvedValue([{ Id: "c1", ImageID: D("5"), Labels: { "com.docker.compose.service": "web" } }]);
    const { app } = await makeApp({ sourceType: "compose", composeInline: "x", autoUpdateRollback: false }, { renderedCompose: rendered });
    await checkApp(app.id, { finder: finder(SHA_NEW, { "nginx:latest": D("8") }) });
    const dep = await prisma.deployment.findFirstOrThrow({ where: { applicationId: app.id, trigger: "auto-update" } });
    await finishDeployment(dep.id, "failed", { error: "service web is unhealthy" });
    await advanceRuns();
    const run = await prisma.autoUpdateRun.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/rollback is off/);
  });
});

describe("API", () => {
  it("saves the settings with the app and reports status", async () => {
    const { app } = await makeApp({ sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/api", autoUpdate: false }, { commitSha: SHA_OLD });
    signInAs("admin");
    const bad = await appRoute.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ autoUpdate: true, autoUpdateFrom: "02:00" }) }), { params: Promise.resolve({ id: app.id }) });
    expect(bad.status).toBe(400);
    const ok = await appRoute.PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ autoUpdate: true, autoUpdateEvery: 60, autoUpdateDays: [1, 2, 3], autoUpdateFrom: "02:00", autoUpdateTo: "05:00", autoUpdateTimezone: "Europe/Sofia" }) }),
      { params: Promise.resolve({ id: app.id }) },
    );
    expect(ok.status).toBe(200);
    const got = await (await appRoute.GET(new Request("http://x"), { params: Promise.resolve({ id: app.id }) })).json();
    expect(got).toMatchObject({ autoUpdate: true, autoUpdateEvery: 60, autoUpdateDays: [1, 2, 3], autoUpdateFrom: "02:00", autoUpdateTo: "05:00", autoUpdateTimezone: "Europe/Sofia", autoUpdateRollback: true });

    const status = await (await autoRoute.GET(new Request("http://x"), { params: Promise.resolve({ id: app.id }) })).json();
    expect(status.window).toBe("Mon, Tue, Wed, 02:00–05:00 (Europe/Sofia)");
    expect(status.runs).toEqual([]);
  });

  it("needs auto-update on for Check now, and deploy permission", async () => {
    const { app } = await makeApp({ image: "nginx:1", autoUpdate: false }, { imageDigest: D("1") });
    signInAs("admin");
    const r = await autoRoute.POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: app.id }) });
    expect(r.status).toBe(400);
    signOut();
    const anon = await autoRoute.POST(new Request("http://x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: app.id }) });
    expect(anon.status).toBe(401);
  });
});
