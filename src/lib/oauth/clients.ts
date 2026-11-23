/**
 * OAuth Dynamic Client Registration (RFC 7591), as MCP clients such as Claude
 * and ChatGPT use it: the client registers itself with no credentials, then a
 * person approves it on the consent screen. Registration alone grants nothing.
 */
import crypto from "crypto";
import type { OAuthClient } from "@prisma/client";
import { prisma } from "../prisma";

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

const MAX_REDIRECTS = 10;
const REGISTRATIONS_PER_HOUR = 30;
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * A redirect URI we'll send codes to: https anywhere, http only to this machine
 * (Claude Code, MCP Inspector), or an app's own scheme (cursor://, vscode://).
 */
export function validRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hash || u.username || u.password) return null;
  if (u.protocol === "https:") return raw;
  if (u.protocol === "http:") return isLoopback(u.hostname) ? raw : null;
  if (BLOCKED_SCHEMES.has(u.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(u.protocol)) return null;
  return raw;
}

/** The redirect URIs of a client, from its stored JSON. */
export function redirectUris(client: Pick<OAuthClient, "redirectUris">): string[] {
  try {
    const v = JSON.parse(client.redirectUris);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Loopback redirects may use any port (RFC 8252 §7.3): native apps pick a free
 * one at sign-in time. Everything else must match exactly.
 */
export function redirectAllowed(client: Pick<OAuthClient, "redirectUris">, uri: string): boolean {
  const list = redirectUris(client);
  if (list.includes(uri)) return true;
  let asked: URL;
  try {
    asked = new URL(uri);
  } catch {
    return false;
  }
  if (asked.protocol !== "http:" || !isLoopback(asked.hostname)) return false;
  return list.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === asked.hostname && u.pathname === asked.pathname && u.search === asked.search;
    } catch {
      return false;
    }
  });
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Register a client. Returns the RFC 7591 response, with the secret once if there is one. */
export async function registerClient(meta: Record<string, unknown>, ip = "") {
  const uris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris : [];
  if (!uris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required");
  if (uris.length > MAX_REDIRECTS) throw new OAuthError("invalid_redirect_uri", `At most ${MAX_REDIRECTS} redirect URIs`);
  const clean: string[] = [];
  for (const u of uris) {
    const ok = validRedirectUri(u);
    if (!ok) throw new OAuthError("invalid_redirect_uri", `Redirect URI not allowed: ${String(u).slice(0, 200)}. Use https, http://localhost, or an app scheme.`);
    if (!clean.includes(ok)) clean.push(ok);
  }

  const grantTypes = Array.isArray(meta.grant_types) ? meta.grant_types.map(String) : ["authorization_code", "refresh_token"];
  if (!grantTypes.includes("authorization_code") || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new OAuthError("invalid_client_metadata", "grant_types may only be authorization_code and refresh_token");
  }
  const responseTypes = Array.isArray(meta.response_types) ? meta.response_types.map(String) : ["code"];
  if (responseTypes.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "response_types may only be code");

  // RFC 7591 says a client that names no method gets client_secret_basic
  const method = (meta.token_endpoint_auth_method ?? "client_secret_basic") as AuthMethod;
  if (!AUTH_METHODS.includes(method)) throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`);

  const since = new Date(Date.now() - 3_600_000);
  if (ip && (await prisma.oAuthClient.count({ where: { registeredIp: ip, createdAt: { gt: since } } })) >= REGISTRATIONS_PER_HOUR) {
    throw new OAuthError("too_many_requests", "Too many registrations from this address; try again later", 429);
  }
  // Clients nobody approved within a day are clutter: clear them out
  await prisma.oAuthClient.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 86_400_000) }, grants: { none: {} } } }).catch(() => {});

  const clientId = "dnc_" + crypto.randomBytes(18).toString("base64url");
  const secret = method === "none" ? null : "dncs_" + crypto.randomBytes(32).toString("base64url");
  const row = await prisma.oAuthClient.create({
    data: {
      clientId,
      secretHash: secret ? sha256(secret) : "",
      name: text(meta.client_name, 100) || "Unnamed app",
      redirectUris: JSON.stringify(clean),
      tokenAuthMethod: method,
      clientUri: validRedirectUri(meta.client_uri)?.startsWith("https://") ? String(meta.client_uri) : "",
      softwareId: text(meta.software_id, 200),
      registeredIp: ip.slice(0, 64),
    },
  });
  return {
    row,
    response: {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      client_name: row.name,
      redirect_uris: clean,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: method,
      ...(row.clientUri ? { client_uri: row.clientUri } : {}),
      ...(row.softwareId ? { software_id: row.softwareId } : {}),
    },
  };
}

export async function findClient(clientId: unknown): Promise<OAuthClient | null> {
  if (typeof clientId !== "string" || !/^dnc_[A-Za-z0-9_-]{24}$/.test(clientId)) return null;
  return prisma.oAuthClient.findUnique({ where: { clientId } });
}

/**
 * The client calling the token or revocation endpoint, checked the way it
 * registered: a secret in the Basic header, a secret in the body, or none.
 */
export async function authenticateClient(request: Request, body: URLSearchParams): Promise<OAuthClient> {
  let id = body.get("client_id") ?? "";
  let secret = body.get("client_secret") ?? "";
  let via: AuthMethod = secret ? "client_secret_post" : "none";
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i < 0) throw new OAuthError("invalid_client", "Malformed Basic credentials", 401);
    const bid = decodeURIComponent(decoded.slice(0, i));
    if (id && id !== bid) throw new OAuthError("invalid_client", "client_id does not match the credentials", 401);
    id = bid;
    secret = decodeURIComponent(decoded.slice(i + 1));
    via = "client_secret_basic";
  }
  const client = await findClient(id);
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  if (client.tokenAuthMethod === "none") {
    if (via !== "none") throw new OAuthError("invalid_client", "This client registered without a secret", 401);
    return client;
  }
  // Accept either secret method: clients often register one and send the other
  if (via === "none" || !safeEqualHex(sha256(secret), client.secretHash)) throw new OAuthError("invalid_client", "Client authentication failed", 401);
  return client;
}
