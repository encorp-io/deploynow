/**
 * Who may put an app on an endpoint, and which hosts an app may claim.
 *
 * A project admin manages the project's apps, but the endpoint the app runs
 * on is a separate grant: putting a container on a server is the same power
 * as starting one there, so it needs container.control on that endpoint.
 * Instance-wide operators and above pass everywhere; anyone else needs an
 * endpoint binding.
 *
 * Hosts: an app may never take DeployNow's own domain (any path, because
 * Traefik prefers the longer rule, so /login on that host would intercept
 * sign-in), and a host that one project uses can't be shared by another.
 */
import { prisma } from "../prisma";
import { can, type Subject } from "../rbac";
import { envOrigin, platformDomain } from "../publicOrigin";

/** May this user run containers on the endpoint (create an app there, build there, make it a default)? */
export function canPlaceOn(user: Subject, endpointId: string): boolean {
  return can(user, "container.control", { endpointId });
}

export const PLACE_DENIED = "You don't have permission to run apps on that endpoint";

/** The hosts DeployNow itself answers on: the Settings domain (even while ignored) and the AUTH_URL host. */
async function platformHosts(): Promise<string[]> {
  const hosts = new Set<string>();
  const cached = platformDomain();
  if (cached) hosts.add(cached.toLowerCase());
  const stored = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { platformDomain: true } }).catch(() => null);
  if (stored?.platformDomain) hosts.add(stored.platformDomain.toLowerCase());
  const env = envOrigin();
  if (env) {
    try {
      hosts.add(new URL(env).hostname.toLowerCase());
    } catch {
      /* not a URL */
    }
  }
  return [...hosts];
}

/**
 * Why `host` can't be routed to an app of `projectId`, or null if it can.
 * Exact host+path uniqueness is still the database's job (and the caller's 409).
 */
export async function hostClaimError(host: string, projectId: string): Promise<string | null> {
  const h = host.toLowerCase();
  if ((await platformHosts()).includes(h)) return `${h} is DeployNow's own address and can't be routed to an app`;
  const taken = await prisma.domain.findFirst({
    where: { host: h, application: { environment: { projectId: { not: projectId } } } },
    select: { id: true },
  });
  if (taken) return `${h} is already used by an app in another project`;
  // pr-N.<preview domain> belongs to the project whose app has that preview domain
  const m = /^pr-\d+\.(.+)$/.exec(h);
  if (m && (await prisma.application.findFirst({ where: { previewDomain: m[1], environment: { projectId: { not: projectId } } }, select: { id: true } }))) {
    return `${h} is reserved for pull request previews of an app in another project`;
  }
  return null;
}

/**
 * Why `domain` can't be a preview domain for an app of `projectId`. Previews
 * get pr-N.<domain>, so DeployNow's own host must not be (or look like) one,
 * and another project's preview domain can't be reused.
 */
export async function previewDomainError(domain: string, projectId: string, appId?: string): Promise<string | null> {
  const d = domain.toLowerCase();
  for (const host of await platformHosts()) {
    if (host === d || new RegExp(`^pr-\\d+\\.${d.replace(/\./g, "\\.")}$`).test(host)) {
      return `${d} would put previews on DeployNow's own address; choose another preview domain`;
    }
  }
  const other = await prisma.application.findFirst({
    where: { previewDomain: d, NOT: appId ? { id: appId } : undefined, environment: { projectId: { not: projectId } } },
    select: { id: true },
  });
  if (other) return `${d} is already the preview domain of an app in another project`;
  const previewHost = new RegExp(`^pr-\\d+\\.${d.replace(/\./g, "\\.")}$`);
  const claimed = await prisma.domain.findMany({
    where: { host: { endsWith: `.${d}` }, application: { environment: { projectId: { not: projectId } } } },
    select: { host: true },
  });
  const hit = claimed.find((c) => previewHost.test(c.host));
  if (hit) return `${hit.host} is already used by an app in another project, so ${d} can't be a preview domain here`;
  return null;
}
