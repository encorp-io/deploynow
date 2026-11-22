/** Notification channels, the Vault connection test and the endpoint edge proxy. */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-api-int-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(() => ({})) }));
vi.mock("@/lib/deploy/proxy", () => ({
  installProxy: vi.fn(async () => {}),
  removeProxy: vi.fn(async () => {}),
  proxyStatus: vi.fn(async () => ({ running: true, image: "traefik:v3.6", startedAt: "t", error: "" })),
  checkExternalProxy: vi.fn(async () => ({ ok: true, message: "Found traefik" })),
}));
vi.mock("@/lib/vault", async (orig) => ({ ...(await orig<typeof import("@/lib/vault")>()), testVault: vi.fn(async () => "Connected as root") }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import { decryptConfig } from "@/lib/notify";
import { checkExternalProxy, installProxy, removeProxy } from "@/lib/deploy/proxy";
import { testVault } from "@/lib/vault";
import * as notifications from "@/app/api/notifications/route";
import * as channel from "@/app/api/notifications/[id]/route";
import * as vault from "@/app/api/settings/vault/route";
import * as settings from "@/app/api/settings/route";
import * as proxy from "@/app/api/endpoints/[id]/proxy/route";

const req = (method: string, body?: unknown) => new Request("http://dn.local/x", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeAll(() => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

describe("notification channels", () => {
  it("is admin only", async () => {
    signInAs("operator");
    expect((await notifications.GET()).status).toBe(403);
  });

  it("creates, lists, updates, tests and deletes a channel", async () => {
    signInAs("admin");
    const created = await json(await notifications.POST(req("POST", { name: "Ops", type: "webhook", url: "https://hooks.example.com/dn", events: ["deploy.failure"] })));
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^[0-9a-f]{48}$/);
    const id = created.body.id;

    const list = await json(await notifications.GET());
    expect(list.body.channels).toEqual([{ id, name: "Ops", type: "webhook", events: ["deploy.failure"], enabled: true, lastError: "" }]);
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);

    expect((await channel.PATCH(req("PATCH", { enabled: false, events: "deploy.success,deploy.failure", url: "https://hooks.example.com/v2" }), p(id))).status).toBe(200);
    const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id } });
    expect(row.enabled).toBe(false);
    expect(decryptConfig(row.config)).toEqual({ url: "https://hooks.example.com/v2", secret: created.body.secret });
    expect((await channel.PATCH(req("PATCH", { events: [] }), p(id))).status).toBe(400);
    expect((await channel.PATCH(req("PATCH", { url: "http://insecure" }), p(id))).status).toBe(400);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 200 })).mockResolvedValueOnce(new Response("", { status: 404 })));
    expect((await channel.POST(req("POST"), p(id))).status).toBe(200);
    const failed = await json(await channel.POST(req("POST"), p(id)));
    expect(failed.status).toBe(502);
    expect((await prisma.notificationChannel.findUniqueOrThrow({ where: { id } })).lastError).toBe("The channel answered 404");
    vi.unstubAllGlobals();

    expect((await channel.DELETE(req("DELETE"), p(id))).status).toBe(200);
    expect((await channel.DELETE(req("DELETE"), p(id))).status).toBe(404);
    expect((await channel.PATCH(req("PATCH", {}), p("bad"))).status).toBe(404);
  });

  it("validates new channels", async () => {
    signInAs("admin");
    expect((await notifications.POST(req("POST", { name: "", type: "slack" }))).status).toBe(400);
    expect((await notifications.POST(req("POST", { name: "x", type: "slack", url: "nope" }))).status).toBe(400);
    expect((await notifications.POST(req("POST", { name: "x", type: "slack", url: "https://hooks.slack.com/x", events: ["nope"] }))).status).toBe(400);
  });
});

describe("Vault settings", () => {
  it("saves Vault settings, masks credentials and tests the connection", async () => {
    signInAs("admin");
    expect((await vault.POST()).status).toBe(400);
    const saved = await settings.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ vault: { addr: "https://vault.example.com", auth: "approle", roleId: "r", secretId: "s-123" } }) }));
    expect(saved.status).toBe(200);
    const got = await json(await settings.GET());
    expect(got.body.vault).toMatchObject({ addr: "https://vault.example.com", auth: "approle", roleId: "r", secretId: "••••••••" });
    const r = await json(await vault.POST());
    expect(r.body).toEqual({ ok: true, message: "Connected as root" });
    expect(vi.mocked(testVault).mock.calls[0][0]).toMatchObject({ secretId: "s-123" });
    vi.mocked(testVault).mockRejectedValueOnce(new Error("denied"));
    expect((await vault.POST()).status).toBe(502);
    expect((await settings.PUT(new Request("http://x", { method: "PUT", body: JSON.stringify({ vault: { addr: "http://vault.example.com" } }) }))).status).toBe(400);
    signInAs("operator");
    expect((await vault.POST()).status).toBe(403);
  });
});

describe("edge proxy", () => {
  it("installs, switches and removes the proxy", async () => {
    const ep = await prisma.endpoint.create({ data: { name: "edge", type: "socket", host: "/x.sock" } });
    signInAs("admin");
    expect((await json(await proxy.GET(req("GET"), p(ep.id)))).body.mode).toBe("none");
    expect((await proxy.POST(req("POST", { mode: "magic" }), p(ep.id))).status).toBe(400);

    expect((await json(await proxy.POST(req("POST", { mode: "managed", email: "ops@example.com" }), p(ep.id)))).body.mode).toBe("managed");
    expect(installProxy).toHaveBeenCalledWith(expect.anything(), { email: "ops@example.com", network: "deploynow" });
    expect((await json(await proxy.GET(req("GET"), p(ep.id)))).body.status.running).toBe(true);

    const ext = await json(await proxy.POST(req("POST", { mode: "external", network: "dokploy-network" }), p(ep.id)));
    expect(ext.body).toMatchObject({ mode: "external", network: "dokploy-network" });
    expect(removeProxy).toHaveBeenCalled();
    expect((await json(await proxy.GET(req("GET"), p(ep.id)))).body.check.ok).toBe(true);
    vi.mocked(checkExternalProxy).mockResolvedValueOnce({ ok: false, message: "No Traefik" });
    expect((await proxy.POST(req("POST", { mode: "external", network: "other" }), p(ep.id))).status).toBe(422);

    vi.mocked(installProxy).mockRejectedValueOnce(new Error("Ports 80 or 443 are already in use"));
    expect((await proxy.POST(req("POST", { mode: "managed", email: "ops@example.com" }), p(ep.id))).status).toBe(400);
    vi.mocked(installProxy).mockRejectedValueOnce(new Error("daemon exploded"));
    expect((await proxy.POST(req("POST", { mode: "managed", email: "ops@example.com" }), p(ep.id))).status).toBe(502);
    expect((await prisma.endpoint.findUniqueOrThrow({ where: { id: ep.id } })).proxyError).toBe("daemon exploded");

    expect((await json(await proxy.POST(req("POST", { mode: "none" }), p(ep.id)))).body.mode).toBe("none");
    signInAs("operator");
    expect((await proxy.POST(req("POST", { mode: "none" }), p(ep.id))).status).toBe(403);
  });
});
