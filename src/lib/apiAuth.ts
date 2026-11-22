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

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  sid: string;
  bindings: Binding[];
  totpEnabled: boolean;
  stepUpAt: Date | null;
}

type Gate = { ok: true; user: CurrentUser } | { ok: false; response: NextResponse };

export async function getCurrentUser(): Promise<CurrentUser | null> {
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
  scope?: { endpointId?: string },
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
