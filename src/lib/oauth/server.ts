/**
 * The OAuth 2.1 authorization server behind DeployNow's MCP endpoint:
 * authorization codes with PKCE (S256 only), refresh token rotation with replay
 * detection, RFC 8707 resource binding and RFC 7009 revocation.
 *
 * Tokens are opaque random strings; only their sha256 is stored.
 *   dno_…  access token, 1 hour, only accepted by /mcp
 *   dnr_…  refresh token, 30 days, rotated on every use
 */
import crypto from "crypto";
import type { OAuthClient, OAuthGrant } from "@prisma/client";
import { prisma } from "../prisma";
import { lowerRole } from "../apiTokens";
import { normalizeRole, roleAtLeast } from "../rbac";
import { findClient, OAuthError, redirectAllowed, redirectUris, sha256 } from "./clients";
import { ACCESS_TTL_S, CODE_TTL_S, REFRESH_TTL_S, isConnectionRole, maxConnectionRole, roleForScope, scopeForRole, type ConnectionRole } from "./config";

export const ACCESS_RE = /^dno_[A-Za-z0-9_-]{43}$/;
const REFRESH_RE = /^dnr_[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^dnac_[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_MS = 60_000;

const random = (prefix: string) => prefix + crypto.randomBytes(32).toString("base64url");

/** base64url(sha256(verifier)), RFC 7636 S256. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/** True if the requested resource is this server's MCP endpoint (or the bare origin, which some clients send). */
export function resourceMatches(asked: string | null | undefined, mcpResource: string): boolean {
  if (!asked) return true;
  const norm = (s: string) => s.replace(/\/+$/, "");
  const a = norm(asked);
  return a === norm(mcpResource) || a === norm(new URL(mcpResource).origin);
}

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  requestedRole: ConnectionRole | null;
  scope: string;
}

/**
 * Errors before the redirect URI is trusted are shown on our page (fatal);
 * later ones go back to the client as ?error=…, as RFC 6749 §4.1.2.1 asks.
 */
export type AuthorizeCheck =
  | { ok: true; req: AuthorizeRequest }
  | { ok: false; fatal: string }
  /** An error the app may be told about at its redirect URI (see errorsMayRedirect) */
  | { ok: false; redirect: string; clientId: string; description: string };

/**
 * Anyone can register a client (dynamic registration is open), so an error
 * redirect would let a stranger's "app" use DeployNow as an open redirector.
 * Errors go back to the app only if this person already connected it; otherwise
 * they are shown on our own page.
 */
export async function errorsMayRedirect(userId: string, clientId: string): Promise<boolean> {
  return (await prisma.oAuthGrant.count({ where: { userId, clientId, revokedAt: null } })) > 0;
}

export function errorRedirect(redirectUri: string, error: string, description: string, state: string, issuer: string): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return u.toString();
}

export async function checkAuthorizeRequest(params: URLSearchParams, ctx: { issuer: string; mcpResource: string }): Promise<AuthorizeCheck> {
  const client = await findClient(params.get("client_id"));
  if (!client) return { ok: false, fatal: "This app isn't registered with DeployNow. Remove the connector and add it again." };
  const list = redirectUris(client);
  const redirectUri = params.get("redirect_uri") ?? (list.length === 1 ? list[0] : "");
  if (!redirectUri || !redirectAllowed(client, redirectUri)) return { ok: false, fatal: "The app sent a return address it didn't register, so DeployNow won't send it anything." };
  const state = (params.get("state") ?? "").slice(0, 1000);
  const fail = (error: string, d: string): AuthorizeCheck => ({ ok: false, redirect: errorRedirect(redirectUri, error, d, state, ctx.issuer), clientId: client.id, description: d });

  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
  const challenge = params.get("code_challenge") ?? "";
  if (!challenge) return fail("invalid_request", "PKCE is required: send code_challenge with code_challenge_method=S256");
  if ((params.get("code_challenge_method") ?? "plain") !== "S256" || !CHALLENGE_RE.test(challenge)) return fail("invalid_request", "code_challenge_method must be S256");
  if (!resourceMatches(params.get("resource"), ctx.mcpResource)) return fail("invalid_target", `This server only issues tokens for ${ctx.mcpResource}`);
  const scope = params.get("scope") ?? "";
  return { ok: true, req: { client, redirectUri, state, codeChallenge: challenge, requestedRole: roleForScope(scope), scope } };
}

/** The person approved: record the grant and hand back the redirect with a one-time code. */
export async function approve(user: { id: string; role: string; bindings?: { role: string; scopeType: string; scopeId: string }[] }, req: AuthorizeRequest, role: string, ctx: { issuer: string; mcpResource: string }) {
  if (!isConnectionRole(role)) throw new OAuthError("invalid_scope", "Pick read only, operate or admin");
  if (!roleAtLeast(maxConnectionRole(user), role)) throw new OAuthError("invalid_scope", "A connection can't have more rights than you do", 403);
  // One grant per person and app: approving again updates it
  const existing = await prisma.oAuthGrant.findFirst({ where: { userId: user.id, clientId: req.client.id, revokedAt: null } });
  const grant = existing
    ? await prisma.oAuthGrant.update({ where: { id: existing.id }, data: { role } })
    : await prisma.oAuthGrant.create({ data: { userId: user.id, clientId: req.client.id, role } });
  const code = random("dnac_");
  await prisma.oAuthCode.create({
    data: { hash: sha256(code), grantId: grant.id, redirectUri: req.redirectUri, codeChallenge: req.codeChallenge, resource: ctx.mcpResource, expiresAt: new Date(Date.now() + CODE_TTL_S * 1000) },
  });
  const u = new URL(req.redirectUri);
  u.searchParams.set("code", code);
  if (req.state) u.searchParams.set("state", req.state);
  u.searchParams.set("iss", ctx.issuer);
  return { grant, redirect: u.toString(), created: !existing };
}

/** Written into a claimed code or refresh token's expiresAt when a second request tried to use it. */
const REPLAYED = new Date(0);

interface OneTime {
  /** Mark it used; count 1 means this request won */
  claim(): Promise<{ count: number }>;
  /** A losing request flags the credential, so a winner still issuing sees it */
  flag(): Promise<unknown>;
  flagged(): Promise<boolean>;
}

/**
 * Redeem a one-time credential (code or refresh token) for a new token pair.
 *
 * Two requests can race on the same credential. Exactly one wins the claim. The
 * loser flags the credential, then revokes the grant's tokens. The winner checks
 * the flag after writing its tokens: if the loser flagged first, the winner
 * revokes everything itself; if not, the winner's tokens already exist when the
 * loser revokes. Either way no token from a replayed credential survives.
 */
async function redeem(grant: OAuthGrant, resource: string, once: OneTime) {
  if ((await once.claim()).count !== 1) {
    await once.flag();
    await revokeGrantTokens(grant.id);
    throw new OAuthError("invalid_grant", "Credential already used; the connection's tokens were revoked. Sign in again.");
  }
  const access = random("dno_");
  const refresh = random("dnr_");
  const now = Date.now();
  await prisma.$transaction([
    prisma.oAuthToken.create({ data: { hash: sha256(access), kind: "access", grantId: grant.id, resource, expiresAt: new Date(now + ACCESS_TTL_S * 1000) } }),
    prisma.oAuthToken.create({ data: { hash: sha256(refresh), kind: "refresh", grantId: grant.id, resource, expiresAt: new Date(now + REFRESH_TTL_S * 1000) } }),
    // Housekeeping: drop this grant's tokens that ran out more than a day ago
    prisma.oAuthToken.deleteMany({ where: { grantId: grant.id, expiresAt: { lt: new Date(now - 86_400_000), gt: REPLAYED } } }),
  ]);
  if (await once.flagged()) {
    await revokeGrantTokens(grant.id);
    throw new OAuthError("invalid_grant", "Credential already used; the connection's tokens were revoked. Sign in again.");
  }
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopeForRole(grant.role) };
}

/** End every token of a grant (code reuse, refresh replay, or the person revoking it). */
async function revokeGrantTokens(grantId: string) {
  await prisma.oAuthToken.updateMany({ where: { grantId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function exchangeCode(client: OAuthClient, body: URLSearchParams, mcpResource: string) {
  const code = body.get("code") ?? "";
  if (!CODE_RE.test(code)) throw new OAuthError("invalid_grant", "Invalid authorization code");
  const row = await prisma.oAuthCode.findUnique({ where: { hash: sha256(code) }, include: { grant: true } });
  if (!row || row.grant.clientId !== client.id) throw new OAuthError("invalid_grant", "Invalid authorization code");
  if (row.usedAt) {
    // A code used twice may have been stolen: end what the first use issued (RFC 6749 §4.1.2)
    await revokeGrantTokens(row.grantId);
    throw new OAuthError("invalid_grant", "Authorization code already used");
  }
  // Any failed attempt burns the code, so a wrong verifier can't be retried
  const burn = async (err: OAuthError) => {
    await prisma.oAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    return err;
  };
  if (row.expiresAt.getTime() < Date.now()) throw await burn(new OAuthError("invalid_grant", "Authorization code expired"));
  if (row.grant.revokedAt) throw await burn(new OAuthError("invalid_grant", "This connection was revoked"));
  if ((body.get("redirect_uri") ?? row.redirectUri) !== row.redirectUri) throw await burn(new OAuthError("invalid_grant", "redirect_uri does not match the authorization request"));
  const verifier = body.get("code_verifier") ?? "";
  if (!VERIFIER_RE.test(verifier) || pkceChallenge(verifier) !== row.codeChallenge) throw await burn(new OAuthError("invalid_grant", "PKCE verification failed"));
  if (!resourceMatches(body.get("resource"), mcpResource) || row.resource !== mcpResource) throw await burn(new OAuthError("invalid_target", `Tokens are only issued for ${mcpResource}`));
  await prisma.oAuthCode.deleteMany({ where: { grantId: row.grantId, expiresAt: { lt: new Date(Date.now() - 3_600_000) } } }).catch(() => {});
  return redeem(row.grant, mcpResource, {
    claim: () => prisma.oAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } }),
    flag: () => prisma.oAuthCode.update({ where: { id: row.id }, data: { expiresAt: REPLAYED } }),
    flagged: async () => (await prisma.oAuthCode.findUnique({ where: { id: row.id } }))?.expiresAt.getTime() === 0,
  });
}

export async function refreshTokens(client: OAuthClient, body: URLSearchParams, mcpResource: string) {
  const token = body.get("refresh_token") ?? "";
  if (!REFRESH_RE.test(token)) throw new OAuthError("invalid_grant", "Invalid refresh token");
  const row = await prisma.oAuthToken.findUnique({ where: { hash: sha256(token) }, include: { grant: { include: { user: true } } } });
  if (!row || row.kind !== "refresh" || row.grant.clientId !== client.id) throw new OAuthError("invalid_grant", "Invalid refresh token");
  if (row.revokedAt) {
    // A rotated-out refresh token came back: someone copied it. End the connection's tokens.
    await revokeGrantTokens(row.grantId);
    throw new OAuthError("invalid_grant", "Refresh token already used; sign in again");
  }
  if (row.expiresAt.getTime() < Date.now()) throw new OAuthError("invalid_grant", "Refresh token expired; sign in again");
  if (row.grant.revokedAt || row.grant.user.disabledAt) throw new OAuthError("invalid_grant", "This connection was revoked");
  if (!resourceMatches(body.get("resource"), mcpResource) || row.resource !== mcpResource) throw new OAuthError("invalid_target", `Tokens are only issued for ${mcpResource}`);
  const asked = body.get("scope");
  if (asked) {
    const r = roleForScope(asked);
    if (!r || !roleAtLeast(normalizeRole(row.grant.role), r)) throw new OAuthError("invalid_scope", "A refresh can't widen the connection's access");
  }
  return redeem(row.grant, mcpResource, {
    claim: () => prisma.oAuthToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    flag: () => prisma.oAuthToken.update({ where: { id: row.id }, data: { expiresAt: REPLAYED } }),
    flagged: async () => (await prisma.oAuthToken.findUnique({ where: { id: row.id } }))?.expiresAt.getTime() === 0,
  });
}

/** RFC 7009: revoke a token the client holds. Unknown tokens are not an error. */
export async function revokeToken(client: OAuthClient, token: string) {
  if (!ACCESS_RE.test(token) && !REFRESH_RE.test(token)) return;
  const row = await prisma.oAuthToken.findUnique({ where: { hash: sha256(token) }, include: { grant: true } });
  if (!row || row.grant.clientId !== client.id) return;
  if (row.kind === "refresh") await revokeGrantTokens(row.grantId);
  else await prisma.oAuthToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
}

/** The connection behind an access token, if it is valid now. */
export async function resolveAccessToken(token: string, ip = "") {
  if (!ACCESS_RE.test(token)) return null;
  const row = await prisma.oAuthToken.findUnique({
    where: { hash: sha256(token) },
    include: { grant: { include: { client: true, user: { include: { roleBindings: true } } } } },
  });
  if (!row || row.kind !== "access" || row.revokedAt || row.expiresAt.getTime() < Date.now()) return null;
  const { grant } = row;
  if (grant.revokedAt || grant.user.disabledAt) return null;
  if (!grant.lastUsedAt || Date.now() - grant.lastUsedAt.getTime() > TOUCH_MS) {
    await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip.slice(0, 64) } }).catch(() => {});
  }
  return { resource: row.resource, grant, client: grant.client, user: grant.user, role: lowerRole(normalizeRole(grant.user.role), normalizeRole(grant.role)) };
}

/** A person's connected apps, for Account. */
export async function listGrants(userId: string) {
  const rows = await prisma.oAuthGrant.findMany({ where: { userId, revokedAt: null }, include: { client: true }, orderBy: { createdAt: "desc" } });
  return rows.map((g) => {
    let redirectHost = "";
    try {
      redirectHost = new URL(redirectUris(g.client)[0]).host;
    } catch {
      /* none */
    }
    return { id: g.id, name: g.client.name, clientUri: g.client.clientUri, redirectHost, role: g.role, scope: scopeForRole(g.role), createdAt: g.createdAt, lastUsedAt: g.lastUsedAt, lastUsedIp: g.lastUsedIp };
  });
}

/** Revoke one of a person's connections: its tokens stop working at once. */
export async function revokeGrant(id: string, userId: string) {
  const g = await prisma.oAuthGrant.findFirst({ where: { id, userId, revokedAt: null }, include: { client: true } });
  if (!g) return null;
  await prisma.oAuthGrant.update({ where: { id }, data: { revokedAt: new Date() } });
  await revokeGrantTokens(id);
  return g;
}
