/** The agent join/revoke route and registry credential lookup, against a real temp database. */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-api-agent-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(() => ({})) }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/secretsCrypto";
import { allRegistryLogins, normalizeRegistryHost, registryAuthFor, testRegistry, validateRegistry } from "@/lib/registryAuth";
import * as agent from "@/app/api/endpoints/[id]/agent/route";

const req = (body: unknown) => new Request("https://localhost:9444/x", { method: "POST", body: JSON.stringify(body) });
const p = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => signOut());
afterEach(() => vi.unstubAllGlobals());

describe("agent route", () => {
  it("issues a join command and revokes with step-up", async () => {
    const ep = await prisma.endpoint.create({ data: { name: "far", type: "agent", host: "" } });
    const sock = await prisma.endpoint.create({ data: { name: "near", type: "socket", host: "/x.sock" } });
    signInAs("operator");
    expect((await agent.POST(req({ action: "join" }), p(ep.id))).status).toBe(403);
    signInAs("admin");
    expect((await agent.POST(req({ action: "join" }), p(sock.id))).status).toBe(400);
    expect((await agent.POST(req({ action: "dance" }), p(ep.id))).status).toBe(400);
    const join = await (await agent.POST(req({ action: "join" }), p(ep.id))).json();
    expect(join.command).toMatch(/deploynow-agent/);
    expect(join.token).toBeTruthy();
    signInAs("admin", { totpEnabled: true });
    expect((await agent.POST(req({ action: "revoke" }), p(ep.id))).status).toBe(403);
    signInAs("admin", { totpEnabled: true, stepUpAt: new Date() });
    expect((await agent.POST(req({ action: "revoke" }), p(ep.id))).status).toBe(200);
    expect((await prisma.endpoint.findUniqueOrThrow({ where: { id: ep.id } })).lastError).toBe("Agent revoked");
  });
});

describe("registry credentials", () => {
  it("normalises hosts and validates input", async () => {
    const actor = { id: "cuser0000000000000000000001", role: "admin" as const };
    expect(normalizeRegistryHost("https://Index.Docker.io/v1/")).toBe("docker.io");
    expect(normalizeRegistryHost("registry.example.com:5000/x")).toBe("registry.example.com:5000");
    await expect(validateRegistry({ name: "x", host: "ghcr.io", username: "" }, actor)).rejects.toThrow(/user name/);
    await expect(validateRegistry({ name: "x", host: "reg.example.com", username: "u" }, actor)).rejects.toThrow(/password/);
    await expect(validateRegistry({ name: "x", host: "ghcr.io", username: "u" }, actor)).rejects.toThrow(/access token/);
    await expect(validateRegistry({ name: "x", host: "ghcr.io", username: "u", password: "p", namespace: "Bad Space" }, actor)).rejects.toThrow(/namespace/);
    await expect(validateRegistry({ name: "x", host: "ghcr.io", username: "u", password: "p", namespace: "docker.io/acme" }, actor)).rejects.toThrow(/must be on ghcr.io/);
    await expect(validateRegistry({ name: "x", host: "docker.io", username: "u", password: "p", namespace: "acme" }, actor)).resolves.toMatchObject({ namespace: "acme", ownerType: "shared" });
  });

  it("matches images to saved credentials, falling back to the GitHub token for ghcr.io", async () => {
    await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", githubUser: "octo", githubToken: encryptSecret("ghp_legacy") }, update: { githubUser: "octo", githubToken: encryptSecret("ghp_legacy") } });
    expect(await registryAuthFor("ghcr.io/acme/app:1")).toEqual({ username: "octo", password: "ghp_legacy", serveraddress: "ghcr.io" });
    expect(await registryAuthFor("nginx:1")).toBeUndefined();
    await prisma.registry.create({ data: { name: "Hub", host: "docker.io", username: "me", password: encryptSecret("hubpw") } });
    await prisma.registry.create({ data: { name: "Mine", host: "registry.example.com:5000", username: "ci", password: encryptSecret("pw") } });
    expect(await registryAuthFor("nginx:1")).toEqual({ username: "me", password: "hubpw", serveraddress: "https://index.docker.io/v1/" });
    expect((await registryAuthFor("registry.example.com:5000/team/app@sha256:" + "a".repeat(64)))?.username).toBe("ci");
    const all = await allRegistryLogins();
    expect(all.map((a) => a.serveraddress).sort()).toEqual(["ghcr.io", "https://index.docker.io/v1/", "registry.example.com:5000"]);
  });

  it("tests credentials with the registry's token handshake", async () => {
    const r = await prisma.registry.create({ data: { name: "T", host: "reg.example.com", username: "u", password: encryptSecret("p") } });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("/v2/")) return new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="reg"' } });
      return new Response("{}", { status: 200 });
    }));
    expect(await testRegistry(r)).toEqual({ ok: true, message: "Signed in" });
    expect(calls[1]).toBe("https://auth.example.com/token?service=reg");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => (String(url).endsWith("/v2/") ? new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="https://auth.example.com/token"' } }) : new Response("", { status: 403 }))));
    expect((await testRegistry(r)).message).toMatch(/refused the credentials \(403\)/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));
    expect((await testRegistry(r)).ok).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    expect((await testRegistry(r)).message).toMatch(/answered 500/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ENOTFOUND"); }));
    expect((await testRegistry(r)).message).toBe("ENOTFOUND");
    expect((await testRegistry({ ...r, password: "garbage" })).ok).toBe(false);
  });
});
