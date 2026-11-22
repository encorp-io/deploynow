/**
 * Typed helpers for reading fields from NextAuth sessions.
 * New code should prefer requireUser() from ./apiAuth, which re-reads the
 * user and their role bindings from the database.
 */
import { normalizeRole, roleAtLeast } from "./rbac";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySession = any;

export function getSessionRole(session: AnySession): string | undefined {
  return session?.user?.role as string | undefined;
}

export function getSessionUserId(session: AnySession): string {
  return (session?.user?.id as string | undefined) ?? "";
}

/** True for admins and owners. */
export function isAdmin(session: AnySession): boolean {
  const role = getSessionRole(session);
  return !!role && roleAtLeast(normalizeRole(role), "admin");
}
