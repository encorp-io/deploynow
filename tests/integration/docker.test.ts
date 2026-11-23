/**
 * Runs the endpoint routes, recreate and the console WebSocket against a real
 * Docker daemon on /var/run/docker.sock. Skipped when no daemon is reachable.
 * Uses alpine:3.20 (pulled if missing).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "fs";
import Docker from "dockerode";
import WebSocket from "ws";

const SOCKET = "/var/run/docker.sock";
const EP_ID = "c" + "d".repeat(24);
const IMAGE = "alpine:3.20";

const mockPrisma = vi.hoisted(() => ({
  endpoint: { findUnique: vi.fn() },
  session: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  auditEvent: { create: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));

import { signInAs } from "../helpers/apiAuthMock";
import { recreateContainer } from "@/lib/docker/recreate";
import { probeDocker } from "@/lib/docker/client";

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
const NAME = `deploynow-it-${process.pid}`;
let containerId = "";

const params = (cid?: string) => ({ params: Promise.resolve({ id: EP_ID, cid: cid ?? containerId }) });
const req = (method = "GET", body?: unknown, qs = "") => new Request(`http://x/${qs}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!up)("against a real Docker daemon", () => {
  beforeAll(async () => {
    mockPrisma.endpoint.findUnique.mockResolvedValue({ id: EP_ID, name: "local", type: "socket", host: SOCKET, port: null, username: "", credentials: "", hostKeyFingerprint: "", updatedAt: new Date(), status: "online" });
    try {
      await docker.getImage(IMAGE).inspect();
    } catch {
      await new Promise<void>((resolve, reject) =>
        docker.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => (err ? reject(err) : docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())))),
      );
    }
    const c = await docker.createContainer({
      name: NAME,
      Image: IMAGE,
      Cmd: ["sh", "-c", "echo hello-out; echo hello-err >&2; sleep 600"],
      Env: ["APP_SECRET=s3cret", "PLAIN=1"],
      Labels: { "it.test": "1" },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
    });
    await c.start();
    containerId = c.id;
  }, 120_000);

  afterAll(async () => {
    const list = await docker.listContainers({ all: true, filters: { label: ["it.test=1"] } });
    await Promise.all(list.map((c) => docker.getContainer(c.Id).remove({ force: true }).catch(() => {})));
  });

  it("probes the daemon", async () => {
    const info = await probeDocker(docker);
    expect(info.dockerVersion).toMatch(/^\d+\./);
  });

  it("lists and inspects containers, hiding env values from viewers", async () => {
    const { GET: LIST } = await import("@/app/api/endpoints/[id]/containers/route");
    const { GET } = await import("@/app/api/endpoints/[id]/containers/[cid]/route");
    signInAs("viewer");
    const list = await (await LIST(req(), params())).json();
    expect(list.some((c: { name: string }) => c.name === NAME)).toBe(true);

    const asViewer = await (await GET(req(), params())).json();
    expect(asViewer.envHidden).toBe(true);
    expect(asViewer.env.find((e: { key: string }) => e.key === "APP_SECRET").value).toBeNull();

    signInAs("operator");
    const asOperator = await (await GET(req(), params())).json();
    expect(asOperator.env.find((e: { key: string }) => e.key === "APP_SECRET").value).toBe("s3cret");
    expect(asOperator.restartPolicy).toBe("unless-stopped");
  });

  it("reads logs with stdout and stderr separated", async () => {
    const { GET } = await import("@/app/api/endpoints/[id]/containers/[cid]/logs/route");
    signInAs("viewer");
    expect((await GET(req("GET", undefined, "?tail=10"), params())).status).toBe(403);
    signInAs("operator");
    const { text } = await (await GET(req("GET", undefined, "?tail=10"), params())).json();
    expect(text).toContain("hello-out");
    expect(text).toContain("hello-err");

    const res = await GET(req("GET", undefined, "?tail=10&follow=1"), params());
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let seen = "";
    while (!seen.includes("hello-err")) seen += new TextDecoder().decode((await reader.read()).value);
    expect(seen).toContain('"s":"stderr"');
    await reader.cancel();
  });

  it("reports stats", async () => {
    const { GET } = await import("@/app/api/endpoints/[id]/containers/[cid]/stats/route");
    signInAs("viewer");
    const stats = await (await GET(req(), params())).json();
    expect(stats.pids).toBeGreaterThan(0);
  });

  it("runs container actions for operators only", async () => {
    const { POST } = await import("@/app/api/endpoints/[id]/containers/[cid]/route");
    signInAs("viewer");
    expect((await POST(req("POST", { action: "restart" }), params())).status).toBe(403);
    signInAs("operator");
    expect((await POST(req("POST", { action: "rm -rf" }), params())).status).toBe(400);
    expect((await POST(req("POST", { action: "pause" }), params())).status).toBe(200);
    expect((await docker.getContainer(containerId).inspect()).State.Paused).toBe(true);
    expect((await POST(req("POST", { action: "unpause" }), params())).status).toBe(200);
    expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "container.pause" }) }));
  });

  it("returns 404 for an unknown container and 400 for a bad id", async () => {
    const { GET } = await import("@/app/api/endpoints/[id]/containers/[cid]/route");
    signInAs("viewer");
    expect((await GET(req(), params("doesnotexist123"))).status).toBe(404);
    expect((await GET(req(), params("../../etc"))).status).toBe(400);
  });

  it("lists images, volumes and networks and protects built-in networks", async () => {
    const images = await import("@/app/api/endpoints/[id]/images/route");
    const networks = await import("@/app/api/endpoints/[id]/networks/route");
    const volumes = await import("@/app/api/endpoints/[id]/volumes/route");
    signInAs("admin");
    const imgs = await (await images.GET(req(), params())).json();
    expect(imgs.find((i: { tags: string[] }) => i.tags.includes(IMAGE)).inUse).toBe(true);
    const nets = await (await networks.GET(req(), params())).json();
    expect(nets.find((n: { name: string }) => n.name === "bridge").builtin).toBe(true);
    expect((await volumes.GET(req(), params())).status).toBe(200);
    expect((await networks.DELETE(req("DELETE", undefined, "?ref=bridge"), params())).status).toBe(400);
  });

  it("issues a console ticket and runs a shell over the WebSocket", async () => {
    const { POST } = await import("@/app/api/endpoints/[id]/containers/[cid]/exec/route");
    const { startWsServer } = await import("@/lib/wsServer");
    const user = signInAs("operator");
    expect((await POST(req("POST", { shell: "/usr/bin/python" }), params())).status).toBe(400);
    const { ticket } = await (await POST(req("POST", { shell: "/bin/sh" }), params())).json();

    mockPrisma.session.findUnique.mockResolvedValue({ id: user.sid, revokedAt: null, expiresAt: new Date(Date.now() + 60_000) });
    mockPrisma.user.findUnique.mockResolvedValue({ id: user.id, email: user.email, role: "operator", disabledAt: null, roleBindings: [] });
    const port = 39000 + (process.pid % 1000);
    const server = startWsServer(port, "127.0.0.1");
    await new Promise((r) => (server.address() ? r(null) : server.once("listening", r)));

    const output = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/exec?ticket=${encodeURIComponent(ticket)}`);
      let out = "";
      // Sent straight away: the server must hold it until the shell is attached
      ws.on("open", () => ws.send(JSON.stringify({ t: "r", c: 120, r: 30 })));
      let sent = false;
      ws.on("message", (d) => {
        out += d.toString();
        // busybox asks for the cursor position (xterm.js answers this in the browser)
        if (out.includes("\x1b[6n") && !sent) {
          sent = true;
          ws.send(JSON.stringify({ t: "i", d: "\x1b[1;5R" }));
          setTimeout(() => ws.send(JSON.stringify({ t: "i", d: "echo marker-$((6*7))\n" })), 300);
        } else if (!sent && out.includes("#")) {
          sent = true;
          ws.send(JSON.stringify({ t: "i", d: "echo marker-$((6*7))\n" }));
        }
        if (out.includes("marker-42")) {
          ws.close();
          resolve(out);
        }
      });
      ws.on("error", reject);
      ws.on("close", (code, reason) => reject(new Error(`closed ${code} ${reason}: ${out}`)));
      setTimeout(() => reject(new Error(`timeout, got: ${JSON.stringify(out)}`)), 10_000);
    });
    expect(output).toContain("marker-42");

    // The ticket is single-use
    const reuse = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/exec?ticket=${encodeURIComponent(ticket)}`);
      ws.on("close", (code) => resolve(code));
    });
    expect(reuse).toBe(4401);
    server.close();
  }, 20_000);

  it("recreates a container and keeps its config", async () => {
    const newId = await recreateContainer(docker, containerId);
    containerId = newId;
    const info = await docker.getContainer(newId).inspect();
    expect(info.Name).toBe(`/${NAME}`);
    expect(info.State.Running).toBe(true);
    expect(info.Config.Env).toContain("APP_SECRET=s3cret");
    expect(info.HostConfig.RestartPolicy?.Name).toBe("unless-stopped");
    const leftovers = await docker.listContainers({ all: true, filters: { name: [`${NAME}-old`] } });
    expect(leftovers).toHaveLength(0);
  }, 60_000);

  it("keeps anonymous volume data and a static IP across a recreate", async () => {
    const netName = `deploynow-it-net-${process.pid}`;
    const net = await docker.createNetwork({ Name: netName, Labels: { "it.test": "1" }, IPAM: { Config: [{ Subnet: "172.31.250.0/24" }] } });
    try {
      const c = await docker.createContainer({
        name: `${NAME}-vol`,
        Image: IMAGE,
        Cmd: ["sh", "-c", "[ -f /data/keep ] || echo first > /data/keep; sleep 600"],
        Labels: { "it.test": "1" },
        Volumes: { "/data": {} },
        HostConfig: { NetworkMode: netName },
        NetworkingConfig: { EndpointsConfig: { [netName]: { IPAMConfig: { IPv4Address: "172.31.250.10" } } } },
      });
      await c.start();
      const before = await c.inspect();
      const volName = before.Mounts.find((m) => m.Destination === "/data")!.Name;

      const newId = await recreateContainer(docker, c.id);
      const after = await docker.getContainer(newId).inspect();
      expect(after.State.Running).toBe(true);
      expect(after.Mounts.find((m) => m.Destination === "/data")!.Name).toBe(volName);
      expect(after.NetworkSettings.Networks[netName].IPAddress).toBe("172.31.250.10");
      await docker.getContainer(newId).remove({ force: true, v: true });
    } finally {
      await net.remove().catch(() => {});
    }
  }, 60_000);

  it("needs a fresh 2FA code to remove a container", async () => {
    const { DELETE } = await import("@/app/api/endpoints/[id]/containers/[cid]/route");
    signInAs("operator");
    expect((await DELETE(req("DELETE"), params())).status).toBe(403);
    signInAs("admin", { totpEnabled: true, stepUpAt: null });
    const res = await DELETE(req("DELETE"), params());
    expect((await res.json()).stepUpRequired).toBe(true);
    signInAs("admin", { totpEnabled: true, stepUpAt: new Date() });
    expect((await DELETE(req("DELETE"), params())).status).toBe(200);
    await expect(docker.getContainer(containerId).inspect()).rejects.toThrow();
  });
});
