/**
 * Registry logins: shared service accounts and personal logins.
 *
 * Which login an app pulls (and builds) with, one per registry host, first wins:
 *
 *   1. the app's push registry (registryId), so builds push with that account
 *   2. the login picked on the app for pulls (pullRegistryId)
 *   3. a shared login limited to the app's project
 *   4. a shared login for the whole instance
 *   5. the legacy GitHub token in Settings, for ghcr.io
 *
 * Personal logins are only ever used through 1 or 2, so an app never starts
 * using someone's own credentials because of who clicked Deploy. A personal
 * login of a disabled user is skipped.
 */
import type { Registry } from "@prisma/client";
import { prisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./secretsCrypto";
import { parseImageRef } from "./imageRef";
import { can, type Binding, type Role } from "./rbac";

export interface AuthConfig {
  username: string;
  password: string;
  serveraddress: string;
}

export class RegistryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;
export const MASK = "••••••••";
export const OWNER_TYPES = ["shared", "personal"] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/** Who is asking: enough of CurrentUser for permission checks. */
export interface Actor {
  id: string;
  role: Role;
  bindings?: Binding[];
}

/** The app (or project) a pull is for. */
export interface PullContext {
  projectId?: string | null;
  pullRegistryId?: string | null;
  pushRegistryId?: string | null;
}

/** "https://ghcr.io/" → "ghcr.io"; "index.docker.io" → "docker.io" */
export function normalizeRegistryHost(raw: string): string {
  let h = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (h === "index.docker.io" || h === "registry-1.docker.io" || h === "hub.docker.com") h = "docker.io";
  return h;
}

/** Host part of a push namespace: "ghcr.io/acme" → ghcr.io, "acme" → docker.io */
export function namespaceHost(namespace: string): string {
  const first = namespace.split("/")[0];
  return first.includes(".") || first.includes(":") || first === "localhost" ? normalizeRegistryHost(first) : "docker.io";
}

export function registryProvider(host: string): "dockerhub" | "ghcr" | "other" {
  if (host === "docker.io") return "dockerhub";
  if (host === "ghcr.io") return "ghcr";
  return "other";
}

// ─── Permissions ──────────────────────────────────────────────────────────────

/** May `actor` add, change, test or remove this login? */
export function canManageRegistry(actor: Actor, r: Pick<Registry, "ownerType" | "userId" | "projectId">): boolean {
  if (r.ownerType === "personal") return r.userId === actor.id;
  if (can(actor, "settings.manage")) return true;
  return !!r.projectId && can(actor, "app.manage", { projectId: r.projectId });
}

/** May `actor` attach this login to an app in `projectId`? */
export function canUseRegistry(actor: Actor, r: Pick<Registry, "ownerType" | "userId" | "projectId">, projectId: string): boolean {
  if (r.ownerType === "personal") return r.userId === actor.id;
  return !r.projectId || r.projectId === projectId;
}

/** Logins `actor` can see: their own, and every shared one (credentials stay masked). */
export async function visibleRegistries(actor: Actor, filter: { projectId?: string } = {}) {
  const rows = await prisma.registry.findMany({
    where: { OR: [{ ownerType: "shared" }, { ownerType: "personal", userId: actor.id }] },
    include: { project: { select: { id: true, name: true } } },
    orderBy: [{ ownerType: "asc" }, { name: "asc" }],
  });
  return filter.projectId ? rows.filter((r) => canUseRegistry(actor, r, filter.projectId!)) : rows;
}

// ─── Validation and serialisation ─────────────────────────────────────────────

export interface RegistryInput {
  name: string;
  host: string;
  username: string;
  password?: string;
  namespace: string;
  ownerType: OwnerType;
  userId: string | null;
  projectId: string | null;
}

/**
 * Check a create (no `existing`) or update body. Owner and project are fixed
 * once created; move a login by adding a new one.
 */
export async function validateRegistry(raw: Record<string, unknown>, actor: Actor, existing?: Registry): Promise<RegistryInput> {
  const name = String(raw.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 80) throw new RegistryError("Give the login a name");
  const host = normalizeRegistryHost(String(raw.host ?? existing?.host ?? ""));
  if (!HOST_RE.test(host)) throw new RegistryError("Enter the registry host, e.g. docker.io, ghcr.io or registry.example.com:5000");
  const username = String(raw.username ?? existing?.username ?? "").trim();
  if (!username || username.length > 200) throw new RegistryError("Enter the user name");
  const pw = typeof raw.password === "string" && raw.password !== MASK && raw.password !== "" ? raw.password : null;
  if (!pw && !existing) throw new RegistryError(registryProvider(host) === "other" ? "Enter the password or access token" : "Enter the access token");
  if (pw && pw.length > 4000) throw new RegistryError("Password too long");
  const namespace = String(raw.namespace ?? existing?.namespace ?? "").trim().toLowerCase().replace(/\/+$/, "");
  if (namespace && !/^[a-z0-9][a-z0-9._\-/:]*$/.test(namespace)) throw new RegistryError("Invalid namespace, e.g. ghcr.io/acme");
  if (namespace && namespaceHost(namespace) !== host) {
    throw new RegistryError(`The push namespace must be on ${host}, e.g. ${host === "docker.io" ? "docker.io/acme or acme" : `${host}/acme`}`);
  }

  let ownerType: OwnerType;
  let userId: string | null;
  let projectId: string | null;
  if (existing) {
    if (raw.ownerType !== undefined && raw.ownerType !== existing.ownerType) throw new RegistryError("A login can't move between personal and shared; add a new one");
    if (raw.projectId !== undefined && (raw.projectId || null) !== existing.projectId) throw new RegistryError("A shared login can't move to another project; add a new one");
    ownerType = existing.ownerType as OwnerType;
    userId = existing.userId;
    projectId = existing.projectId;
  } else {
    ownerType = raw.ownerType === "personal" ? "personal" : raw.ownerType === undefined || raw.ownerType === "shared" ? "shared" : (() => { throw new RegistryError("ownerType is shared or personal"); })();
    userId = ownerType === "personal" ? actor.id : null;
    projectId = ownerType === "shared" && raw.projectId ? String(raw.projectId) : null;
    if (ownerType === "personal" && raw.projectId) throw new RegistryError("Personal logins aren't tied to a project");
    if (projectId && !(await prisma.project.findUnique({ where: { id: projectId } }))) throw new RegistryError("That project doesn't exist");
  }

  const clash = await prisma.registry.findFirst({
    where: { name, ownerType, userId, projectId, ...(existing ? { id: { not: existing.id } } : {}) },
  });
  if (clash) throw new RegistryError(ownerType === "personal" ? "You already have a login with that name" : "A shared login with that name already exists", 409);

  return { name, host, username, ...(pw ? { password: encryptSecret(pw) } : {}), namespace, ownerType, userId, projectId };
}

type WithProject = Registry & { project?: { id: string; name: string } | null };

export function serializeRegistry(r: WithProject, actor?: Actor) {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    provider: registryProvider(r.host),
    username: r.username,
    password: r.password ? MASK : "",
    namespace: r.namespace,
    ownerType: r.ownerType,
    mine: r.ownerType === "personal" && !!actor && r.userId === actor.id,
    projectId: r.projectId,
    projectName: r.project?.name ?? null,
    canManage: actor ? canManageRegistry(actor, r) : false,
    lastTestAt: r.lastTestAt,
    lastTestOk: r.lastTestOk,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}

// ─── Resolution ───────────────────────────────────────────────────────────────

interface Resolved {
  host: string;
  auth: AuthConfig;
}

function toAuth(r: Registry): AuthConfig | undefined {
  const password = decryptSecret(r.password);
  if (!password) return undefined;
  return { username: r.username, password, serveraddress: r.host === "docker.io" ? "https://index.docker.io/v1/" : r.host };
}

async function legacyGhcr(): Promise<AuthConfig | undefined> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const token = settings?.githubToken ? decryptSecret(settings.githubToken) : "";
  if (!token) return undefined;
  return { username: settings?.githubUser || "token", password: token, serveraddress: "ghcr.io" };
}

/** An explicitly chosen login, if it is still allowed for this project. */
async function chosen(id: string | null | undefined, projectId: string | null | undefined): Promise<Registry | null> {
  if (!id) return null;
  const r = await prisma.registry.findUnique({ where: { id }, include: { user: { select: { disabledAt: true } } } });
  if (!r) return null;
  if (r.ownerType === "personal" && (!r.user || r.user.disabledAt)) return null;
  if (r.ownerType === "shared" && r.projectId && r.projectId !== projectId) return null;
  return r;
}

/** Every login for this context, one per host, in priority order. */
async function resolveLogins(ctx: PullContext = {}): Promise<Resolved[]> {
  const ordered: Registry[] = [];
  // The push registry first: a build must push (and the target pull) with that account
  const push = await chosen(ctx.pushRegistryId, ctx.projectId);
  if (push) ordered.push(push);
  const pull = await chosen(ctx.pullRegistryId, ctx.projectId);
  if (pull) ordered.push(pull);
  const shared = await prisma.registry.findMany({
    where: { ownerType: "shared", OR: [{ projectId: null }, ...(ctx.projectId ? [{ projectId: ctx.projectId }] : [])] },
    orderBy: { createdAt: "asc" },
  });
  ordered.push(...shared.filter((r) => r.projectId), ...shared.filter((r) => !r.projectId));

  const out: Resolved[] = [];
  for (const r of ordered) {
    if (out.some((o) => o.host === r.host)) continue;
    const auth = toAuth(r);
    if (auth) out.push({ host: r.host, auth });
  }
  if (!out.some((o) => o.host === "ghcr.io")) {
    const gh = await legacyGhcr();
    if (gh) out.push({ host: "ghcr.io", auth: gh });
  }
  return out;
}

/** Registry credentials Docker should use to pull `image`, if we have any. */
export async function registryAuthFor(image: string, ctx?: PullContext): Promise<AuthConfig | undefined> {
  const host = normalizeRegistryHost(parseImageRef(image).registry);
  return (await resolveLogins(ctx)).find((r) => r.host === host)?.auth;
}

/** Every login the docker CLI should have for this context (compose pulls, builds, pushes). */
export async function allRegistryLogins(ctx?: PullContext): Promise<AuthConfig[]> {
  return (await resolveLogins(ctx)).map((r) => r.auth);
}

export async function registryById(id: string | null | undefined) {
  return id ? prisma.registry.findUnique({ where: { id } }) : null;
}

export function registryAuth(r: Registry): AuthConfig | undefined {
  return toAuth(r);
}

/** The pull context of an app row. */
export function appPullContext(app: { pullRegistryId?: string | null; registryId?: string | null; environment?: { projectId: string } | null }): PullContext {
  return { projectId: app.environment?.projectId ?? null, pullRegistryId: app.pullRegistryId ?? null, pushRegistryId: app.registryId ?? null };
}

/** Check credentials against the registry's token endpoint (Docker Registry v2 API). */
export async function testRegistry(r: Registry): Promise<{ ok: boolean; message: string }> {
  const auth = toAuth(r);
  if (!auth) return { ok: false, message: "The stored password can't be decrypted" };
  const base = r.host === "docker.io" ? "https://registry-1.docker.io" : `https://${r.host}`;
  const basic = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  try {
    const first = await fetch(`${base}/v2/`, { headers: { Authorization: basic }, signal: AbortSignal.timeout(10_000), redirect: "manual" });
    if (first.ok) return { ok: true, message: "Signed in" };
    const challenge = first.headers.get("www-authenticate") ?? "";
    const m = /Bearer realm="([^"]+)"(?:,service="([^"]+)")?/i.exec(challenge);
    if (first.status === 401 && m) {
      const url = new URL(m[1]);
      if (m[2]) url.searchParams.set("service", m[2]);
      // Docker Hub and GHCR hand out anonymous tokens; ask for an account scope so bad credentials fail
      if (r.host === "docker.io") url.searchParams.set("account", auth.username);
      if (r.host === "ghcr.io") url.searchParams.set("scope", `repository:${auth.username.toLowerCase()}/deploynow-login-check:pull`);
      const tok = await fetch(url, { headers: { Authorization: basic }, signal: AbortSignal.timeout(10_000) });
      return tok.ok ? { ok: true, message: "Signed in" } : { ok: false, message: `The registry refused the credentials (${tok.status})` };
    }
    return { ok: false, message: `The registry answered ${first.status}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Could not reach the registry" };
  }
}
