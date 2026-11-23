/**
 * AI connectors: dynamic client registration, the authorization code flow with
 * PKCE, refresh rotation with replay detection, revocation, and the MCP
 * endpoint on top, through the real routes, apiAuth and a real database.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-oauth-"));
  process.env.DATABASE_URL = `file:${d}/oauth.db`;
  return { dir: d as string, headers: new Headers(), session: null as unknown };
});
vi.mock("next/headers", () => ({ headers: async () => h.headers }));
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }));

import { prisma } from "@/lib/prisma";
import { getCurrentUser, requireStepUp } from "@/lib/apiAuth";
import { registerClient, validRedirectUri, redirectAllowed, authenticateClient, OAuthError } from "@/lib/oauth/clients";
import { approve, checkAuthorizeRequest, exchangeCode, pkceChallenge, refreshTokens, resolveAccessToken, revokeGrant, revokeToken, listGrants, resourceMatches } from "@/lib/oauth/server";
import { maxConnectionRole, roleForScope, scopeForRole } from "@/lib/oauth/config";
import * as tokenRoute from "@/app/api/oauth/token/route";
import * as registerRoute from "@/app/api/oauth/register/route";
import * as metadataRoute from "@/app/api/oauth/metadata/route";
import * as resourceRoute from "@/app/api/oauth/resource-metadata/route";
import * as mcpRoute from "@/app/api/mcp/route";
import * as authorizeRoute from "@/app/api/oauth/authorize/route";
import * as connectionsRoute from "@/app/api/account/connections/route";
import { auditArgs, toolsFor } from "@/lib/mcp/tools";

const ISS = "https://localhost:9444";
const RES = `${ISS}/mcp`;
const ctx = { issuer: ISS, mcpResource: RES };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let admin: { id: string; role: string; email: string };
let viewer: { id: string; role: string; email: string };

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  admin = await prisma.user.create({ data: { email: "root@acme.com", name: "Root", password: "x", role: "admin" } });
  viewer = await prisma.user.create({ data: { email: "view@acme.com", name: "View", password: "x", role: "viewer" } });
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(h.dir, { recursive: true, force: true });
});
beforeEach(() => {
  h.headers = new Headers();
  h.session = null;
});

function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

function authorizeParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st8", resource: RES, scope: "read operate", ...extra });
}

async function connect(user: { id: string; role: string }, role = "operator") {
  const { response, row } = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
  const { verifier, challenge } = pkce();
  const check = await checkAuthorizeRequest(authorizeParams(response.client_id, challenge), ctx);
  if (!check.ok) throw new Error("authorize failed");
  const { redirect, grant } = await approve(user, check.req, role, ctx);
  const code = new URL(redirect).searchParams.get("code")!;
  const tokens = await exchangeCode(row, new URLSearchParams({ code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RES }), RES);
  return { client: row, clientId: response.client_id, grant, tokens, redirect };
}

function req(url: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return new Request(url, { ...init, headers: { host: "localhost:9444", ...(init.headers ?? {}) } });
}

describe("client registration", () => {
  it("accepts https, loopback http and app schemes, and nothing else", () => {
    expect(validRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBeTruthy();
    expect(validRedirectUri("http://localhost:6274/oauth/callback")).toBeTruthy();
    expect(validRedirectUri("http://127.0.0.1:33418/callback")).toBeTruthy();
    expect(validRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback")).toBeTruthy();
    expect(validRedirectUri("http://evil.example/cb")).toBeNull();
    expect(validRedirectUri("javascript:alert(1)")).toBeNull();
    expect(validRedirectUri("data:text/html,hi")).toBeNull();
    expect(validRedirectUri("https://x.example/cb#frag")).toBeNull();
    expect(validRedirectUri("not a url")).toBeNull();
  });

  it("lets loopback redirects change port but nothing else", () => {
    const c = { redirectUris: JSON.stringify(["http://127.0.0.1:1234/callback", REDIRECT]) };
    expect(redirectAllowed(c, "http://127.0.0.1:5555/callback")).toBe(true);
    expect(redirectAllowed(c, "http://127.0.0.1:5555/other")).toBe(false);
    expect(redirectAllowed(c, REDIRECT)).toBe(true);
    expect(redirectAllowed(c, REDIRECT + "x")).toBe(false);
  });

  it("registers public and confidential clients and validates metadata", async () => {
    const pub = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    expect(pub.response.client_id).toMatch(/^dnc_/);
    expect(pub.response).not.toHaveProperty("client_secret");
    const conf = await registerClient({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"] });
    expect(conf.response.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(conf.response.client_secret).toMatch(/^dncs_/);
    expect(conf.row.secretHash).not.toContain(conf.response.client_secret);
    await expect(registerClient({ redirect_uris: [] })).rejects.toThrow(/redirect_uris/);
    await expect(registerClient({ redirect_uris: ["http://evil.example/cb"] })).rejects.toThrow(/not allowed/);
    await expect(registerClient({ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] })).rejects.toThrow(/grant_types/);
    await expect(registerClient({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" })).rejects.toThrow(/token_endpoint_auth_method/);
  });

  it("authenticates clients the way they registered", async () => {
    const conf = await registerClient({ client_name: "App", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" });
    const id = conf.response.client_id;
    const secret = conf.response.client_secret!;
    const basic = "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
    expect((await authenticateClient(new Request("https://x", { headers: { authorization: basic } }), new URLSearchParams())).id).toBe(conf.row.id);
    expect((await authenticateClient(new Request("https://x"), new URLSearchParams({ client_id: id, client_secret: secret }))).id).toBe(conf.row.id);
    await expect(authenticateClient(new Request("https://x"), new URLSearchParams({ client_id: id }))).rejects.toThrow(OAuthError);
    await expect(authenticateClient(new Request("https://x"), new URLSearchParams({ client_id: id, client_secret: "dncs_wrong" }))).rejects.toThrow(/failed/);
    await expect(authenticateClient(new Request("https://x"), new URLSearchParams({ client_id: "dnc_" + "x".repeat(24) }))).rejects.toThrow(/Unknown/);
  });

  it("serves RFC 7591 registration over HTTP", async () => {
    const res = await registerRoute.POST(req(`${ISS}/api/oauth/register`, { method: "POST", body: JSON.stringify({ client_name: "Inspector", redirect_uris: ["http://localhost:6274/oauth/callback"], token_endpoint_auth_method: "none" }) }));
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await res.json()).client_id).toMatch(/^dnc_/);
    const bad = await registerRoute.POST(req(`${ISS}/api/oauth/register`, { method: "POST", body: "nope" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_client_metadata");
  });
});

describe("discovery", () => {
  it("publishes authorization server and protected resource metadata", async () => {
    const as = await (await metadataRoute.GET(req(`${ISS}/.well-known/oauth-authorization-server`))).json();
    expect(as).toMatchObject({ issuer: ISS, authorization_endpoint: `${ISS}/oauth/authorize`, token_endpoint: `${ISS}/api/oauth/token`, registration_endpoint: `${ISS}/api/oauth/register`, code_challenge_methods_supported: ["S256"] });
    const pr = await (await resourceRoute.GET(req(`${ISS}/.well-known/oauth-protected-resource/mcp`))).json();
    expect(pr).toMatchObject({ resource: RES, authorization_servers: [ISS], scopes_supported: ["read", "operate", "admin"] });
  });

  it("maps scopes to roles", () => {
    expect(scopeForRole("operator")).toBe("read operate");
    expect(scopeForRole("admin")).toBe("read operate admin");
    expect(roleForScope("read admin")).toBe("admin");
    expect(roleForScope("openid")).toBeNull();
    expect(maxConnectionRole({ role: "owner" })).toBe("admin");
    expect(maxConnectionRole({ role: "viewer", bindings: [{ role: "operator", scopeType: "project", scopeId: "p" }] })).toBe("operator");
    expect(resourceMatches(undefined, RES)).toBe(true);
    expect(resourceMatches(ISS + "/", RES)).toBe(true);
    expect(resourceMatches("https://other.example/mcp", RES)).toBe(false);
  });
});

describe("authorization code flow", () => {
  it("rejects bad requests: unknown client and redirect on our page, the rest back to the app", async () => {
    const { response } = await registerClient({ client_name: "C", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const { challenge } = pkce();
    expect(await checkAuthorizeRequest(authorizeParams("dnc_" + "z".repeat(24), challenge), ctx)).toMatchObject({ ok: false, fatal: expect.any(String) });
    expect(await checkAuthorizeRequest(authorizeParams(response.client_id, challenge, { redirect_uri: "https://evil.example/cb" }), ctx)).toMatchObject({ ok: false, fatal: expect.any(String) });
    const noPkce = await checkAuthorizeRequest(authorizeParams(response.client_id, ""), ctx);
    expect(noPkce.ok).toBe(false);
    const r = new URL((noPkce as { redirect: string }).redirect);
    expect(r.origin + r.pathname).toBe(REDIRECT);
    expect(r.searchParams.get("error")).toBe("invalid_request");
    expect(r.searchParams.get("state")).toBe("st8");
    expect(r.searchParams.get("iss")).toBe(ISS);
    const plain = await checkAuthorizeRequest(authorizeParams(response.client_id, challenge, { code_challenge_method: "plain" }), ctx);
    expect(new URL((plain as { redirect: string }).redirect).searchParams.get("error")).toBe("invalid_request");
    const wrongResource = await checkAuthorizeRequest(authorizeParams(response.client_id, challenge, { resource: "https://other.example/mcp" }), ctx);
    expect(new URL((wrongResource as { redirect: string }).redirect).searchParams.get("error")).toBe("invalid_target");
    const ok = await checkAuthorizeRequest(authorizeParams(response.client_id, challenge), ctx);
    expect(ok).toMatchObject({ ok: true, req: { requestedRole: "operator" } });
  });

  it("won't grant more than the person has", async () => {
    const { response } = await registerClient({ client_name: "C", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const check = await checkAuthorizeRequest(authorizeParams(response.client_id, pkce().challenge), ctx);
    if (!check.ok) throw new Error();
    await expect(approve(viewer, check.req, "operator", ctx)).rejects.toThrow(/more rights/);
    await expect(approve(admin, check.req, "owner", ctx)).rejects.toThrow(/Pick/);
  });

  it("issues tokens for the right verifier only, once", async () => {
    const { response, row } = await registerClient({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const { verifier, challenge } = pkce();
    const check = await checkAuthorizeRequest(authorizeParams(response.client_id, challenge), ctx);
    if (!check.ok) throw new Error();
    const { redirect } = await approve(admin, check.req, "operator", ctx);
    const u = new URL(redirect);
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("iss")).toBe(ISS);
    const code = u.searchParams.get("code")!;

    // Wrong verifier burns the code
    await expect(exchangeCode(row, new URLSearchParams({ code, code_verifier: pkce().verifier, redirect_uri: REDIRECT }), RES)).rejects.toThrow(/PKCE/);
    await expect(exchangeCode(row, new URLSearchParams({ code, code_verifier: verifier, redirect_uri: REDIRECT }), RES)).rejects.toThrow(/already used/);

    // A fresh code, through the HTTP token endpoint
    const c2 = await checkAuthorizeRequest(authorizeParams(response.client_id, challenge), ctx);
    if (!c2.ok) throw new Error();
    const code2 = new URL((await approve(admin, c2.req, "operator", ctx)).redirect).searchParams.get("code")!;
    const res = await tokenRoute.POST(
      req(`${ISS}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: response.client_id, code: code2, code_verifier: verifier, redirect_uri: REDIRECT, resource: RES }).toString() }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = await res.json();
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read operate" });
    expect(tokens.access_token).toMatch(/^dno_/);
    expect(tokens.refresh_token).toMatch(/^dnr_/);

    // Replaying the code ends the tokens it produced
    const replay = await tokenRoute.POST(req(`${ISS}/api/oauth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: response.client_id, code: code2, code_verifier: verifier }).toString() }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect(await resolveAccessToken(tokens.access_token)).toBeNull();
    expect(await prisma.auditEvent.count({ where: { action: "oauth.token_replay" } })).toBe(1);

    // Approving the same app again reuses the connection
    expect((await listGrants(admin.id)).filter((g) => g.name === "Claude").length).toBe(1);
  });

  it("rejects a code at another client or with another redirect", async () => {
    const { client, clientId } = await connect(admin);
    const other = await registerClient({ client_name: "Other", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const { verifier, challenge } = pkce();
    const check = await checkAuthorizeRequest(authorizeParams(clientId, challenge), ctx);
    if (!check.ok) throw new Error();
    const code = new URL((await approve(admin, check.req, "viewer", ctx)).redirect).searchParams.get("code")!;
    await expect(exchangeCode(other.row, new URLSearchParams({ code, code_verifier: verifier }), RES)).rejects.toThrow(/Invalid authorization code/);
    await expect(exchangeCode(client, new URLSearchParams({ code, code_verifier: verifier, redirect_uri: "https://claude.ai/other" }), RES)).rejects.toThrow(/redirect_uri/);
  });
});

describe("consent screen and Account", () => {
  it("approves or declines for the signed-in person, and lists and revokes connections", async () => {
    const s = await prisma.session.create({ data: { userId: admin.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    const { response } = await registerClient({ client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const query = authorizeParams(response.client_id, pkce().challenge).toString();
    const post = (body: unknown) => authorizeRoute.POST(req(`${ISS}/api/oauth/authorize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

    expect((await post({ query, decision: "allow", role: "viewer" })).status).toBe(401);
    h.session = { user: { id: admin.id, sid: s.id } };
    const denied = await (await post({ query, decision: "deny" })).json();
    expect(new URL(denied.redirect).searchParams.get("error")).toBe("access_denied");
    const allowed = await (await post({ query, decision: "allow", role: "admin" })).json();
    expect(new URL(allowed.redirect).searchParams.get("code")).toMatch(/^dnac_/);
    expect((await post({ query: "client_id=nope", decision: "allow", role: "viewer" })).status).toBe(400);

    const list = await (await connectionsRoute.GET(req(`${ISS}/api/account/connections`))).json();
    expect(list.mcpUrl).toBe(RES);
    const conn = list.connections.find((c: { name: string }) => c.name === "ChatGPT");
    expect(conn).toMatchObject({ role: "admin", redirectHost: "claude.ai" });
    expect((await connectionsRoute.DELETE(req(`${ISS}/api/account/connections?id=${conn.id}`, { method: "DELETE" }))).status).toBe(200);
    expect((await connectionsRoute.DELETE(req(`${ISS}/api/account/connections?id=${conn.id}`, { method: "DELETE" }))).status).toBe(404);
    expect(await prisma.auditEvent.count({ where: { action: { in: ["oauth.authorize", "oauth.deny", "oauth.revoke"] } } })).toBe(3);

    // An AI connection can't approve more connections
    const { tokens } = await connect(admin, "admin");
    h.session = null;
    h.headers.set("authorization", `Bearer ${tokens.access_token}`);
    expect((await post({ query, decision: "allow", role: "viewer" })).status).toBe(403);
  });
});

describe("tokens", () => {
  it("act as the person, capped at the connection's role, and can't do step-up actions", async () => {
    const { tokens, grant } = await connect(admin, "viewer");
    h.headers.set("authorization", `Bearer ${tokens.access_token}`);
    const u = await getCurrentUser();
    expect(u).toMatchObject({ id: admin.id, role: "viewer", tokenId: `oauth:${grant.id}`, oauth: { clientName: "Claude", resource: RES } });
    expect(requireStepUp(u!)?.status).toBe(403);
    await prisma.oAuthGrant.update({ where: { id: grant.id }, data: {} });
    expect((await prisma.oAuthGrant.findUnique({ where: { id: grant.id } }))?.lastUsedAt).toBeTruthy();
  });

  it("rotate refresh tokens and end the connection's tokens on replay", async () => {
    const { client, tokens } = await connect(admin);
    const next = await refreshTokens(client, new URLSearchParams({ refresh_token: tokens.refresh_token }), RES);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await resolveAccessToken(next.access_token)).toBeTruthy();
    await expect(refreshTokens(client, new URLSearchParams({ refresh_token: next.refresh_token, scope: "admin" }), RES)).rejects.toThrow(/widen/);
    // The old refresh token comes back: someone copied it
    await expect(refreshTokens(client, new URLSearchParams({ refresh_token: tokens.refresh_token }), RES)).rejects.toThrow(/already used/);
    expect(await resolveAccessToken(next.access_token)).toBeNull();
    await expect(refreshTokens(client, new URLSearchParams({ refresh_token: next.refresh_token }), RES)).rejects.toThrow(/already used/);
  });

  it("revoke the whole family when the same refresh token is redeemed concurrently", async () => {
    const { client, tokens } = await connect(admin);
    const body = () => new URLSearchParams({ refresh_token: tokens.refresh_token });
    const results = await Promise.allSettled([refreshTokens(client, body(), RES), refreshTokens(client, body(), RES), refreshTokens(client, body(), RES)]);
    const won = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ access_token: string; refresh_token: string }>[];
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    for (const w of won) {
      expect(await resolveAccessToken(w.value.access_token)).toBeNull();
      await expect(refreshTokens(client, new URLSearchParams({ refresh_token: w.value.refresh_token }), RES)).rejects.toThrow(/already used/);
    }
  });

  it("are refused for another resource, and revocable by the client and the person", async () => {
    const { client, tokens, grant } = await connect(admin);
    await expect(refreshTokens(client, new URLSearchParams({ refresh_token: tokens.refresh_token }), "https://new.example/mcp")).rejects.toThrow(/only issued/);

    await revokeToken(client, tokens.access_token);
    expect(await resolveAccessToken(tokens.access_token)).toBeNull();
    const fresh = await refreshTokens(client, new URLSearchParams({ refresh_token: tokens.refresh_token }), RES);
    expect(await resolveAccessToken(fresh.access_token)).toBeTruthy();

    expect(await revokeGrant(grant.id, viewer.id)).toBeNull();
    expect(await revokeGrant(grant.id, admin.id)).toBeTruthy();
    expect(await resolveAccessToken(fresh.access_token)).toBeNull();
    await expect(refreshTokens(client, new URLSearchParams({ refresh_token: fresh.refresh_token }), RES)).rejects.toThrow(/revoked|already used/);
    expect((await listGrants(admin.id)).some((g) => g.id === grant.id)).toBe(false);
  });

  it("stop working when the person is disabled", async () => {
    const temp = await prisma.user.create({ data: { email: "temp@acme.com", name: "T", password: "x", role: "operator" } });
    const { tokens } = await connect(temp, "operator");
    expect(await resolveAccessToken(tokens.access_token)).toBeTruthy();
    await prisma.user.update({ where: { id: temp.id }, data: { disabledAt: new Date() } });
    expect(await resolveAccessToken(tokens.access_token)).toBeNull();
  });
});

describe("MCP endpoint", () => {
  async function rpc(token: string | null, body: unknown, headers: Record<string, string> = {}) {
    if (token) h.headers.set("authorization", `Bearer ${token}`);
    const res = await mcpRoute.POST(req(RES, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) }));
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }

  it("asks for OAuth with a pointer to the resource metadata", async () => {
    const r = await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${ISS}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await rpc("dno_" + "x".repeat(43), { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("initializes, lists the tools the connection may use, and runs them through the API", async () => {
    const { tokens } = await connect(admin, "operator");
    const init = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
    expect(init.status).toBe(200);
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "deploynow" }, capabilities: { tools: {} } });
    expect((await rpc(tokens.access_token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const list = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-protocol-version": "2025-06-18" });
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_endpoints", "list_projects", "deploy_app", "container_logs", "run_backup"]));
    expect(names).not.toContain("set_app_env");
    const deploy = list.body.result.tools.find((t: { name: string }) => t.name === "control_container");
    expect(deploy.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });

    const call = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_projects", arguments: {} } });
    expect(call.body.result.isError).toBeUndefined();
    expect(JSON.parse(call.body.result.content[0].text)).toEqual([]);

    const missing = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_app", arguments: { appId: "cnope00000000000000000000" } } });
    expect(missing.body.result).toMatchObject({ isError: true, content: [{ text: "Application not found" }] });

    const denied = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "set_app_env", arguments: { appId: "x", set: [] } } });
    expect(denied.body.result.isError).toBe(true);

    const unknown = await rpc(tokens.access_token, { jsonrpc: "2.0", id: 6, method: "nope" });
    expect(unknown.body.error.code).toBe(-32601);

    const audits = await prisma.auditEvent.findMany({ where: { action: { in: ["mcp.tool_call", "mcp.connect"] }, actorId: admin.id } });
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["mcp.connect", "mcp.tool_call"]));
    expect(audits.find((a) => a.targetId === "list_projects")?.message).toContain("via Claude");
    expect(audits.find((a) => a.targetId === "set_app_env")?.outcome).toBe("failure");
  });

  it("refuses a token issued for another domain, a cookie session, and bad protocol versions", async () => {
    const { tokens } = await connect(admin, "viewer");
    await prisma.oAuthToken.updateMany({ where: { kind: "access" }, data: { resource: "https://old.example/mcp" } });
    expect((await rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const t2 = await connect(admin, "viewer");
    expect((await rpc(t2.tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
    expect((await rpc(t2.tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).body.result).toEqual({});
    expect((await mcpRoute.GET()).status).toBe(405);
  });

  it("filters tools by role and keeps secret values out of the audit log", () => {
    expect(toolsFor({ role: "viewer", bindings: [] }).every((t) => t.minRole === "viewer")).toBe(true);
    expect(toolsFor({ role: "viewer", bindings: [{ role: "admin" }] }).some((t) => t.name === "set_app_env")).toBe(true);
    const logged = auditArgs("set_app_env", { appId: "a", set: [{ key: "DB_PASSWORD", value: "hunter2", secret: true }] });
    expect(logged).toContain("DB_PASSWORD");
    expect(logged).not.toContain("hunter2");
  });
});
