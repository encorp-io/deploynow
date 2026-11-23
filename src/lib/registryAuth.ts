import type { Registry } from "@prisma/client";
import { prisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./secretsCrypto";
import { parseImageRef } from "./imageRef";

export interface AuthConfig {
  username: string;
  password: string;
  serveraddress: string;
}

export class RegistryError extends Error {}

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;
const MASK = "••••••••";

/** "https://ghcr.io/" → "ghcr.io"; "index.docker.io" → "docker.io" */
export function normalizeRegistryHost(raw: string): string {
  let h = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (h === "index.docker.io" || h === "registry-1.docker.io") h = "docker.io";
  return h;
}

export function validateRegistry(raw: Record<string, unknown>, existing?: Registry) {
  const name = String(raw.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 80) throw new RegistryError("Give the registry a name");
  const host = normalizeRegistryHost(String(raw.host ?? existing?.host ?? ""));
  if (!HOST_RE.test(host)) throw new RegistryError("Enter the registry host, e.g. ghcr.io or registry.example.com:5000");
  const username = String(raw.username ?? existing?.username ?? "").trim();
  if (!username || username.length > 200) throw new RegistryError("Enter the user name");
  const pw = typeof raw.password === "string" && raw.password !== MASK ? raw.password : null;
  if (!pw && !existing) throw new RegistryError("Enter the password or access token");
  if (pw && pw.length > 4000) throw new RegistryError("Password too long");
  const namespace = String(raw.namespace ?? existing?.namespace ?? "").trim().replace(/\/+$/, "");
  if (namespace && !/^[a-z0-9][a-z0-9._\-/:]*$/.test(namespace)) throw new RegistryError("Invalid namespace, e.g. ghcr.io/acme");
  return { name, host, username, ...(pw ? { password: encryptSecret(pw) } : {}), namespace };
}

export function serializeRegistry(r: Registry) {
  return { id: r.id, name: r.name, host: r.host, username: r.username, password: r.password ? MASK : "", namespace: r.namespace, createdAt: r.createdAt };
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

/** Registry credentials Docker should use to pull `image`, if we have any. */
export async function registryAuthFor(image: string): Promise<AuthConfig | undefined> {
  const { registry } = parseImageRef(image);
  const host = normalizeRegistryHost(registry);
  const saved = await prisma.registry.findFirst({ where: { host } });
  if (saved) return toAuth(saved);
  if (host === "ghcr.io") return legacyGhcr();
  return undefined;
}

/** Every login the docker CLI should have (compose pulls, builds, pushes). */
export async function allRegistryLogins(): Promise<AuthConfig[]> {
  const out: AuthConfig[] = [];
  for (const r of await prisma.registry.findMany()) {
    const a = toAuth(r);
    if (a) out.push(a);
  }
  if (!out.some((a) => a.serveraddress === "ghcr.io")) {
    const gh = await legacyGhcr();
    if (gh) out.push(gh);
  }
  return out;
}

export async function registryById(id: string | null | undefined) {
  return id ? prisma.registry.findUnique({ where: { id } }) : null;
}

export function registryAuth(r: Registry): AuthConfig | undefined {
  return toAuth(r);
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
      const tok = await fetch(url, { headers: { Authorization: basic }, signal: AbortSignal.timeout(10_000) });
      return tok.ok ? { ok: true, message: "Signed in" } : { ok: false, message: `The registry refused the credentials (${tok.status})` };
    }
    return { ok: false, message: `The registry answered ${first.status}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Could not reach the registry" };
  }
}
