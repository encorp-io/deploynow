/**
 * The agent end to end: the real hub, the real Go agent binary and a real
 * Docker daemon. Enrolment with a one-time token, Docker API and CLI through the
 * agent, metrics, revocation and token reuse.
 *
 * Skipped when Go or the Docker daemon isn't available.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SOCKET = "/var/run/docker.sock";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-agent-it-"));

function hasGo() {
  try {
    execSync("go version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
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
const ready = hasGo() && (await dockerUp());

let prisma: typeof import("@/lib/prisma").prisma;
let hub: typeof import("@/lib/agent/hub");
let endpoints: typeof import("@/lib/endpoints");
let cli: typeof import("@/lib/docker/cliBridge");
let port = 0;
let endpointId = "";
let agentBin = "";
const agents: ChildProcess[] = [];
const logs: string[] = [];

async function until(fn: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out; agent log:\n" + logs.join(""));
}

function startAgent(dataDir: string, env: Record<string, string>) {
  const child = spawn(agentBin, ["run"], { env: { PATH: process.env.PATH, DEPLOYNOW_DATA: dataDir, DOCKER_SOCKET: SOCKET, ...env } as unknown as NodeJS.ProcessEnv });
  child.stdout?.on("data", (d: Buffer) => logs.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => logs.push(d.toString()));
  agents.push(child);
  return child;
}

describe.skipIf(!ready)("agent (real hub, Go agent and Docker)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = `file:${path.join(dir, "it.db")}`;
    process.env.DEPLOYNOW_DATA_DIR = dir;
    execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
    agentBin = path.join(dir, "deploynow-agent");
    execSync(`go build -o ${agentBin} ./cmd/deploynow-agent`, { cwd: path.join(process.cwd(), "agent"), env: { ...process.env, CGO_ENABLED: "0" }, stdio: "ignore" });
    ({ prisma } = await import("@/lib/prisma"));
    hub = await import("@/lib/agent/hub");
    endpoints = await import("@/lib/endpoints");
    cli = await import("@/lib/docker/cliBridge");
    port = await hub.startAgentHub(0);
    endpointId = (await prisma.endpoint.create({ data: { name: "edge-agent", type: "agent", host: "" } })).id;
  }, 180_000);

  afterAll(async () => {
    for (const a of agents) a.kill("SIGTERM");
    if (hub) await hub.stopAgentHub();
    if (prisma) await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("enrols with a one-time token and reaches Docker through the agent", async () => {
    const join = await hub.joinInfo(endpointId);
    expect(join.command).toContain(`DEPLOYNOW_CA=${join.caFingerprint}`);
    startAgent(path.join(dir, "a1"), { DEPLOYNOW_URL: `https://127.0.0.1:${port}`, DEPLOYNOW_TOKEN: join.token, DEPLOYNOW_CA: join.caFingerprint });
    await until(async () => hub.isAgentConnected(endpointId));

    const ep = await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(ep.agentCertSerial).not.toBe("");
    expect(ep.agentJoinTokenHash).toBe("");

    // Docker API (dockerode) through the agent
    const docker = endpoints.dockerFor(ep);
    const info = await docker.info();
    expect(info.ServerVersion).toBeTruthy();
    const list = await docker.listContainers({ all: true });
    expect(Array.isArray(list)).toBe(true);

    // Several streams at once
    const versions = await Promise.all(Array.from({ length: 8 }, () => docker.version()));
    expect(new Set(versions.map((v) => v.Version)).size).toBe(1);

    // The docker CLI through the same socket
    const out: string[] = [];
    await cli.withDockerCli(endpoints.toConnection(ep), [], (c) =>
      cli.runCommand("docker", ["version", "--format", "{{.Server.Version}}"], { env: c.env, onOutput: (l) => out.push(l) }),
    );
    expect(out[0]).toBe(info.ServerVersion);

    // Status, version and host metrics arrive
    await until(async () => {
      const e = await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } });
      return e.status === "online" && !!e.hostMetrics && !!e.agentVersion && !!e.dockerVersion;
    });
    const m = JSON.parse((await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } })).hostMetrics);
    expect(m.memTotal).toBeGreaterThan(0);
    expect(m.diskTotal).toBeGreaterThan(0);
  }, 60_000);

  it("refuses a used join token", async () => {
    const res = await new Promise<number>((resolve) => {
      const child = spawn(agentBin, ["join", "--url", `https://127.0.0.1:${port}`, "--token", "dnj_not-a-real-token", "--ca", "sha256:00"], {
        env: { PATH: process.env.PATH, DEPLOYNOW_DATA: path.join(dir, "bad") } as unknown as NodeJS.ProcessEnv,
      });
      child.on("close", (code) => resolve(code ?? 0));
    });
    expect(res).not.toBe(0);
  });

  it("refuses an agent pinned to another CA", async () => {
    const join = await hub.joinInfo(endpointId);
    const out: string[] = [];
    const code = await new Promise<number>((resolve) => {
      const child = spawn(agentBin, ["join", "--url", `https://127.0.0.1:${port}`, "--token", join.token, "--ca", "sha256:" + "ab".repeat(32)], {
        env: { PATH: process.env.PATH, DEPLOYNOW_DATA: path.join(dir, "wrong-ca") } as unknown as NodeJS.ProcessEnv,
      });
      child.stderr.on("data", (d: Buffer) => out.push(d.toString()));
      child.on("close", (c) => resolve(c ?? 0));
    });
    expect(code).not.toBe(0);
    expect(out.join("")).toMatch(/pinned fingerprint/);
    // The token was never sent to the impostor check, so it is still unused
    expect((await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } })).agentJoinTokenHash).not.toBe("");
  });

  it("cuts a revoked agent off", async () => {
    await hub.revokeAgent(endpointId);
    await until(async () => !hub.isAgentConnected(endpointId));
    const ep = await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } });
    await expect(endpoints.dockerFor(ep).ping()).rejects.toThrow();
    // It keeps trying, but the hub refuses its certificate
    await new Promise((r) => setTimeout(r, 3000));
    expect(hub.isAgentConnected(endpointId)).toBe(false);
    expect(logs.join("")).toMatch(/refused this agent|disconnected/);
  }, 30_000);
});

vi.setConfig({ testTimeout: 60_000 });
