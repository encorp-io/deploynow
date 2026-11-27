/**
 * The self-updater against a real Docker daemon: a stand-in "DeployNow" image
 * (node:22-alpine with a tiny health endpoint) is replaced by the updater the
 * way Settings → Updates → Update now does it, once with a healthy new version
 * and once with one that crashes after "migrating" the database.
 * Skipped when no daemon is reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import Docker from "dockerode";
import type { SelfUpdatePlan, SelfUpdateStatus } from "@/lib/selfUpdate/shared";

const SOCKET = "/var/run/docker.sock";
const ROOT = path.resolve(__dirname, "../..");
const IMG = "deploynow-selfupdate-it";
const NAME = `deploynow-it-self-${process.pid}`;
const VOLUME = `deploynow-it-data-${process.pid}`;

async function daemonUp() {
  if (!fs.existsSync(SOCKET)) return false;
  try {
    await new Docker({ socketPath: SOCKET }).ping();
    return true;
  } catch {
    return false;
  }
}
const up = await daemonUp();
const docker = new Docker({ socketPath: SOCKET });
let work = "";

const SERVER = `
const fs = require("fs"), http = require("http");
fs.appendFileSync("/data/deployer.db", process.env.APP_VERSION + "\\n");
if (process.env.APP_VERSION === "bad") { console.error("migration 42 failed: boom"); process.exit(1); }
http.createServer((q, r) => { r.end(JSON.stringify({ ok: true, version: process.env.APP_VERSION })); }).listen(3001, "127.0.0.1");
`;

function build(tag: string) {
  const dir = path.join(work, `img-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "server.js"), SERVER);
  fs.writeFileSync(
    path.join(dir, "Dockerfile"),
    [
      "FROM node:22-alpine",
      "WORKDIR /app",
      "COPY server.js .",
      `ENV APP_VERSION=${tag}`,
      `HEALTHCHECK --interval=1s --timeout=2s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`,
      'CMD ["node", "server.js"]',
    ].join("\n"),
  );
  execFileSync("docker", ["build", "-q", "-t", `${IMG}:${tag}`, dir], { stdio: "pipe" });
}

async function waitFor<T>(fn: () => Promise<T | null>, ms: number): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function selfContainer(tag: string) {
  const c = await docker.createContainer({
    name: NAME,
    Image: `${IMG}:${tag}`,
    Labels: { "com.docker.compose.project.working_dir": path.join(work, "compose") },
    HostConfig: { Binds: [`${VOLUME}:/data`], RestartPolicy: { Name: "unless-stopped" } },
  });
  await c.start();
  await waitFor(async () => ((await c.inspect()).State.Health?.Status === "healthy" ? true : null), 60_000);
  return c.id;
}

/** Start the updater container the way startSelfUpdate does, with the compiled runner mounted in. */
async function runUpdater(selfId: string, targetRef: string): Promise<SelfUpdateStatus> {
  const statusFile = "/data/self-update/status.json";
  const plan: SelfUpdatePlan = {
    id: `it${Date.now()}`,
    selfId,
    targetRef,
    statusFile,
    dbFile: "/data/deployer.db",
    envFile: "/compose-env/.env",
    envFileHost: path.join(work, "compose", ".env"),
    envTag: targetRef.split(":").pop()!,
    healthTimeoutMs: 60_000,
    delayMs: 0,
  };
  const helper = await docker.createContainer({
    name: `${NAME}-updater`,
    Image: `${IMG}:1`,
    User: "0:0",
    Entrypoint: ["node", "/app/updater/selfUpdate/runner.js"],
    Cmd: [],
    Env: [`SELF_UPDATE_PLAN=${JSON.stringify(plan)}`],
    Healthcheck: { Test: ["NONE"] },
    HostConfig: {
      Binds: [
        `${SOCKET}:/var/run/docker.sock`,
        `${VOLUME}:/data`,
        `${path.join(work, "compose")}:/compose-env`,
        `${path.join(work, "updater")}:/app/updater:ro`,
        `${path.join(ROOT, "node_modules")}:/app/node_modules:ro`,
      ],
      NetworkMode: "none",
    },
  });
  await helper.start();
  const res = (await helper.wait()) as { StatusCode: number };
  const logs = String(await helper.logs({ stdout: true, stderr: true }));
  await helper.remove({ force: true });
  expect(res.StatusCode, logs).toBe(0);
  const out = execFileSync("docker", ["run", "--rm", "-v", `${VOLUME}:/data`, "node:22-alpine", "cat", statusFile]).toString();
  return JSON.parse(out) as SelfUpdateStatus;
}

async function current() {
  return docker.getContainer(NAME).inspect();
}
function dbContents(): string {
  return execFileSync("docker", ["run", "--rm", "-v", `${VOLUME}:/data`, "node:22-alpine", "cat", "/data/deployer.db"]).toString();
}

describe.skipIf(!up)("self-update against Docker", () => {
  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "dn-selfupdate-"));
    execFileSync(process.execPath, [path.join(ROOT, "scripts/build-updater.cjs"), path.join(work, "updater")], { stdio: "pipe" });
    fs.mkdirSync(path.join(work, "compose"));
    fs.writeFileSync(path.join(work, "compose", ".env"), "AUTH_SECRET=x\nDEPLOYNOW_TAG=1\n");
    for (const t of ["1", "2", "bad"]) build(t);
    await docker.createVolume({ Name: VOLUME });
  }, 300_000);

  afterAll(async () => {
    if (!up) return;
    for (const c of await docker.listContainers({ all: true, filters: { name: [NAME] } })) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
    await docker.getVolume(VOLUME).remove().catch(() => {});
  });

  it("replaces the container with a healthy new version and moves DEPLOYNOW_TAG", async () => {
    const oldId = await selfContainer("1");
    const status = await runUpdater(oldId, `${IMG}:2`);
    expect(status.state, status.message).toBe("succeeded");
    const now = await current();
    expect(now.Id).not.toBe(oldId);
    expect(now.Config.Image).toBe(`${IMG}:2`);
    expect(now.HostConfig.RestartPolicy?.Name).toBe("unless-stopped");
    expect(now.Config.Labels?.["com.docker.compose.project.working_dir"]).toBe(path.join(work, "compose"));
    await expect(docker.getContainer(oldId).inspect()).rejects.toThrow();
    expect(fs.readFileSync(path.join(work, "compose", ".env"), "utf8")).toBe("AUTH_SECRET=x\nDEPLOYNOW_TAG=2\n");
    expect(dbContents()).toBe("1\n2\n");
  }, 120_000);

  it("rolls back, database included, when the new version doesn't come up", async () => {
    const before = await current();
    const dbBefore = dbContents();
    const status = await runUpdater(before.Id, `${IMG}:bad`);
    expect(status.state).toBe("rolled_back");
    expect(status.message).toMatch(/database as it was/);
    expect(status.logs).toMatch(/migration 42 failed/);
    const now = await current();
    expect(now.Id).toBe(before.Id);
    expect(now.Config.Image).toBe(`${IMG}:2`);
    expect(now.State.Running).toBe(true);
    // The old version started once more after the restore and appended its line
    expect(dbContents()).toBe(`${dbBefore}2\n`);
    expect(fs.readFileSync(path.join(work, "compose", ".env"), "utf8")).toBe("AUTH_SECRET=x\nDEPLOYNOW_TAG=2\n");
    const names = (await docker.listContainers({ all: true, filters: { name: [NAME] } })).map((c) => c.Names[0]);
    expect(names).toEqual([`/${NAME}`]);
  }, 180_000);
});
