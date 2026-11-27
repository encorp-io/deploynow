/**
 * Roles and permissions.
 *
 * Every user has an instance-wide role. A RoleBinding can raise it for one
 * endpoint (and, from phase 2, one project). The effective role for an action
 * on an endpoint is the higher of the two.
 */

export const ROLES = ["viewer", "operator", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];
export const BINDABLE_ROLES = ["viewer", "operator", "admin"] as const;

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** Maps v1 roles (admin, member) and anything unknown onto v2 roles. */
export function normalizeRole(role: unknown): Role {
  if (role === "member") return "operator";
  return (ROLES as readonly string[]).includes(role as string) ? (role as Role) : "viewer";
}

export function isRole(role: unknown): role is Role {
  return (ROLES as readonly string[]).includes(role as string);
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function higherRole(a: Role, b: Role): Role {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Minimum role per action. `scoped` actions can be granted per endpoint. */
export const PERMISSIONS = {
  "endpoint.view": { min: "viewer", scoped: true },
  "container.inspect": { min: "viewer", scoped: true },
  "container.logs": { min: "operator", scoped: true },
  // Env values can hold secrets: admins only. Operators keep the console in ordinary
  // containers (Martin's call); DeployNow's own and helper containers refuse it.
  "container.env": { min: "admin", scoped: true },
  "container.control": { min: "operator", scoped: true },
  "container.exec": { min: "operator", scoped: true },
  "service.update": { min: "operator", scoped: true },
  "container.remove": { min: "admin", scoped: true },
  "image.remove": { min: "admin", scoped: true },
  "volume.remove": { min: "admin", scoped: true },
  "network.remove": { min: "admin", scoped: true },
  "docker.prune": { min: "admin", scoped: true },
  "audit.view": { min: "operator", scoped: false },
  "endpoint.manage": { min: "admin", scoped: false },
  "users.manage": { min: "admin", scoped: false },
  "settings.manage": { min: "admin", scoped: false },
  "polling.run": { min: "admin", scoped: false },
  // Apps (phase 2): scoped to a project
  "project.view": { min: "viewer", scoped: true },
  "app.logs": { min: "operator", scoped: true },
  "app.deploy": { min: "operator", scoped: true },
  "app.manage": { min: "admin", scoped: true },
  "app.secrets": { min: "admin", scoped: true },
  "project.manage": { min: "admin", scoped: false },
  "notifications.manage": { min: "admin", scoped: false },
  // Phase 3
  "backup.view": { min: "operator", scoped: false },
  "backup.run": { min: "operator", scoped: false },
  "backup.manage": { min: "admin", scoped: false },
  "backup.restore": { min: "admin", scoped: false },
  "task.view": { min: "operator", scoped: false },
  "task.run": { min: "operator", scoped: false },
  "task.manage": { min: "admin", scoped: false },
  "monitoring.view": { min: "viewer", scoped: false },
  "uptime.manage": { min: "admin", scoped: false },
} as const satisfies Record<string, { min: Role; scoped: boolean }>;

export type Permission = keyof typeof PERMISSIONS;

export interface Binding {
  role: string;
  scopeType: string;
  scopeId: string;
}

export interface Subject {
  role: string;
  bindings?: Binding[];
}

export interface Scope {
  endpointId?: string;
  projectId?: string;
}

export function effectiveRole(subject: Subject, scope?: Scope): Role {
  let role = normalizeRole(subject.role);
  for (const b of subject.bindings ?? []) {
    const hit =
      (scope?.endpointId && b.scopeType === "endpoint" && b.scopeId === scope.endpointId) ||
      (scope?.projectId && b.scopeType === "project" && b.scopeId === scope.projectId);
    if (hit) role = higherRole(role, normalizeRole(b.role));
  }
  return role;
}

export function can(subject: Subject, permission: Permission, scope?: Scope): boolean {
  const rule = PERMISSIONS[permission];
  const role = rule.scoped ? effectiveRole(subject, scope) : normalizeRole(subject.role);
  return roleAtLeast(role, rule.min);
}

/** Admins may manage users below them; only owners may create or change owners. */
export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (targetRole === "owner") return actorRole === "owner";
  return roleAtLeast(actorRole, "admin");
}
