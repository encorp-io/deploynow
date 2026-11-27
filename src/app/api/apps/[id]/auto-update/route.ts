import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { appGate } from "@/lib/apps/access";
import { checkApp, describeWindow, inWindow, serializeRun, serverTimezone } from "@/lib/apps/autoUpdate";

type Params = { params: Promise<{ id: string }> };

/** Auto-update status of an app: the window, the last check and the recent automatic updates. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const { app } = gate;
  const runs = await prisma.autoUpdateRun.findMany({ where: { applicationId: id }, orderBy: { createdAt: "desc" }, take: 20 });
  return NextResponse.json({
    enabled: app.autoUpdate,
    serverTimezone: serverTimezone(),
    window: describeWindow(app),
    inWindowNow: inWindow(new Date(), app),
    checkedAt: app.autoUpdateCheckedAt,
    pending: app.autoUpdatePending,
    error: app.autoUpdateError,
    runs: runs.map(serializeRun),
  });
}

/**
 * Check now: { action: "check" } looks for an update right away (it still waits for the
 * maintenance window); { action: "retry" } also forgets the update that failed last time.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.deploy");
  if (!gate.ok) return gate.response;
  const { app, user } = gate;
  if (!app.autoUpdate) return NextResponse.json({ error: "Turn on auto-update for this app first" }, { status: 400 });
  const body = await readJson(request);
  const retry = body.action === "retry";
  if (retry) await prisma.application.update({ where: { id }, data: { autoUpdateSkip: "" } });
  const result = await checkApp(id);
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "app.auto_update_check",
    message: `${user.email} ${retry ? "retried" : "ran"} the auto-update check of ${app.name}`,
    targetType: "application",
    targetId: id,
    endpointId: app.endpointId,
    outcome: result.state === "error" ? "failure" : "success",
    details: result.summary,
  });
  return NextResponse.json(result);
}
