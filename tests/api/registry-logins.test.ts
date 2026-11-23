/**
 * Personal registry logins and shared service accounts, against a real
 * SQLite database: who sees and manages which login, which login an app
 * pulls with, and how apps pick one.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-api-reg-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(async () => { throw new Error("no docker in tests"); }) }));
vi.mock("@/lib/deploy/runner", () => ({ teardownApplication: vi.fn(async () => {}), runDeployment: vi.fn() }));
vi.mock("@/lib/registryAuth", async (orig) => ({ ...(await orig<typeof import("@/lib/registryAuth")>()), testRegistry: vi.fn(async () => ({ ok: false, message: "The registry refused the credentials (401)" })) }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/secretsCrypto";
import { allRegistryLogins, registryAuthFor } from "@/lib/registryAuth";
import * as registries from "@/app/api/registries/route";
import * as registry from "@/app/api/registries/[id]/route";
import * as apps from "@/app/api/apps/route";
import * as appRoute from "@/app/api/apps/[id]/route";

const req = (method: string, body?: unknown, url = "https://localhost:9444/x") =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

const ALICE = "cuseralice000000000000000001";
const BOB = "cuserbob00000000000000000001";
let endpointId = "";
let projA = "";
let projB = "";
let envA = "";

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  endpointId = (await prisma.endpoint.create({ data: { name: "edge", type: "socket", host: "/x.sock" } })).id;
  await prisma.user.create({ data: { id: ALICE, email: "alice@test.local", name: "Alice", password: "x", role: "operator" } });
  await prisma.user.create({ data: { id: BOB, email: "bob@test.local", name: "Bob", password: "x", role: "operator" } });
  const a = await prisma.project.create({ data: { name: "Shop", slug: "shop", environments: { create: { name: "production", slug: "production" } } }, include: { environments: true } });
  const b = await prisma.project.create({ data: { name: "Blog", slug: "blog" } });
  projA = a.id;
  envA = a.environments[0].id;
  projB = b.id;
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  signOut();
  await prisma.application.deleteMany();
  await prisma.registry.deleteMany();
  await prisma.settings.deleteMany();
});

const asAlice = (extra = {}) => signInAs("operator", { id: ALICE, email: "alice@test.local", ...extra });
const asBob = () => signInAs("operator", { id: BOB, email: "bob@test.local" });
const add = async (body: Record<string, unknown>) => json(await registries.POST(req("POST", body)));

describe("personal logins", () => {
  it("are private to their owner, and anyone can add their own", async () => {
    asAlice();
    const mine = await add({ ownerType: "personal", name: "My Docker Hub", host: "hub.docker.com", username: "alice", password: "dckr_pat_alice" });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ ownerType: "personal", mine: true, canManage: true, host: "docker.io", provider: "dockerhub", password: "••••••••" });
    expect((await add({ ownerType: "personal", name: "My Docker Hub", host: "docker.io", username: "a", password: "p" })).status).toBe(409);
    expect((await add({ ownerType: "personal", projectId: projA, name: "x", host: "docker.io", username: "a", password: "p" })).status).toBe(400);

    asBob();
    // Bob can use the same name for his own, and never sees Alice's
    expect((await add({ ownerType: "personal", name: "My Docker Hub", host: "docker.io", username: "bob", password: "dckr_pat_bob" })).status).toBe(201);
    const list = await json(await registries.GET(req("GET")));
    expect(list.body.map((r: { username: string }) => r.username)).toEqual(["bob"]);
    expect((await registry.PATCH(req("PATCH", { username: "x" }), p(mine.body.id))).status).toBe(404);
    expect((await registry.POST(req("POST"), p(mine.body.id))).status).toBe(404);
    expect((await registry.DELETE(req("DELETE"), p(mine.body.id))).status).toBe(404);

    asAlice();
    expect((await registry.PATCH(req("PATCH", { ownerType: "shared" }), p(mine.body.id))).status).toBe(400);
    const tested = await json(await registry.POST(req("POST"), p(mine.body.id)));
    expect(tested.body.ok).toBe(false);
    expect((await prisma.registry.findUniqueOrThrow({ where: { id: mine.body.id } })).lastTestOk).toBe(false);
    // A new password clears the last test result
    await registry.PATCH(req("PATCH", { password: "dckr_pat_new" }), p(mine.body.id));
    expect((await prisma.registry.findUniqueOrThrow({ where: { id: mine.body.id } })).lastTestOk).toBeNull();
  });

  it("are removed with their owner", async () => {
    const u = await prisma.user.create({ data: { email: "temp@test.local", name: "T", password: "x" } });
    await prisma.registry.create({ data: { name: "Mine", host: "ghcr.io", username: "t", password: encryptSecret("p"), ownerType: "personal", userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
    expect(await prisma.registry.count()).toBe(0);
  });
});

describe("shared logins (service accounts)", () => {
  it("are added by admins for everyone, or by a project's admins for that project", async () => {
    asAlice();
    expect((await add({ name: "Bot", host: "ghcr.io", username: "acme-bot", password: "ghp_x" })).status).toBe(403);
    expect((await add({ ownerType: "shared", projectId: projA, name: "Bot", host: "ghcr.io", username: "acme-bot", password: "ghp_x" })).status).toBe(403);

    asAlice({ bindings: [{ role: "admin", scopeType: "project", scopeId: projA }] });
    const scoped = await add({ ownerType: "shared", projectId: projA, name: "Shop bot", host: "ghcr.io", username: "shop-bot", password: "ghp_shop" });
    expect(scoped.status).toBe(201);
    expect(scoped.body).toMatchObject({ ownerType: "shared", projectId: projA, projectName: "Shop", canManage: true });
    expect((await add({ ownerType: "shared", projectId: projB, name: "Blog bot", host: "ghcr.io", username: "b", password: "p" })).status).toBe(403);
    expect((await registry.PATCH(req("PATCH", { projectId: projB }), p(scoped.body.id))).status).toBe(400);

    signInAs("admin");
    const global = await add({ name: "Acme bot", host: "ghcr.io", username: "acme-bot", password: "ghp_acme", namespace: "ghcr.io/acme" });
    expect(global.status).toBe(201);
    expect((await add({ name: "Acme bot", host: "docker.io", username: "x", password: "p" })).status).toBe(409);

    // Everyone sees shared logins (masked) but only managers may change them
    asBob();
    const list = await json(await registries.GET(req("GET")));
    expect(list.body).toHaveLength(2);
    expect(list.body.every((r: { canManage: boolean; password: string }) => !r.canManage && r.password === "••••••••")).toBe(true);
    expect((await registry.PATCH(req("PATCH", { username: "x" }), p(global.body.id))).status).toBe(403);
    expect((await registry.DELETE(req("DELETE"), p(global.body.id))).status).toBe(403);
    // ?projectId= narrows to what an app in that project may use
    const forBlog = await json(await registries.GET(req("GET", undefined, `https://localhost:9444/x?projectId=${projB}`)));
    expect(forBlog.body.map((r: { name: string }) => r.name)).toEqual(["Acme bot"]);
  });
});

describe("which login an app pulls with", () => {
  async function seed() {
    const mk = (data: Record<string, unknown>) => prisma.registry.create({ data: { username: "u", password: encryptSecret(String(data.secret)), ...Object.fromEntries(Object.entries(data).filter(([k]) => k !== "secret")) } as never });
    const global = await mk({ name: "Acme bot", host: "ghcr.io", username: "acme-bot", secret: "ghp_global" });
    const shop = await mk({ name: "Shop bot", host: "ghcr.io", username: "shop-bot", secret: "ghp_shop", projectId: projA });
    const alice = await mk({ name: "Alice GHCR", host: "ghcr.io", username: "alice", secret: "ghp_alice", ownerType: "personal", userId: ALICE });
    const hub = await mk({ name: "Hub bot", host: "docker.io", username: "hub-bot", secret: "dckr_hub" });
    return { global, shop, alice, hub };
  }

  it("prefers the app's choice, then the project's shared login, then the instance one", async () => {
    const r = await seed();
    const img = "ghcr.io/acme/web:1";
    expect((await registryAuthFor(img))?.username).toBe("acme-bot");
    expect((await registryAuthFor(img, { projectId: projB }))?.username).toBe("acme-bot");
    expect((await registryAuthFor(img, { projectId: projA }))?.username).toBe("shop-bot");
    expect((await registryAuthFor(img, { projectId: projA, pullRegistryId: r.alice.id }))?.username).toBe("alice");
    // A project's login can't be borrowed by another project
    expect((await registryAuthFor(img, { projectId: projB, pullRegistryId: r.shop.id }))?.username).toBe("acme-bot");
    // Personal logins are never used unless picked
    expect((await allRegistryLogins({ projectId: projB })).map((a) => a.username).sort()).toEqual(["acme-bot", "hub-bot"]);
    // The push registry wins for its host, so builds push with that account
    expect((await registryAuthFor(img, { projectId: projA, pullRegistryId: r.alice.id, pushRegistryId: r.global.id }))?.username).toBe("acme-bot");
    expect((await registryAuthFor("nginx:1", { projectId: projA }))).toMatchObject({ username: "hub-bot", password: "dckr_hub", serveraddress: "https://index.docker.io/v1/" });
  });

  it("skips a disabled user's personal login", async () => {
    const r = await seed();
    await prisma.user.update({ where: { id: ALICE }, data: { disabledAt: new Date() } });
    try {
      expect((await registryAuthFor("ghcr.io/acme/web:1", { projectId: projA, pullRegistryId: r.alice.id }))?.username).toBe("shop-bot");
    } finally {
      await prisma.user.update({ where: { id: ALICE }, data: { disabledAt: null } });
    }
  });

  it("lets an app pick a login its editor may use, on the image's host", async () => {
    const r = await seed();
    const base = { environmentId: envA, endpointId, name: "web", image: "ghcr.io/acme/web:1" };
    asAlice({ bindings: [{ role: "admin", scopeType: "project", scopeId: projA }] });
    expect((await apps.POST(req("POST", { ...base, pullRegistryId: r.hub.id }))).status).toBe(400); // docker.io login for a ghcr.io image
    const made = await json(await apps.POST(req("POST", { ...base, pullRegistryId: r.alice.id })));
    expect(made.status).toBe(201);
    expect((await json(await appRoute.GET(req("GET"), p(made.body.id)))).body.pullRegistryId).toBe(r.alice.id);

    // Bob, also a project admin, can't pick Alice's personal login, but can leave it in place
    signInAs("operator", { id: BOB, email: "bob@test.local", bindings: [{ role: "admin", scopeType: "project", scopeId: projA }] });
    expect((await apps.POST(req("POST", { ...base, name: "web2", pullRegistryId: r.alice.id }))).status).toBe(400);
    expect((await appRoute.PATCH(req("PATCH", { pullRegistryId: r.alice.id, command: "serve" }), p(made.body.id))).status).toBe(200);
    expect((await appRoute.PATCH(req("PATCH", { pullRegistryId: r.shop.id }), p(made.body.id))).status).toBe(200);

    // A login in use can't be removed
    signInAs("admin");
    await appRoute.PATCH(req("PATCH", { pullRegistryId: r.global.id }), p(made.body.id));
    const blocked = await json(await registry.DELETE(req("DELETE"), p(r.global.id)));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/web/);
  });
});
