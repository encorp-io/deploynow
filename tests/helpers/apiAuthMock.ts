/**
 * Stand-in for @/lib/apiAuth in route tests. Keeps the real permission logic
 * (rbac.can) but lets a test choose who is signed in:
 *
 *   vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
 *   import { signInAs, signOut } from "../helpers/apiAuthMock";
 *   signInAs("viewer");
 */
import { NextResponse } from "next/server";
import { can, type Binding, type Permission, type Role } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/apiAuth";

let current: CurrentUser | null = null;

export function signInAs(role: Role, extra: Partial<CurrentUser> & { bindings?: Binding[] } = {}): CurrentUser {
  current = {
    id: "cuser0000000000000000000001",
    email: `${role}@test.local`,
    name: role,
    role,
    sid: "csess0000000000000000000001",
    bindings: [],
    totpEnabled: false,
    stepUpAt: null,
    ...extra,
  };
  return current;
}

export function signOut() {
  current = null;
}

export async function getCurrentUser() {
  return current;
}

export async function requireUser(permission?: Permission, scope?: { endpointId?: string; projectId?: string }) {
  if (!current) return { ok: false as const, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (permission && !can(current, permission, scope)) {
    return { ok: false as const, response: NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 }) };
  }
  return { ok: true as const, user: current };
}

export function requireStepUp(user: CurrentUser) {
  if (!user.totpEnabled || (user.stepUpAt && Date.now() - user.stepUpAt.getTime() < 10 * 60_000)) return null;
  return NextResponse.json({ error: "Confirm your authentication code to continue", stepUpRequired: true }, { status: 403 });
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}
