/**
 * The public URL DeployNow is reached at.
 *
 *   1. the platform domain set (and verified) in Settings → Domain
 *   2. AUTH_URL / NEXTAUTH_URL from the environment
 *   3. the request's forwarded host (publicOrigin only)
 *
 * The Settings domain is kept in a process-wide cache (loaded at startup by
 * loadPlatformDomain and replaced on save), so these helpers stay synchronous.
 * IGNORE_PLATFORM_DOMAIN=true skips the stored domain: the escape hatch if a
 * domain ever needs to be bypassed without the UI.
 */

// Captured once: setPlatformDomain hides these from NextAuth while a domain is active
const ENV_URL = process.env.AUTH_URL || process.env.NEXTAUTH_URL || "";

const KEY = Symbol.for("deploynow.platformDomain");
type Store = { domain: string };
function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  return (g[KEY] ??= { domain: "" });
}

export function platformDomainIgnored(): boolean {
  return /^(1|true|yes)$/i.test(process.env.IGNORE_PLATFORM_DOMAIN ?? "");
}

/** The active platform domain from Settings ("" when none). */
export function platformDomain(): string {
  return platformDomainIgnored() ? "" : store().domain;
}

/** The origin set in the environment (AUTH_URL / NEXTAUTH_URL), if any. */
export function envOrigin(): string | null {
  if (!ENV_URL) return null;
  try {
    return new URL(ENV_URL).origin;
  } catch {
    return null;
  }
}

/**
 * Update the cached domain. While a domain is active, NextAuth follows the
 * host each request came in on (AUTH_TRUST_HOST) instead of a pinned AUTH_URL,
 * so signing in keeps working at the old address too: the lockout fallback.
 */
export function setPlatformDomain(domain: string): void {
  store().domain = domain;
  if (platformDomain()) {
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
  } else if (ENV_URL) {
    process.env.AUTH_URL = ENV_URL;
  }
}

/** Load the stored domain into the cache. Called at startup. */
export async function loadPlatformDomain(): Promise<string> {
  const { prisma } = await import("./prisma");
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { platformDomain: true } });
  setPlatformDomain(s?.platformDomain ?? "");
  return platformDomain();
}

/** The canonical public origin with no request at hand (background jobs, emails), or null if none is configured. */
export function publicBaseUrl(): string | null {
  const domain = platformDomain();
  if (domain) return `https://${domain}`;
  return envOrigin();
}

/** The origin the browser used for this request, from the forwarded headers. */
export function requestOrigin(request: Request): string {
  let url: URL | null = null;
  try {
    url = new URL(request.url);
  } catch {
    /* no absolute URL */
  }
  const first = (v: string | null) => (v ? v.split(",")[0].trim() : "");
  const proto = first(request.headers.get("x-forwarded-proto")) || (url && !request.headers.get("host") ? url.protocol.replace(":", "") : "https");
  const host = first(request.headers.get("x-forwarded-host")) || first(request.headers.get("host")) || url?.host || "localhost";
  return `${proto}://${host}`;
}

/** The canonical public origin (no trailing slash), else the request's forwarded host. */
export function publicOrigin(request: Request): string {
  return publicBaseUrl() ?? requestOrigin(request);
}
