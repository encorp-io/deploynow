/**
 * Typed helpers for extracting fields from NextAuth sessions in API routes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySession = any;

export function getSessionRole(session: AnySession): string | undefined {
  return session?.user?.role as string | undefined;
}

export function getSessionUserId(session: AnySession): string {
  return (session?.user?.id as string | undefined) ?? "";
}

export function isAdmin(session: AnySession): boolean {
  return getSessionRole(session) === "admin";
}
