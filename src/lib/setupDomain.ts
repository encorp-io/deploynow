/**
 * DEPLOYNOW_DOMAIN: serve the UI on a domain from the first start, without
 * going through Settings → Domain. setup.sh writes it to .env.
 *
 * At startup, in the background: if no domain is stored yet, turn on the managed
 * edge proxy (Traefik with Let's Encrypt) on the local endpoint when it has none,
 * route the domain, wait for it to answer with a valid certificate and make it
 * the public address. It's tried once per domain value: once it worked, or once
 * someone set or removed a domain in Settings, the variable is left alone.
 * A failed attempt (DNS not pointed yet, ports closed) is retried at the next
 * start, and the UI stays on port 9444 meanwhile.
 */
import fs from "fs";
import path from "path";
import { prisma } from "./prisma";
import { dataDir } from "./paths";
import { audit } from "./audit";
import { installProxy } from "./deploy/proxy";
import { platformDomainIgnored } from "./publicOrigin";
import {
  DomainError,
  ensurePlatformRoute,
  findLocalTarget,
  probeDomain,
  saveActiveDomain,
  validatePlatformDomain,
} from "./platformDomain";

const MARKER = "setup-domain.json";
const PROXY_NETWORK = "deploynow";

interface Marker {
  domain: string;
  done: boolean;
  message?: string;
  at?: string;
}

function markerPath(): string {
  return path.join(dataDir(), MARKER);
}

export function readMarker(file = markerPath()): Marker | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Marker;
  } catch {
    return null;
  }
}

function writeMarker(m: Marker, file = markerPath()): void {
  try {
    fs.writeFileSync(file, JSON.stringify({ ...m, at: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error("[deployer] Couldn't write", file, (err as Error).message);
  }
}

/** What to do with DEPLOYNOW_DOMAIN given the stored domain and the marker. Pure, for tests. */
export function setupDomainPlan(
  raw: string | undefined,
  stored: string,
  marker: Marker | null,
): { action: "skip"; reason: string } | { action: "apply"; domain: string } {
  const value = (raw ?? "").trim();
  if (!value) return { action: "skip", reason: "not set" };
  let domain: string;
  try {
    domain = validatePlatformDomain(value);
  } catch (err) {
    return { action: "skip", reason: `DEPLOYNOW_DOMAIN: ${(err as Error).message}` };
  }
  if (stored === domain) return { action: "skip", reason: "already active" };
  if (marker?.domain === domain && marker.done) return { action: "skip", reason: "already applied once" };
  // Someone set a domain in Settings: theirs wins
  if (stored) return { action: "skip", reason: `Settings → Domain already uses ${stored}` };
  return { action: "apply", domain };
}

export async function applySetupDomain(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (platformDomainIgnored()) return;
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { platformDomain: true } });
  const stored = settings?.platformDomain ?? "";
  const plan = setupDomainPlan(env.DEPLOYNOW_DOMAIN, stored, readMarker());
  if (plan.action === "skip") {
    if (plan.reason.startsWith("DEPLOYNOW_DOMAIN:")) console.error(`[deployer] ${plan.reason}`);
    // A domain that is already active counts as applied, so removing it later sticks
    if (plan.reason === "already active") writeMarker({ domain: stored, done: true });
    return;
  }
  const { domain } = plan;

  // Take the trial route down, but keep the route of a domain someone activated in
  // Settings meanwhile (the probe below can take minutes)
  const restoreRoute = async () => {
    const now = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { platformDomain: true } }).catch(() => null);
    await ensurePlatformRoute(now?.platformDomain ? [now.platformDomain] : []).catch(() => {});
  };

  const fail = (message: string) => {
    console.error(`[deployer] Couldn't set up https://${domain} yet: ${message} The UI stays on port 9444; it's tried again at the next start, or finish it under Settings → Domain.`);
    writeMarker({ domain, done: false, message });
  };

  console.log(`[deployer] Setting up https://${domain} (DEPLOYNOW_DOMAIN)`);
  let target = await findLocalTarget().catch(() => null);
  if (!target) return fail("DeployNow can't find its own container through the Docker socket.");

  try {
    if (target.endpoint.proxyMode === "none") {
      const email = (env.ACME_EMAIL || env.ADMIN_EMAIL || "").trim();
      if (!email || /@example\.(com|org|net)$/i.test(email)) {
        return fail("Let's Encrypt needs a real email: set ACME_EMAIL (or ADMIN_EMAIL) in .env.");
      }
      console.log(`[deployer] Starting the edge proxy (Traefik) on ports 80 and 443`);
      await installProxy(target.docker, { email, network: PROXY_NETWORK, challenge: "http" });
      const endpoint = await prisma.endpoint.update({
        where: { id: target.endpoint.id },
        data: { proxyMode: "managed", proxyNetwork: PROXY_NETWORK, proxyEmail: email, proxyError: "", proxyChallenge: "http", proxyDnsToken: "" },
      });
      target = { ...target, endpoint };
    }
    await ensurePlatformRoute([domain], target);
  } catch (err) {
    if (!(err instanceof DomainError)) console.error("[deployer] Domain setup failed:", err);
    await restoreRoute();
    return fail((err as Error).message);
  }

  // Let's Encrypt usually issues within a minute; allow for slow DNS
  const probe = await probeDomain(domain, 180_000);
  if (!probe.reachable || !probe.certificateValid) {
    await restoreRoute();
    return fail(probe.message);
  }
  // Settings won the race: leave its domain in place
  const latest = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { platformDomain: true } });
  if (latest?.platformDomain && latest.platformDomain !== domain) {
    await restoreRoute();
    writeMarker({ domain, done: true });
    return;
  }
  await saveActiveDomain(domain);
  writeMarker({ domain, done: true });
  await audit({ action: "settings.domain", message: `Platform domain set to ${domain} from DEPLOYNOW_DOMAIN` });
  console.log(`[deployer] DeployNow is now on https://${domain}`);
}
