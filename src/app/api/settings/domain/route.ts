import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { envOrigin, platformDomain, platformDomainIgnored, requestOrigin } from "@/lib/publicOrigin";
import {
  DomainError,
  UI_HTTP_PORT,
  ensurePlatformRoute,
  findLocalTarget,
  passkeysOffDomain,
  platformRouteStatus,
  probeDomain,
  resolveDomain,
  saveActiveDomain,
  validatePlatformDomain,
} from "@/lib/platformDomain";

export const maxDuration = 120;

async function storedDomain(): Promise<string> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { platformDomain: true } });
  return s?.platformDomain ?? "";
}

export async function GET(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const stored = await storedDomain();
  const [route, passkeys] = await Promise.all([platformRouteStatus(), prisma.passkey.count()]);
  return NextResponse.json({
    domain: stored,
    active: platformDomain(),
    ignored: platformDomainIgnored() && !!stored,
    envOrigin: envOrigin(),
    currentOrigin: requestOrigin(request),
    fallbackPort: 9444,
    uiHttpPort: UI_HTTP_PORT,
    route,
    passkeys,
  });
}

/**
 * {action: "check", domain}: look up DNS, route the domain and probe it. Switches nothing.
 * {action: "activate", domain, confirmPasskeys?, force?}: the same, then make it the
 * public address. force skips the probe (the server can't always reach its own domain).
 */
export async function POST(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const { user } = gate;
  const body = await readJson(request);
  const action = body.action === "activate" ? "activate" : "check";
  let domain: string;
  try {
    domain = validatePlatformDomain(body.domain);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  if (await prisma.domain.findFirst({ where: { host: domain } })) {
    return NextResponse.json({ error: `${domain} is already routed to an app. Remove it there first.` }, { status: 409 });
  }

  const active = await storedDomain();
  const result: { domain: string; addresses: string[]; reachable: boolean; certificateValid: boolean; message: string; stage: string } = {
    domain,
    addresses: [],
    reachable: false,
    certificateValid: false,
    message: "",
    stage: "dns",
  };

  try {
    result.addresses = await resolveDomain(domain);
    result.stage = "route";
    const target = await findLocalTarget();
    await ensurePlatformRoute([active, domain], target);
    result.stage = "probe";
    const probe = await probeDomain(domain, action === "activate" ? 20_000 : 45_000);
    Object.assign(result, probe);
  } catch (err) {
    if (!(err instanceof DomainError)) console.error("[deployer] Domain check failed:", err);
    result.message = (err as Error).message;
    // Put the route back the way it was
    if (result.stage !== "dns") await ensurePlatformRoute([active]).catch(() => {});
    return NextResponse.json({ ...result, error: result.message }, { status: 422 });
  }

  if (action === "check") return NextResponse.json(result);

  const ok = result.reachable && result.certificateValid;
  if (!ok && body.force !== true) {
    return NextResponse.json({ ...result, error: result.message, canForce: true }, { status: 422 });
  }
  const offDomain = await passkeysOffDomain(domain);
  if (offDomain > 0 && body.confirmPasskeys !== true) {
    return NextResponse.json({ ...result, error: "Confirm the passkey change first", passkeysOffDomain: offDomain, needsConfirm: true }, { status: 409 });
  }

  await ensurePlatformRoute([domain]).catch(() => {});
  await saveActiveDomain(domain);
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "settings.domain",
    message: `${user.email} set the platform domain to ${domain}${active ? ` (was ${active})` : ""}${ok ? "" : " without a successful check"}`,
  });
  return NextResponse.json({ ...result, activated: true, url: `https://${domain}` });
}

/** Stop using the domain: back to AUTH_URL or the address each request comes in on. */
export async function DELETE(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const active = await storedDomain();
  await saveActiveDomain("");
  let warning = "";
  try {
    await ensurePlatformRoute([]);
  } catch (err) {
    warning = `The domain is no longer used, but its route couldn't be removed: ${(err as Error).message}`;
  }
  if (active) {
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "settings.domain", message: `${gate.user.email} removed the platform domain ${active}` });
  }
  return NextResponse.json({ success: true, warning });
}
