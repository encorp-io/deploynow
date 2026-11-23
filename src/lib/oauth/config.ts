/**
 * Where the OAuth server and the MCP endpoint live, and what a connection may do.
 *
 * Everything hangs off the platform's public origin (Settings domain, then
 * AUTH_URL, then the request's forwarded host), so changing the domain moves
 * the issuer with it. Tokens issued under the old domain stop working, which is
 * what RFC 8707 audience binding asks for.
 */
import { publicOrigin } from "../publicOrigin";
import { higherRole, normalizeRole, roleAtLeast, type Binding, type Role } from "../rbac";

/** The issuer: the public origin, no trailing slash. */
export function issuerUrl(request: Request | { headers: Headers }): string {
  return publicOrigin(request as Request).replace(/\/+$/, "");
}

/** The MCP endpoint's URL, which is also the resource every access token is bound to. */
export function mcpResourceUrl(request: Request | { headers: Headers }): string {
  return `${issuerUrl(request)}/mcp`;
}

export function resourceMetadataUrl(request: Request | { headers: Headers }): string {
  return `${issuerUrl(request)}/.well-known/oauth-protected-resource/mcp`;
}

/** The MCP server can be switched off with DEPLOYNOW_MCP=off. */
export function mcpEnabled(): boolean {
  return !/^(off|false|0|no|disabled)$/i.test(process.env.DEPLOYNOW_MCP ?? "");
}

export const ACCESS_TTL_S = 60 * 60; // 1 hour
export const REFRESH_TTL_S = 30 * 24 * 60 * 60; // 30 days, renewed on every refresh
export const CODE_TTL_S = 5 * 60;

/**
 * OAuth scopes, one per role a connection can act with. A connection gets every
 * scope up to its role: "read operate" is an operator connection. Owner is never
 * granted to an AI app.
 */
export const SCOPES = [
  { scope: "read", role: "viewer", label: "Read only", text: "See endpoints, containers, apps, deployments, backups, tasks, alerts and metrics. Environment variable values stay hidden." },
  { scope: "operate", role: "operator", label: "Operate", text: "Also read logs and the audit log, start, stop and restart containers, deploy, roll back, and run backups and tasks." },
  { scope: "admin", role: "admin", label: "Admin", text: "Also change app environment variables and secrets. Secret values are write-only and never shown." },
] as const satisfies readonly { scope: string; role: Role; label: string; text: string }[];

export type ConnectionRole = (typeof SCOPES)[number]["role"];
export const SCOPE_NAMES = SCOPES.map((s) => s.scope);

export function isConnectionRole(r: unknown): r is ConnectionRole {
  return SCOPES.some((s) => s.role === r);
}

/** "read operate" for an operator connection. */
export function scopeForRole(role: string): string {
  const r = normalizeRole(role);
  return SCOPES.filter((s) => roleAtLeast(r, s.role)).map((s) => s.scope).join(" ");
}

/** The highest role a requested scope string asks for, or null if it names none we know. */
export function roleForScope(scope: string | null | undefined): ConnectionRole | null {
  const asked = new Set(String(scope ?? "").split(/\s+/).filter(Boolean));
  let best: ConnectionRole | null = null;
  for (const s of SCOPES) if (asked.has(s.scope)) best = s.role;
  return best;
}

/**
 * The highest role a person can hand to a connection: their instance role or any
 * per-endpoint/project binding, capped at admin. The connection is still capped
 * per scope, so a viewer with one admin project binding is admin only there.
 */
export function maxConnectionRole(user: { role: string; bindings?: Binding[] }): ConnectionRole {
  let r: Role = normalizeRole(user.role);
  for (const b of user.bindings ?? []) r = higherRole(r, normalizeRole(b.role));
  return r === "owner" ? "admin" : (r as ConnectionRole);
}
