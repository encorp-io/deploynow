import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { checkEnabledByEnv, checkForUpdate, updateStatus } from "@/lib/updates";
import { SelfUpdateError, selfUpdateEnabledByEnv, selfUpdateInfo, startSelfUpdate } from "@/lib/selfUpdate";

async function full() {
  const status = await updateStatus();
  const self = await selfUpdateInfo(status.latest).catch((err) => ({ supported: false, reason: (err as Error).message, image: "", pinned: false, auto: false, hour: -1, status: null }));
  return { ...status, envDisabled: !checkEnabledByEnv(), selfUpdate: { ...self, envDisabled: !selfUpdateEnabledByEnv() } };
}

/** GET /api/updates: the running version, the newest release DeployNow knows about, and self-update. */
export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  // Release notes and settings are for admins; everyone else sees the version only
  if (!["admin", "owner"].includes(gate.user.role)) return NextResponse.json({ current: (await updateStatus()).current });
  return NextResponse.json(await full());
}

/**
 * POST /api/updates
 *   { check: true }               check GitHub now
 *   { enabled }                   release checks on or off
 *   { install: true }             update DeployNow now (pull, then hand over to the updater container)
 *   { auto, hour }                auto-update on or off, and the hour of day it may run in (-1 = any)
 */
export async function POST(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const actor = { id: gate.user.id, email: gate.user.email };
  const ip = clientIp(request);
  if (typeof body.enabled === "boolean") {
    await prisma.settings.upsert({ where: { id: "singleton" }, update: { releaseCheck: body.enabled }, create: { id: "singleton", releaseCheck: body.enabled } });
    await audit({ actor, ip, action: "settings.update", message: `${gate.user.email} turned release checks ${body.enabled ? "on" : "off"}` });
  }
  if (typeof body.auto === "boolean" || body.hour !== undefined) {
    const data: { selfUpdateAuto?: boolean; selfUpdateHour?: number } = {};
    if (typeof body.auto === "boolean") data.selfUpdateAuto = body.auto;
    if (body.hour !== undefined) {
      const hour = Number(body.hour);
      if (!Number.isInteger(hour) || hour < -1 || hour > 23) return NextResponse.json({ error: "Pick an hour from 0 to 23, or any time" }, { status: 400 });
      data.selfUpdateHour = hour;
    }
    const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
    await audit({
      actor,
      ip,
      action: "settings.update",
      message: `${gate.user.email} turned auto-update ${s.selfUpdateAuto ? "on" : "off"}${s.selfUpdateAuto && s.selfUpdateHour >= 0 ? ` (${String(s.selfUpdateHour).padStart(2, "0")}:00–${String(s.selfUpdateHour).padStart(2, "0")}:59)` : ""}`,
    });
  }
  if (body.check === true) {
    if (!checkEnabledByEnv()) return NextResponse.json({ error: "Release checks are off (DEPLOYNOW_UPDATE_CHECK=off)" }, { status: 400 });
    try {
      await checkForUpdate();
    } catch (err) {
      return NextResponse.json({ error: `Couldn't reach GitHub: ${(err as Error).message}` }, { status: 502 });
    }
  }
  if (body.install === true) {
    try {
      await startSelfUpdate({ actor, ip });
    } catch (err) {
      const e = err as SelfUpdateError;
      const code = e instanceof SelfUpdateError ? ({ busy: 409, current: 409, disabled: 400, unsupported: 400, pull: 502, docker: 500 } as const)[e.code] : 500;
      return NextResponse.json({ error: e.message || "Update failed" }, { status: code });
    }
  }
  return NextResponse.json(await full());
}
