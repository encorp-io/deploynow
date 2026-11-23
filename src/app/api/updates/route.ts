import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { checkEnabledByEnv, checkForUpdate, updateStatus } from "@/lib/updates";

/** GET /api/updates: the running version and the newest release DeployNow knows about. */
export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const status = await updateStatus();
  // Release notes and settings are for admins; everyone else sees the version only
  if (!["admin", "owner"].includes(gate.user.role)) return NextResponse.json({ current: status.current });
  return NextResponse.json({ ...status, envDisabled: !checkEnabledByEnv() });
}

/** POST /api/updates: { check: true } checks GitHub now; { enabled } turns the daily check on or off. */
export async function POST(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  if (typeof body.enabled === "boolean") {
    await prisma.settings.upsert({ where: { id: "singleton" }, update: { releaseCheck: body.enabled }, create: { id: "singleton", releaseCheck: body.enabled } });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "settings.update", message: `${gate.user.email} turned release checks ${body.enabled ? "on" : "off"}` });
  }
  if (body.check === true) {
    if (!checkEnabledByEnv()) return NextResponse.json({ error: "Release checks are off (DEPLOYNOW_UPDATE_CHECK=off)" }, { status: 400 });
    try {
      return NextResponse.json({ ...(await checkForUpdate()), envDisabled: false });
    } catch (err) {
      return NextResponse.json({ error: `Couldn't reach GitHub: ${(err as Error).message}` }, { status: 502 });
    }
  }
  return NextResponse.json({ ...(await updateStatus()), envDisabled: !checkEnabledByEnv() });
}
