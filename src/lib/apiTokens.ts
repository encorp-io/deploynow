/**
 * Personal API tokens: "dn_" + 32 random bytes (base64url). Only the sha256 is
 * stored. A token acts as its user, capped at the token's scope (a role), so a
 * read-only token can never change anything even if its owner is an admin.
 */
import crypto from "crypto";
import { prisma } from "./prisma";
import { ROLES, isRole, normalizeRole, roleAtLeast, type Role } from "./rbac";

export const TOKEN_PREFIX = "dn_";
const TOKEN_RE = /^dn_[A-Za-z0-9_-]{43}$/;
const TOUCH_MS = 60_000;

export class TokenError extends Error {}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function lowerRole(a: Role, b: Role): Role {
  return roleAtLeast(a, b) ? b : a;
}

export async function createApiToken(user: { id: string; role: string }, input: { name?: unknown; scope?: unknown; expiresInDays?: unknown }) {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 80) throw new TokenError("Give the token a name");
  const scope = String(input.scope ?? "viewer");
  if (!isRole(scope)) throw new TokenError(`Scope must be one of ${ROLES.join(", ")}`);
  if (!roleAtLeast(normalizeRole(user.role), scope)) throw new TokenError("A token can't have more rights than you do");
  let expiresAt: Date | null = null;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== "" && input.expiresInDays !== 0) {
    const days = Number(input.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new TokenError("Expiry must be 1 to 3650 days, or never");
    expiresAt = new Date(Date.now() + days * 86_400_000);
  }
  if ((await prisma.apiToken.count({ where: { userId: user.id, revokedAt: null } })) >= 50) throw new TokenError("You have 50 tokens; revoke some first");
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const row = await prisma.apiToken.create({ data: { userId: user.id, name, scope, expiresAt, prefix: token.slice(0, 10), hash: hashToken(token) } });
  return { token, row };
}

export function serializeToken(t: { id: string; name: string; prefix: string; scope: string; expiresAt: Date | null; lastUsedAt: Date | null; lastUsedIp: string; revokedAt: Date | null; createdAt: Date }) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scope: t.scope,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    lastUsedIp: t.lastUsedIp,
    revoked: !!t.revokedAt,
    expired: !!t.expiresAt && t.expiresAt.getTime() < Date.now(),
    createdAt: t.createdAt,
  };
}

/** The bearer token from an Authorization header, if it looks like one of ours. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m && TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** The token's row with its user, if the token is valid now. */
export async function resolveToken(token: string, ip = "") {
  const row = await prisma.apiToken.findUnique({ where: { hash: hashToken(token) }, include: { user: { include: { roleBindings: true } } } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() < Date.now()) || !row.user || row.user.disabledAt) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_MS) {
    await prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date(), lastUsedIp: ip.slice(0, 64) } }).catch(() => {});
  }
  return row;
}
