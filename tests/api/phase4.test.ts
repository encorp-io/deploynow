/**
 * Phase 4 routes against a real SQLite database: API tokens, registries,
 * single sign-on, passkeys, domain redirects and basic auth, build settings
 * and pull request previews. Docker and identity providers are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-api-p4-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(async () => { throw new Error("no docker in tests"); }) }));
vi.mock("@/lib/deploy/runner", () => ({ teardownApplication: vi.fn(async () => {}), runDeployment: vi.fn() }));
vi.mock("@/lib/sso", async (orig) => ({
  ...(await orig<typeof import("@/lib/sso")>()),
  startLogin: vi.fn(async () => "https://idp.example.com/auth?state=s"),
  finishLogin: vi.fn(),
}));
vi.mock("@/lib/registryAuth", async (orig) => ({ ...(await orig<typeof import("@/lib/registryAuth")>()), testRegistry: vi.fn(async () => ({ ok: true, message: "Signed in" })) }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import { teardownApplication } from "@/lib/deploy/runner";
import { finishLogin, peekTicket, SsoError } from "@/lib/sso";
import * as tokens from "@/app/api/tokens/route";
import * as tokenRoute from "@/app/api/tokens/[id]/route";
import * as registries from "@/app/api/registries/route";
import * as registry from "@/app/api/registries/[id]/route";
import * as ssoRoute from "@/app/api/sso/route";
import * as ssoOne from "@/app/api/sso/[id]/route";
import * as ssoLogin from "@/app/api/sso/login/route";
import * as ssoStart from "@/app/api/sso/login/[id]/route";
import * as ssoCallback from "@/app/api/sso/callback/route";
import * as passkeys from "@/app/api/passkeys/route";
import * as passkey from "@/app/api/passkeys/[id]/route";
import * as pkRegister from "@/app/api/passkeys/register/route";
import * as pkLogin from "@/app/api/passkeys/login/route";
import * as pkVerify from "@/app/api/passkeys/login/verify/route";
import * as projects from "@/app/api/projects/route";
import * as apps from "@/app/api/apps/route";
import * as appRoute from "@/app/api/apps/[id]/route";
import * as domains from "@/app/api/apps/[id]/domains/route";
import * as github from "@/app/api/webhooks/github/[appId]/route";
import * as openapi from "@/app/api/openapi.json/route";
import { decryptSecret } from "@/lib/secretsCrypto";

const req = (method: string, body?: unknown, url = "https://localhost:9444/x") =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

const ME = "cuser0000000000000000000001";
let endpointId = "";
let builderId = "";

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  endpointId = (await prisma.endpoint.create({ data: { name: "edge", type: "socket", host: "/x.sock", proxyMode: "managed" } })).id;
  builderId = (await prisma.endpoint.create({ data: { name: "builder", type: "socket", host: "/b.sock" } })).id;
  await prisma.user.create({ data: { id: ME, email: "me@test.local", name: "Me", password: "x", role: "admin" } });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

describe("API token routes", () => {
  it("creates, lists and revokes your own tokens, and refuses token callers", async () => {
    expect((await tokens.GET()).status).toBe(401);
    signInAs("operator");
    expect((await tokens.POST(req("POST", { name: "x", scope: "admin" }))).status).toBe(400);
    const made = await json(await tokens.POST(req("POST", { name: "CI", scope: "operator", expiresInDays: 30 })));
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^dn_/);
    const list = await json(await tokens.GET());
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty("token");
    expect(list.body[0]).not.toHaveProperty("hash");
    expect((await tokenRoute.DELETE(req("DELETE"), p({ id: made.body.id }))).status).toBe(200);
    expect((await json(await tokens.GET())).body[0].revoked).toBe(true);
    expect((await tokenRoute.DELETE(req("DELETE"), p({ id: "cmissing0000000000000000x" }))).status).toBe(404);
    signInAs("operator", { tokenId: "t" });
    expect((await tokens.GET()).status).toBe(403);
    expect((await tokens.POST(req("POST", { name: "x" }))).status).toBe(403);
  });

  it("serves an OpenAPI description", async () => {
    const doc = await json(await openapi.GET());
    expect(doc.body.openapi).toMatch(/^3\./);
    expect(doc.body.paths["/apps/{id}/deploy"].post).toBeDefined();
  });
});

describe("registries", () => {
  it("lets only admins add shared logins, masks the password, and can't be removed while apps use it", async () => {
    signInAs("operator");
    expect((await registries.GET()).status).toBe(200);
    expect((await registries.POST(req("POST", { name: "x", host: "ghcr.io", username: "u", password: "p" }))).status).toBe(403);
    signInAs("admin");
    expect((await registries.POST(req("POST", { name: "x", host: "bad host", username: "u", password: "p" }))).status).toBe(400);
    const r = await json(await registries.POST(req("POST", { name: "GHCR", host: "https://ghcr.io/", username: "bot", password: "tok", namespace: "ghcr.io/acme" })));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ host: "ghcr.io", password: "••••••••" });
    expect((await registries.POST(req("POST", { name: "GHCR", host: "ghcr.io", username: "u", password: "p" }))).status).toBe(409);
    const stored = await prisma.registry.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(decryptSecret(stored.password)).toBe("tok");
    expect((await json(await registry.PATCH(req("PATCH", { password: "••••••••", username: "bot2" }), p({ id: r.body.id })))).body.username).toBe("bot2");
    expect(decryptSecret((await prisma.registry.findUniqueOrThrow({ where: { id: r.body.id } })).password)).toBe("tok");
    expect((await json(await registry.POST(req("POST"), p({ id: r.body.id })))).body.ok).toBe(true);
    expect((await registry.DELETE(req("DELETE"), p({ id: r.body.id }))).status).toBe(200);
    expect((await registry.DELETE(req("DELETE"), p({ id: r.body.id }))).status).toBe(404);
  });
});

describe("single sign-on routes", () => {
  it("manages providers as admin and lists enabled ones publicly", async () => {
    signInAs("operator");
    expect((await ssoRoute.GET(req("GET"))).status).toBe(403);
    signInAs("admin");
    expect((await ssoRoute.POST(req("POST", { type: "google" }))).status).toBe(400);
    const g = await json(await ssoRoute.POST(req("POST", { type: "google", clientId: "gid", clientSecret: "gsecret", allowedDomains: "acme.com" })));
    expect(g.status).toBe(201);
    expect(g.body.clientSecret).toBe("••••••••");
    const list = await json(await ssoRoute.GET(req("GET")));
    expect(list.body.redirectUri).toBe("https://localhost:9444/api/sso/callback");
    expect(list.body.providers[0]).toMatchObject({ name: "Google", linkedUsers: 0 });
    expect((await json(await ssoOne.PATCH(req("PATCH", { enabled: false }), p({ id: g.body.id })))).body.enabled).toBe(false);
    expect(await json(await ssoLogin.GET()).then((r) => r.body)).toEqual([]);
    await ssoOne.PATCH(req("PATCH", { enabled: true }), p({ id: g.body.id }));
    expect((await json(await ssoLogin.GET())).body).toEqual([{ id: g.body.id, name: "Google", type: "google" }]);
    // Removing a provider needs a fresh 2FA code when the admin has 2FA
    signInAs("admin", { totpEnabled: true });
    expect((await ssoOne.DELETE(req("DELETE"), p({ id: g.body.id }))).status).toBe(403);
    signInAs("admin", { totpEnabled: true, stepUpAt: new Date() });
    expect((await ssoOne.DELETE(req("DELETE"), p({ id: g.body.id }))).status).toBe(200);
  });

  it("sends the browser to the provider and back to the login page with a ticket", async () => {
    signInAs("admin");
    const ms = await json(await ssoRoute.POST(req("POST", { type: "microsoft", clientId: "mid", clientSecret: "ms", tenant: "contoso.com" })));
    signOut();
    const start = await ssoStart.GET(req("GET"), p({ id: ms.body.id }));
    expect(start.headers.get("location")).toBe("https://idp.example.com/auth?state=s");
    expect((await ssoStart.GET(req("GET"), p({ id: "cmissing0000000000000000x" }))).headers.get("location")).toMatch(/error=sso_unavailable/);

    const provider = await prisma.ssoProvider.findUniqueOrThrow({ where: { id: ms.body.id } });
    vi.mocked(finishLogin).mockResolvedValueOnce({ user: (await prisma.user.findUniqueOrThrow({ where: { id: ME } })) as never, provider, origin: "https://localhost:9444" });
    const back = await ssoCallback.GET(req("GET", undefined, "https://localhost:9444/api/sso/callback?state=s&code=c"));
    const loc = new URL(back.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(await peekTicket(loc.searchParams.get("ticket")!)).toMatchObject({ userId: ME, method: "sso", detail: "Microsoft" });

    vi.mocked(finishLogin).mockRejectedValueOnce(new SsoError("Sign-in with Microsoft is limited to @acme.com addresses"));
    const err = new URL((await ssoCallback.GET(req("GET", undefined, "https://localhost:9444/api/sso/callback?state=s&code=c"))).headers.get("location")!);
    expect(err.searchParams.get("message")).toMatch(/limited to @acme.com/);
    expect(new URL((await ssoCallback.GET(req("GET", undefined, "https://localhost:9444/api/sso/callback?error=access_denied"))).headers.get("location")!).searchParams.get("error")).toBe("sso_cancelled");
    expect(new URL((await ssoCallback.GET(req("GET", undefined, "https://localhost:9444/api/sso/callback"))).headers.get("location")!).searchParams.get("error")).toBe("sso_failed");
  });
});

describe("passkey routes", () => {
  it("lists, renames and removes your passkeys only", async () => {
    const mine = await prisma.passkey.create({ data: { userId: ME, credentialId: "cred-mine", publicKey: "k", name: "Old" } });
    const other = await prisma.user.create({ data: { email: "o@test.local", name: "O", password: "x" } });
    const theirs = await prisma.passkey.create({ data: { userId: other.id, credentialId: "cred-theirs", publicKey: "k" } });
    signInAs("viewer");
    expect((await json(await passkeys.GET())).body.map((x: { id: string }) => x.id)).toEqual([mine.id]);
    expect((await json(await passkey.PATCH(req("PATCH", { name: "Laptop" }), p({ id: mine.id })))).body.name).toBe("Laptop");
    expect((await passkey.PATCH(req("PATCH", { name: "" }), p({ id: mine.id }))).status).toBe(400);
    expect((await passkey.PATCH(req("PATCH", { name: "x" }), p({ id: theirs.id }))).status).toBe(404);
    expect((await passkey.DELETE(req("DELETE"), p({ id: theirs.id }))).status).toBe(404);
    signInAs("viewer", { totpEnabled: true });
    expect((await passkey.DELETE(req("DELETE"), p({ id: mine.id }))).status).toBe(403);
    signInAs("viewer", { totpEnabled: true, stepUpAt: new Date() });
    expect((await passkey.DELETE(req("DELETE"), p({ id: mine.id }))).status).toBe(200);
  });

  it("hands out challenges and rejects malformed answers", async () => {
    signInAs("admin");
    const reg = await json(await pkRegister.POST(req("POST", {})));
    expect(reg.body.rp.id).toBe("localhost");
    expect((await pkRegister.PUT(req("PUT", {}))).status).toBe(400);
    expect((await pkRegister.PUT(req("PUT", { response: { id: "x", response: {} } }))).status).toBe(400);
    signOut();
    const login = await json(await pkLogin.POST(req("POST")));
    expect(login.body.challenge).toMatch(/^[\w-]+$/);
    expect((await pkVerify.POST(req("POST", {}))).status).toBe(400);
    const bad = await json(await pkVerify.POST(req("POST", { response: { id: "nope", response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: login.body.challenge })).toString("base64url") } } })));
    expect(bad).toMatchObject({ status: 400, body: { error: expect.stringMatching(/isn't registered/) } });
  });
});

async function project(name: string) {
  signInAs("admin");
  const r = await json(await projects.POST(req("POST", { name, endpointId })));
  return r.body.environments[0].id as string;
}

describe("domains with redirects and basic auth", () => {
  it("adds a redirect and a password-protected route", async () => {
    const envId = await project("Domains");
    const appId = (await json(await apps.POST(req("POST", { environmentId: envId, name: "site", image: "nginx:1" })))).body.id;
    const add = (body: Record<string, unknown>) => domains.POST(req("POST", body), p({ id: appId }));
    const redirect = await json(await add({ host: "www.example.com", redirectTo: "https://example.com/", redirectCode: 301 }));
    expect(redirect.status).toBe(201);
    expect(redirect.body).toMatchObject({ redirectTo: "https://example.com", redirectCode: 301, containerPort: 80 });
    expect((await add({ host: "loop.example.com", redirectTo: "https://loop.example.com" })).status).toBe(400);
    expect((await add({ host: "x.example.com", redirectTo: "https://example.com", redirectCode: 303 })).status).toBe(400);
    const guarded = await json(await add({ host: "admin.example.com", containerPort: 8080, basicAuthUser: "ops", basicAuthPassword: "longenough" }));
    expect(guarded.status).toBe(201);
    expect(guarded.body.basicAuth).toBe("ops");
    expect((await prisma.domain.findUniqueOrThrow({ where: { id: guarded.body.id } })).basicAuth).toMatch(/^ops:\$2y\$/);
    expect((await add({ host: "weak.example.com", containerPort: 80, basicAuthUser: "ops", basicAuthPassword: "short" })).status).toBe(400);
    const view = await json(await appRoute.GET(req("GET"), p({ id: appId })));
    expect(view.body.domains.find((d: { host: string }) => d.host === "admin.example.com")).toMatchObject({ basicAuthUser: "ops" });
    expect(JSON.stringify(view.body)).not.toContain("$2y$");
  });
});

describe("build server and previews settings", () => {
  it("needs a registry with a namespace to build elsewhere, and Git plus a domain for previews", async () => {
    const envId = await project("Builds");
    const reg = await prisma.registry.create({ data: { name: "R", host: "ghcr.io", username: "u", password: "p", namespace: "ghcr.io/acme" } });
    const bare = await prisma.registry.create({ data: { name: "R2", host: "docker.io", username: "u", password: "p" } });
    const git = { environmentId: envId, sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/api", gitBranch: "main" };
    expect((await apps.POST(req("POST", { ...git, name: "a1", buildEndpointId: builderId }))).status).toBe(400);
    expect((await apps.POST(req("POST", { ...git, name: "a2", buildEndpointId: builderId, registryId: bare.id }))).status).toBe(400);
    expect((await apps.POST(req("POST", { ...git, name: "a3", buildEndpointId: "cmissing0000000000000000x", registryId: reg.id }))).status).toBe(400);
    const ok = await json(await apps.POST(req("POST", { ...git, name: "a4", buildEndpointId: builderId, registryId: reg.id })));
    expect(ok.status).toBe(201);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: ok.body.id } })).buildEndpointId).toBe(builderId);
    expect((await apps.POST(req("POST", { environmentId: envId, name: "img", image: "nginx", buildEndpointId: builderId, registryId: reg.id }))).status).toBe(400);
    expect((await apps.POST(req("POST", { environmentId: envId, name: "img2", image: "nginx", previewsEnabled: true, previewDomain: "p.example.com" }))).status).toBe(400);
    expect((await appRoute.PATCH(req("PATCH", { previewsEnabled: true }), p({ id: ok.body.id }))).status).toBe(400);
    expect((await appRoute.PATCH(req("PATCH", { previewsEnabled: true, previewDomain: "Preview.Builds.Example.com" }), p({ id: ok.body.id }))).status).toBe(200);
    const view = await json(await appRoute.GET(req("GET"), p({ id: ok.body.id })));
    expect(view.body).toMatchObject({ previewsEnabled: true, previewDomain: "preview.builds.example.com", registryId: reg.id });
  });
});

describe("pull request previews", () => {
  const SHA = "a".repeat(40);
  const event = (action: string, n: number, over: Record<string, unknown> = {}) => ({
    action,
    number: n,
    pull_request: { number: n, title: "Add search", head: { ref: "feature/search", sha: SHA, repo: { full_name: "acme/web" } }, base: { ref: "main", repo: { full_name: "acme/web" } }, ...over },
  });
  async function send(appId: string, ev: unknown, kind = "pull_request") {
    const app = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const body = JSON.stringify(ev);
    const sig = "sha256=" + crypto.createHmac("sha256", decryptSecret(app.webhookSecret)).update(body).digest("hex");
    return json(await github.POST(new Request(`https://localhost:9444/api/webhooks/github/${appId}`, { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": kind } }), p({ appId })));
  }

  it("creates, redeploys and removes a preview per pull request", async () => {
    const envId = await project("Previews");
    const parentId = (await json(await apps.POST(req("POST", { environmentId: envId, name: "web", sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/web", gitBranch: "main", ports: [{ host: 8080, container: 80 }], previewsEnabled: true, previewDomain: "preview.example.com" })))).body.id;
    await domains.POST(req("POST", { host: "web.example.com", containerPort: 3000 }), p({ id: parentId }));

    const opened = await send(parentId, event("opened", 7));
    expect(opened.status).toBe(202);
    const preview = await prisma.application.findUniqueOrThrow({ where: { id: opened.body.previewId }, include: { domains: true, deployments: true } });
    expect(preview).toMatchObject({ slug: "web-pr-7", gitBranch: "feature/search", previewOfId: parentId, prNumber: 7, ports: "[]", updatePolicy: "manual" });
    expect(preview.domains.map((d) => [d.host, d.containerPort])).toEqual([["pr-7.preview.example.com", 3000]]);
    expect(preview.deployments[0]).toMatchObject({ trigger: "preview", commitSha: SHA, status: "queued" });

    // A new push while the first deploy is still queued
    expect((await send(parentId, event("synchronize", 7))).body.ignored).toMatch(/already queued/);
    await prisma.deployment.updateMany({ where: { applicationId: preview.id }, data: { status: "success" } });
    const sync = await send(parentId, event("synchronize", 7, { head: { ref: "feature/search-2", sha: "b".repeat(40), repo: { full_name: "acme/web" } } }));
    expect(sync.body.previewId).toBe(preview.id);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: preview.id } })).gitBranch).toBe("feature/search-2");

    expect((await send(parentId, event("opened", 8, { head: { ref: "x", sha: SHA, repo: { full_name: "mallory/web" } } }))).body.ignored).toMatch(/forks/);
    expect((await send(parentId, event("opened", 9, { base: { ref: "develop", repo: { full_name: "acme/web" } } }))).body.ignored).toMatch(/into main/);
    expect((await send(parentId, event("labeled", 7))).body.ignored).toMatch(/action labeled/);

    const closed = await send(parentId, event("closed", 7));
    expect(closed.body.removed).toBe(true);
    expect(teardownApplication).toHaveBeenCalledTimes(1);
    expect(await prisma.application.findUnique({ where: { id: preview.id } })).toBeNull();
    expect((await send(parentId, event("closed", 7))).body.ignored).toMatch(/no preview/);
  });

  it("ignores pull requests when previews are off, and removes previews with their app", async () => {
    const envId = await project("Previews 2");
    const parentId = (await json(await apps.POST(req("POST", { environmentId: envId, name: "shop", sourceType: "git-compose", gitRepo: "https://github.com/acme/web", gitBranch: "main", previewsEnabled: true, previewDomain: "pv.example.com" })))).body.id;
    const opened = await send(parentId, event("opened", 3));
    expect(opened.body.previewId).toBeTruthy();
    signInAs("admin");
    expect((await appRoute.DELETE(req("DELETE", {}), p({ id: parentId }))).status).toBe(200);
    expect(await prisma.application.count({ where: { previewOfId: parentId } })).toBe(0);

    const plain = (await json(await apps.POST(req("POST", { environmentId: envId, name: "plain", sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/web" })))).body.id;
    expect((await send(plain, event("opened", 4))).body.ignored).toMatch(/previews are off/);
  });
});
