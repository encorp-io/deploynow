/**
 * Serve DeployNow's own UI on a domain (Settings → Domain).
 *
 * Traefik on the local endpoint (managed or external) routes the domain and gets
 * its Let's Encrypt certificate. Traefik reads Docker labels, and a running
 * container's labels can't change, so the route lives on a tiny label-only
 * container ("deploynow-ui-route") that shares DeployNow's network namespace:
 * Traefik resolves it to DeployNow's address on the proxy network and sends
 * traffic to the plain-HTTP listener nginx keeps for it (UI_HTTP_PORT, never
 * published on the host).
 *
 * The domain only becomes the canonical address after it answered this very
 * instance with a valid certificate. Port 9444 keeps working throughout, and
 * sign-in follows the host each request came in on, so a broken domain can't
 * lock anyone out. IGNORE_PLATFORM_DOMAIN=true ignores a stored domain.
 */
import crypto from "crypto";
import dns from "dns";
import fs from "fs";
import https from "https";
import os from "os";
import type Docker from "dockerode";
import type { Endpoint } from "@prisma/client";
import { prisma } from "./prisma";
import { dockerFor } from "./endpoints";
import { dockerStatusCode } from "./docker/client";
import { ensureNetwork } from "./deploy/proxy";
import { ConfigError, validateHost } from "./apps/config";
import { setPlatformDomain } from "./publicOrigin";

export const ROUTE_CONTAINER = "deploynow-ui-route";
export const UI_HTTP_PORT = Number(process.env.UI_HTTP_PORT || 9080) || 9080;
export const PROBE_PATH = "/api/platform-domain/probe";

export class DomainError extends Error {}

/** A bare host name such as deploy.example.com (no scheme, port, path or wildcard; not an IP). */
export function validatePlatformDomain(raw: unknown): string {
  let v = String(raw ?? "").trim().toLowerCase();
  // Be forgiving about a pasted URL
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  let host: string;
  try {
    host = validateHost(v);
  } catch (err) {
    throw new DomainError((err as ConfigError).message);
  }
  if (host.startsWith("*.")) throw new DomainError("Use a single host name, not a wildcard");
  if (/^[\d.]+$/.test(host)) throw new DomainError("Enter a domain name, not an IP address");
  if (!host.includes(".")) throw new DomainError("Enter a full domain name such as deploy.example.com");
  return host;
}

/** Request header Traefik adds so nginx trusts its X-Real-IP / X-Forwarded-Proto (see nginx.conf). */
export const PROXY_AUTH_HEADER = "X-DeployNow-Proxy-Auth";

/**
 * Traefik labels for the UI route: HTTPS with Let's Encrypt, plain HTTP redirected.
 * With `secret` (DEPLOYNOW_PROXY_SECRET from the entrypoint), the HTTPS router also
 * adds it as PROXY_AUTH_HEADER, which is how nginx tells Traefik apart from an app
 * container that dials :9080 directly with made-up forwarded headers.
 */
export function platformRouteLabels(domains: string[], network: string, port = UI_HTTP_PORT, secret = process.env.DEPLOYNOW_PROXY_SECRET ?? ""): Record<string, string> {
  const r = "deploynow-ui";
  const rule = domains.map((d) => `Host(\`${d}\`)`).join(" || ");
  const trust: Record<string, string> = /^[0-9a-f]{32,}$/.test(secret)
    ? {
        [`traefik.http.routers.${r}.middlewares`]: `${r}-trust`,
        [`traefik.http.middlewares.${r}-trust.headers.customrequestheaders.${PROXY_AUTH_HEADER}`]: secret,
      }
    : {};
  return {
    "traefik.enable": "true",
    "traefik.docker.network": network,
    [`traefik.http.services.${r}.loadbalancer.server.port`]: String(port),
    [`traefik.http.routers.${r}.rule`]: rule,
    [`traefik.http.routers.${r}.entrypoints`]: "websecure",
    [`traefik.http.routers.${r}.tls.certresolver`]: "letsencrypt",
    [`traefik.http.routers.${r}.service`]: r,
    ...trust,
    [`traefik.http.routers.${r}-http.rule`]: rule,
    [`traefik.http.routers.${r}-http.entrypoints`]: "web",
    [`traefik.http.routers.${r}-http.middlewares`]: `${r}-https`,
    [`traefik.http.routers.${r}-http.service`]: r,
    [`traefik.http.middlewares.${r}-https.redirectscheme.scheme`]: "https",
    [`traefik.http.middlewares.${r}-https.redirectscheme.permanent`]: "true",
  };
}

// ── Finding ourselves ────────────────────────────────────────────────────────

/** IDs that may name the container DeployNow runs in. */
export function selfContainerCandidates(): string[] {
  const ids = new Set<string>();
  if (process.env.DEPLOYNOW_CONTAINER) ids.add(process.env.DEPLOYNOW_CONTAINER);
  try {
    const m = fs.readFileSync("/proc/self/mountinfo", "utf8").match(/\/(?:docker\/)?containers\/([0-9a-f]{64})\//);
    if (m) ids.add(m[1]);
  } catch {
    /* not Linux, or not in a container */
  }
  ids.add(os.hostname());
  return [...ids];
}

type Inspect = Awaited<ReturnType<Docker.Container["inspect"]>>;

async function inspectSelf(docker: Docker): Promise<Inspect | null> {
  for (const id of selfContainerCandidates()) {
    try {
      return await docker.getContainer(id).inspect();
    } catch {
      /* try the next one */
    }
  }
  return null;
}

export interface LocalTarget {
  endpoint: Endpoint;
  docker: Docker;
  self: Inspect;
}

/** The endpoint DeployNow itself runs on, with its Docker client and our own container. */
export async function findLocalTarget(): Promise<LocalTarget | null> {
  const endpoints = await prisma.endpoint.findMany({ where: { type: "socket" }, orderBy: { createdAt: "asc" } });
  for (const endpoint of endpoints) {
    const docker = dockerFor(endpoint);
    const self = await inspectSelf(docker).catch(() => null);
    if (self) return { endpoint, docker, self };
  }
  return null;
}

// ── The route ────────────────────────────────────────────────────────────────

/** Join the proxy network and (re)create the label container for the domains (the active one, plus one being checked). */
export async function ensurePlatformRoute(domains: string[], target?: LocalTarget | null): Promise<{ endpointName: string; network: string }> {
  domains = [...new Set(domains.filter(Boolean))];
  if (!domains.length) {
    await removePlatformRoute(target?.docker);
    return { endpointName: target?.endpoint.name ?? "", network: target?.endpoint.proxyNetwork ?? "" };
  }
  const t = target ?? (await findLocalTarget());
  if (!t) {
    throw new DomainError(
      "DeployNow can't find its own container through a local Docker socket endpoint. Mount /var/run/docker.sock and add it as an endpoint, or route the domain to port 9444 yourself.",
    );
  }
  const { endpoint, docker, self } = t;
  if (endpoint.proxyMode === "none") {
    throw new DomainError(`Set up the edge proxy on ${endpoint.name} first (Endpoints → ${endpoint.name} → Edge proxy). It routes the domain and gets its certificate.`);
  }
  const network = endpoint.proxyNetwork;
  if (endpoint.proxyMode === "managed") await ensureNetwork(docker, network);
  if (!self.NetworkSettings?.Networks?.[network]) {
    try {
      await docker.getNetwork(network).connect({ Container: self.Id });
    } catch (err) {
      if (dockerStatusCode(err) !== 403 && !/already exists/i.test((err as Error).message)) throw err;
    }
  }
  await removePlatformRoute(docker);
  const container = await docker.createContainer({
    name: ROUTE_CONTAINER,
    Image: self.Image, // already on this machine: nothing to pull
    Entrypoint: ["tail", "-f", "/dev/null"],
    Cmd: [],
    Labels: { ...platformRouteLabels(domains, network), "deploynow.role": "ui-route", "deploynow.domain": domains.join(",") },
    HostConfig: {
      NetworkMode: `container:${self.Id}`,
      RestartPolicy: { Name: "no" }, // recreated by DeployNow at every start
      Memory: 32 * 1024 * 1024,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
    },
  });
  await container.start();
  return { endpointName: endpoint.name, network };
}

export async function removePlatformRoute(docker?: Docker): Promise<void> {
  const d = docker ?? (await findLocalTarget())?.docker;
  if (!d) return;
  try {
    await d.getContainer(ROUTE_CONTAINER).remove({ force: true });
  } catch (err) {
    if (dockerStatusCode(err) !== 404) throw err;
  }
}

export interface RouteStatus {
  present: boolean;
  running: boolean;
  domains: string[];
  endpointName: string;
  proxyMode: string;
  error: string;
}

export async function platformRouteStatus(): Promise<RouteStatus> {
  const empty: RouteStatus = { present: false, running: false, domains: [], endpointName: "", proxyMode: "none", error: "" };
  let t: LocalTarget | null;
  try {
    t = await findLocalTarget();
  } catch (err) {
    return { ...empty, error: (err as Error).message };
  }
  if (!t) return { ...empty, error: "DeployNow's own container wasn't found through a local Docker socket endpoint" };
  const base = { ...empty, endpointName: t.endpoint.name, proxyMode: t.endpoint.proxyMode };
  try {
    const info = await t.docker.getContainer(ROUTE_CONTAINER).inspect();
    return { ...base, present: true, running: info.State.Running, domains: (info.Config.Labels?.["deploynow.domain"] ?? "").split(",").filter(Boolean) };
  } catch (err) {
    if (dockerStatusCode(err) === 404) return base;
    return { ...base, error: (err as Error).message };
  }
}

// ── Checks ───────────────────────────────────────────────────────────────────

export async function resolveDomain(domain: string): Promise<string[]> {
  try {
    const rows = await dns.promises.lookup(domain, { all: true });
    return [...new Set(rows.map((r) => r.address))];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      throw new DomainError(`${domain} has no DNS record yet. Add an A (or AAAA) record that points at this server's public IP, then check again.`);
    }
    throw new DomainError(`Looking up ${domain} failed: ${(err as Error).message}`);
  }
}

function probeKey(): Buffer {
  return crypto.createHash("sha256").update(`deploynow-domain-probe:${process.env.AUTH_SECRET ?? ""}`).digest();
}

/** What the probe endpoint answers: proves the domain reached this instance. */
export function probeSignature(nonce: string): string {
  return crypto.createHmac("sha256", probeKey()).update(nonce).digest("base64url");
}

type Fetched = { status: number; body: string } | { error: string; code?: string };

function httpsGet(url: string, verify: boolean, timeoutMs = 8000): Promise<Fetched> {
  return new Promise((resolve) => {
    const req = https.get(url, { rejectUnauthorized: verify, timeout: timeoutMs, headers: { "user-agent": "DeployNow domain check" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        if (body.length < 4096) body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", (err: NodeJS.ErrnoException) => resolve({ error: err.message, code: err.code }));
  });
}

export interface ProbeResult {
  reachable: boolean;
  certificateValid: boolean;
  message: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask https://<domain> for a signed answer only this instance can give. Waits
 * up to waitMs for Traefik to pick up the route and Let's Encrypt to issue.
 */
export async function probeDomain(domain: string, waitMs = 45_000, get = httpsGet): Promise<ProbeResult> {
  const deadline = Date.now() + waitMs;
  let last: ProbeResult = { reachable: false, certificateValid: false, message: "" };
  for (;;) {
    const nonce = crypto.randomBytes(16).toString("base64url");
    const url = `https://${domain}${PROBE_PATH}?n=${nonce}`;
    const insecure = await get(url, false);
    if ("error" in insecure) {
      last = { reachable: false, certificateValid: false, message: `https://${domain} didn't answer (${insecure.code ?? insecure.error}). Check the DNS record points at this server and ports 80 and 443 are open.` };
    } else {
      let sig = "";
      try {
        sig = (JSON.parse(insecure.body) as { sig?: string }).sig ?? "";
      } catch {
        /* not ours */
      }
      if (sig !== probeSignature(nonce)) {
        last = {
          reachable: false,
          certificateValid: false,
          message:
            insecure.status === 404
              ? `https://${domain} answered, but not from this DeployNow (404). Traefik may still be picking up the route, or the DNS record points at another server.`
              : `https://${domain} answered ${insecure.status}, but not from this DeployNow. Check the DNS record points at this server.`,
        };
      } else {
        const secure = await get(url, true);
        if (!("error" in secure)) return { reachable: true, certificateValid: true, message: `https://${domain} reaches this DeployNow with a valid certificate` };
        last = { reachable: true, certificateValid: false, message: `https://${domain} reaches this DeployNow, but its certificate isn't valid yet (${secure.code ?? secure.error}). Let's Encrypt may still be issuing it.` };
      }
    }
    if (Date.now() + 3000 > deadline) return last;
    await sleep(3000);
  }
}

// ── Switching ────────────────────────────────────────────────────────────────

export async function saveActiveDomain(domain: string): Promise<void> {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: { platformDomain: domain }, create: { id: "singleton", platformDomain: domain } });
  setPlatformDomain(domain);
}

/** Passkeys that won't work on the domain: they were added on another host. */
export async function passkeysOffDomain(domain: string, userId?: string): Promise<number> {
  return prisma.passkey.count({ where: { rpId: { not: domain }, ...(userId ? { userId } : {}) } });
}

/** At startup: load the domain and put its route back (DeployNow's container may be new). Never throws. */
export async function reconcilePlatformDomain(): Promise<void> {
  const { loadPlatformDomain } = await import("./publicOrigin");
  let domain = "";
  try {
    domain = await loadPlatformDomain();
  } catch (err) {
    console.error("[deployer] Couldn't load the platform domain:", (err as Error).message);
    return;
  }
  if (!domain) return;
  // In the background: a slow Docker socket mustn't hold up startup
  ensurePlatformRoute([domain])
    .then(() => console.log(`[deployer] Serving the UI on https://${domain} through Traefik`))
    .catch((err) => console.error(`[deployer] Couldn't route ${domain}: ${(err as Error).message}. The UI stays reachable on port 9444.`));
}
