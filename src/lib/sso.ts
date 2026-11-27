/**
 * Single sign-on with Google, Microsoft (Entra ID) or any OpenID Connect provider.
 *
 * Authorization code flow with PKCE, state and nonce. The ID token is verified
 * against the provider's published keys. A successful sign-in ends in a
 * one-time login ticket that the login page exchanges for a normal DeployNow
 * session (see the "ticket" provider in auth.ts), so sessions, roles, 2FA and
 * the audit log work the same as for passwords.
 */
import crypto from "crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { SsoProvider, User } from "@prisma/client";
import { prisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./secretsCrypto";
import { hashPassword } from "./password";
import { BINDABLE_ROLES, normalizeRole } from "./rbac";

export const SSO_TYPES = ["google", "microsoft", "oidc"] as const;
const FLOW_TTL_MS = 10 * 60_000;
export const TICKET_TTL_MS = 2 * 60_000;
const MS_MULTI_TENANT = ["common", "organizations", "consumers"];

export class SsoError extends Error {}

export function issuerFor(p: Pick<SsoProvider, "type" | "tenant" | "issuer">): string {
  if (p.type === "google") return "https://accounts.google.com";
  if (p.type === "microsoft") return `https://login.microsoftonline.com/${p.tenant || "organizations"}/v2.0`;
  return p.issuer.replace(/\/+$/, "");
}

export function validateProvider(raw: Record<string, unknown>, existing?: SsoProvider) {
  const type = String(raw.type ?? existing?.type ?? "");
  if (!(SSO_TYPES as readonly string[]).includes(type)) throw new SsoError("Type must be google, microsoft or oidc");
  const name = String(raw.name ?? existing?.name ?? (type === "google" ? "Google" : type === "microsoft" ? "Microsoft" : "")).trim();
  if (!name || name.length > 60) throw new SsoError("Give the provider a name");
  const clientId = String(raw.clientId ?? existing?.clientId ?? "").trim();
  if (!clientId || clientId.length > 300) throw new SsoError("Enter the client id");
  const secret = typeof raw.clientSecret === "string" && raw.clientSecret && raw.clientSecret !== "••••••••" ? raw.clientSecret.trim() : null;
  if (!secret && !existing) throw new SsoError("Enter the client secret");
  const tenant = type === "microsoft" ? String(raw.tenant ?? existing?.tenant ?? "organizations").trim() : "";
  if (type === "microsoft" && !/^[a-zA-Z0-9.-]{2,100}$/.test(tenant)) throw new SsoError("Enter the tenant id or domain (or organizations)");
  let issuer = "";
  if (type === "oidc") {
    issuer = String(raw.issuer ?? existing?.issuer ?? "").trim().replace(/\/+$/, "");
    try {
      if (new URL(issuer).protocol !== "https:") throw new Error();
    } catch {
      throw new SsoError("The issuer must be an https URL");
    }
  }
  const allowedDomains = String(raw.allowedDomains ?? existing?.allowedDomains ?? "")
    .split(/[,\s]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  for (const d of allowedDomains) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new SsoError(`Invalid domain: ${d}`);
  const autoCreate = raw.autoCreate !== undefined ? Boolean(raw.autoCreate) : (existing?.autoCreate ?? false);
  if (autoCreate && allowedDomains.length === 0) throw new SsoError("Creating users on first sign-in needs at least one allowed email domain");
  const defaultRole = String(raw.defaultRole ?? existing?.defaultRole ?? "viewer");
  if (!(BINDABLE_ROLES as readonly string[]).includes(defaultRole)) throw new SsoError("New users get viewer, operator or admin");
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : (existing?.enabled ?? true);
  return { type, name, clientId, ...(secret ? { clientSecret: encryptSecret(secret) } : {}), tenant, issuer, allowedDomains: allowedDomains.join(","), autoCreate, defaultRole, enabled };
}

export function serializeProvider(p: SsoProvider) {
  return {
    id: p.id,
    type: p.type,
    name: p.name,
    clientId: p.clientId,
    clientSecret: p.clientSecret ? "••••••••" : "",
    tenant: p.tenant,
    issuer: p.issuer,
    allowedDomains: p.allowedDomains ? p.allowedDomains.split(",") : [],
    autoCreate: p.autoCreate,
    defaultRole: p.defaultRole,
    enabled: p.enabled,
  };
}

// ─── Discovery ─────────────────────────────────────────────────────────────────

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new SsoError(`The provider's discovery document answered ${res.status}`);
  const doc = (await res.json()) as Discovery;
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[k] !== "string" || !doc[k].startsWith("https://")) throw new SsoError(`The provider's ${k} is missing or not https`);
  }
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

function jwks(uri: string) {
  let set = jwksCache.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, set);
  }
  return set;
}

// ─── The flow ──────────────────────────────────────────────────────────────────

const b64url = (b: Buffer) => b.toString("base64url");

export function callbackUrl(origin: string) {
  return `${origin}/api/sso/callback`;
}

/** Start a sign-in: returns the URL to send the browser to. */
export async function startLogin(provider: SsoProvider, origin: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const doc = await discover(issuerFor(provider), fetchImpl);
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  await prisma.authChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await prisma.authChallenge.create({
    data: { id: `oidc:${state}`, kind: "oidc", data: JSON.stringify({ providerId: provider.id, nonce, verifier, origin }), expiresAt: new Date(Date.now() + FLOW_TTL_MS) },
  });
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(origin));
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export interface Claims extends JWTPayload {
  email?: string;
  email_verified?: boolean | string;
  preferred_username?: string;
  name?: string;
  tid?: string;
  nonce?: string;
  /** Microsoft optional claim: the email's domain is verified by the tenant that issued the token */
  xms_edov?: boolean | string | number;
}

/** A Microsoft provider that accepts accounts from any tenant, not just the admin's own. */
export function isMultiTenant(provider: Pick<SsoProvider, "type" | "tenant">): boolean {
  return provider.type === "microsoft" && MS_MULTI_TENANT.includes(provider.tenant.toLowerCase());
}

/** Verify an ID token from the provider. */
export type KeySource = Parameters<typeof jwtVerify>[1];

export async function verifyIdToken(provider: SsoProvider, idToken: string, nonce: string, keys?: KeySource): Promise<Claims> {
  const doc = await discover(issuerFor(provider));
  const { payload } = await jwtVerify<Claims>(idToken, (keys as never) ?? jwks(doc.jwks_uri), { audience: provider.clientId, clockTolerance: 60 });
  // Microsoft's multi-tenant issuer is a template: https://login.microsoftonline.com/{tenantid}/v2.0
  const expectedIssuer = doc.issuer.includes("{tenantid}") ? doc.issuer.replace("{tenantid}", String(payload.tid ?? "")) : doc.issuer;
  if (payload.iss !== expectedIssuer) throw new SsoError("The ID token's issuer doesn't match the provider");
  if (provider.type === "microsoft" && /^[0-9a-f-]{36}$/i.test(provider.tenant) && payload.tid?.toLowerCase() !== provider.tenant.toLowerCase()) {
    throw new SsoError("That account belongs to another Microsoft tenant");
  }
  if (payload.nonce !== nonce) throw new SsoError("The sign-in response doesn't match this browser (nonce)");
  if (!payload.sub) throw new SsoError("The ID token has no subject");
  return payload;
}

/** The email the provider vouches for, or "" if it can't be trusted to match accounts. */
export function trustedEmail(provider: SsoProvider, claims: Claims): string {
  const multi = isMultiTenant(provider);
  // preferred_username is a display hint that any tenant admin can set; only a
  // single tenant (ours) is trusted to vouch for it.
  const raw = claims.email ?? (provider.type === "microsoft" && !multi ? (claims.preferred_username ?? "") : "");
  const email = String(raw).toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "";
  if (provider.type === "microsoft") {
    // Entra ID doesn't send email_verified. In a single tenant the tenant is ours and owns
    // the address. With "common" or "organizations" any tenant can sign in, and its admin
    // can put any address (owner@yourcompany.com) on an account ("nOAuth"). So there the
    // address is trusted only when Microsoft says the issuing tenant verified the
    // domain (the xms_edov optional claim, which has to be added to the app registration).
    if (!multi) return email;
    return [true, "true", 1, "1"].includes(claims.xms_edov as never) ? email : "";
  }
  return claims.email_verified === true || claims.email_verified === "true" ? email : "";
}

/** Find, link or create the DeployNow user for these claims. */
export async function resolveUser(provider: SsoProvider, claims: Claims): Promise<User> {
  const email = trustedEmail(provider, claims);
  const allowed = provider.allowedDomains ? provider.allowedDomains.split(",") : [];
  const linked = await prisma.userIdentity.findUnique({ where: { providerId_subject: { providerId: provider.id, subject: String(claims.sub) } }, include: { user: true } });
  // A multi-tenant Microsoft token without xms_edov has no address we can check against
  // the allowed domains. An identity linked earlier is still matched by its subject,
  // so it keeps signing in; anything new needs the verified address.
  const linkedWithoutEmail = !!linked && !email && isMultiTenant(provider);
  if (allowed.length && !linkedWithoutEmail && (!email || !allowed.includes(email.split("@")[1]))) {
    throw new SsoError(`Sign-in with ${provider.name} is limited to ${allowed.map((d) => "@" + d).join(", ")} addresses`);
  }
  if (linked) {
    await prisma.userIdentity.update({ where: { id: linked.id }, data: { lastUsedAt: new Date(), ...(email ? { email } : {}) } });
    return linked.user;
  }
  if (!email) {
    if (isMultiTenant(provider)) {
      throw new SsoError(`${provider.name} didn't confirm that this account's organization owns its email address. Ask an admin to add the email and xms_edov optional claims to the app registration, or to use a single tenant.`);
    }
    throw new SsoError(`${provider.name} didn't confirm an email address for this account`);
  }
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    if (!provider.autoCreate) throw new SsoError(`There is no DeployNow account for ${email}. Ask an admin to invite you.`);
    const role = normalizeRole(provider.defaultRole);
    user = await prisma.user.create({
      data: {
        email,
        name: String(claims.name ?? email.split("@")[0]).slice(0, 100),
        role: role === "owner" ? "admin" : role,
        // A random password nobody knows: this account signs in with SSO (or a reset)
        password: await hashPassword(crypto.randomBytes(32).toString("base64url")),
      },
    });
  }
  await prisma.userIdentity.create({ data: { providerId: provider.id, subject: String(claims.sub), userId: user.id, email, lastUsedAt: new Date() } });
  return user;
}

/** Exchange the code for tokens and verify the ID token. Returns the user and where to go next. */
export async function finishLogin(params: { state: string; code: string }, fetchImpl: typeof fetch = fetch, keys?: KeySource) {
  const flow = await prisma.authChallenge.findUnique({ where: { id: `oidc:${params.state}` } });
  if (flow) await prisma.authChallenge.delete({ where: { id: flow.id } }).catch(() => {});
  if (!flow || flow.kind !== "oidc" || flow.expiresAt.getTime() < Date.now()) throw new SsoError("The sign-in expired or was already used; try again");
  const { providerId, nonce, verifier, origin } = JSON.parse(flow.data) as { providerId: string; nonce: string; verifier: string; origin: string };
  const provider = await prisma.ssoProvider.findUnique({ where: { id: providerId } });
  if (!provider || !provider.enabled) throw new SsoError("This sign-in provider is no longer available");
  const doc = await discover(issuerFor(provider), fetchImpl);
  const secret = decryptSecret(provider.clientSecret);
  if (!secret) throw new SsoError("The provider's client secret can't be decrypted");
  const res = await fetchImpl(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: params.code, redirect_uri: callbackUrl(origin), client_id: provider.clientId, client_secret: secret, code_verifier: verifier }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.id_token) throw new SsoError(`${provider.name} refused the sign-in: ${body.error_description || body.error || res.status}`);
  const claims = await verifyIdToken(provider, body.id_token, nonce, keys);
  const user = await resolveUser(provider, claims);
  if (user.disabledAt) throw new SsoError("This account is disabled");
  return { user, provider, origin };
}

// ─── Login tickets ─────────────────────────────────────────────────────────────

export function ticketHash(ticket: string) {
  return "ticket:" + crypto.createHash("sha256").update(ticket).digest("hex");
}

/** A one-time ticket the login page turns into a session. `method` is "sso" or "passkey". */
export async function createTicket(userId: string, method: "sso" | "passkey", detail = ""): Promise<string> {
  const ticket = b64url(crypto.randomBytes(32));
  await prisma.authChallenge.create({ data: { id: ticketHash(ticket), kind: "ticket", userId, data: JSON.stringify({ method, detail }), expiresAt: new Date(Date.now() + TICKET_TTL_MS) } });
  return ticket;
}

export async function peekTicket(ticket: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const row = await prisma.authChallenge.findUnique({ where: { id: ticketHash(ticket) } });
  if (!row || row.kind !== "ticket" || row.expiresAt.getTime() < Date.now()) return null;
  return { userId: row.userId, ...(JSON.parse(row.data) as { method: "sso" | "passkey"; detail: string }) };
}

export async function consumeTicket(ticket: string): Promise<boolean> {
  const res = await prisma.authChallenge.deleteMany({ where: { id: ticketHash(ticket), kind: "ticket", expiresAt: { gte: new Date() } } });
  return res.count === 1;
}
