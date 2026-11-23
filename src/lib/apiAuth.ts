/**
 * Authorisation for API route handlers.
 *
 *   const gate = await requireUser("container.control", { endpointId });
 *   if (!gate.ok) return gate.response;
 *   const { user } = gate;
 */
import { NextResponse } from "next/server";
import { auth } from "./auth";
import { prisma } from "./prisma";
import { can, normalizeRole, type Binding, type Permission, type Role } from "./rbac";
import { hasRecentStepUp } from "./sessions";
import { bearerToken, lowerRole, resolveToken } from "./apiTokens";
import { ACCESS_RE, resolveAccessToken } from "./oauth/server";

/** The OAuth access token from an Authorization header, if it looks like one. */
export function oauthBearer(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim());
  return m && ACCESS_RE.test(m[1]) ? m[1] : null;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sid: string;
  bindings: Binding[];
  totpEnabled: boolean;
  stepUpAt: Date | null;
  /** Set when the request is authenticated with an API token or an OAuth connection rather than a session */
  tokenId?: string;
  /** Set for an OAuth connection (an AI app through /mcp): its grant and app name */
  oauth?: { grantId: string; clientName: string; resource: string };
}

async function headerValue(name: string): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get(name);
  } catch {
    return null; // outside a request (tests, scripts)
  }
}

/** A request with "Authorization: Bearer dn_…" or an OAuth access token "dno_…": its user, capped at the token's scope. */
async function tokenUser(): Promise<CurrentUser | null | undefined> {
  const header = await headerValue("authorization");
  const fwd = (await headerValue("x-real-ip"))?.trim() || (await headerValue("x-forwarded-for"))?.split(",")[0]?.trim() || "";
  const oauth = oauthBearer(header);
  if (oauth) {
    const c = await resolveAccessToken(oauth, fwd);
    if (!c) return null;
    const cap = normalizeRole(c.grant.role);
    return {
      id: c.user.id,
      email: c.user.email,
      name: c.user.name,
      role: c.role,
      sid: `oauth:${c.grant.id}`,
      bindings: c.user.roleBindings.map((b) => ({ role: lowerRole(normalizeRole(b.role), cap), scopeType: b.scopeType, scopeId: b.scopeId })),
      totpEnabled: !!c.user.totpEnabledAt,
      stepUpAt: null,
      tokenId: `oauth:${c.grant.id}`,
      oauth: { grantId: c.grant.id, clientName: c.client.name, resource: c.resource },
    };
  }
  const token = bearerToken(header);
  if (!token) return undefined;
  const row = await resolveToken(token, fwd);
  if (!row) return null;
  const cap = normalizeRole(row.scope);
  return {
    id: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: lowerRole(normalizeRole(row.user.role), cap),
    sid: `token:${row.id}`,
    bindings: row.user.roleBindings.map((b) => ({ role: lowerRole(normalizeRole(b.role), cap), scopeType: b.scopeType, scopeId: b.scopeId })),
    totpEnabled: !!row.user.totpEnabledAt,
    stepUpAt: null,
    tokenId: row.id,
  };
}

type Gate = { ok: true; user: CurrentUser } | { ok: false; response: NextResponse };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const viaToken = await tokenUser();
  if (viaToken !== undefined) return viaToken;
  const session = await auth();
  const u = session?.user as Record<string, unknown> | undefined;
  if (!u?.id || !u?.sid) return null;
  const [user, s] = await Promise.all([
    prisma.user.findUnique({ where: { id: u.id as string }, include: { roleBindings: true } }),
    prisma.session.findUnique({ where: { id: u.sid as string } }),
  ]);
  if (!user || user.disabledAt || !s || s.revokedAt) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: normalizeRole(user.role),
    sid: s.id,
    bindings: user.roleBindings.map((b) => ({ role: b.role, scopeType: b.scopeType, scopeId: b.scopeId })),
    totpEnabled: !!user.totpEnabledAt,
    stepUpAt: s.stepUpAt,
  };
}

export async function requireUser(
  permission?: Permission,
  scope?: { endpointId?: string; projectId?: string },
): Promise<Gate> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (permission && !can(user, permission, scope)) {
    return { ok: false, response: NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 }) };
  }
  return { ok: true, user };
}

/**
 * Sensitive actions need a 2FA code confirmed in the last 10 minutes.
 * Users without 2FA are let through (the admin enrolment policy covers them).
 */
export function requireStepUp(user: CurrentUser): NextResponse | null {
  // Sensitive actions (deleting endpoints, restores, recovery kits…) need a person, not a token
  if (user.oauth) return NextResponse.json({ error: "This action needs a person signed in to DeployNow; AI connections can't do it" }, { status: 403 });
  if (user.tokenId) return NextResponse.json({ error: "This action needs a signed-in session; API tokens can't do it" }, { status: 403 });
  if (!user.totpEnabled || hasRecentStepUp(user.stepUpAt)) return null;
  return NextResponse.json(
    { error: "Confirm your authentication code to continue", stepUpRequired: true },
    { status: 403 },
  );
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
