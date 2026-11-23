import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireStepUp, requireUser } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import { audit, clientIp } from "@/lib/audit";
import { snapshotsFor, takeKit } from "@/lib/backup/service";
import { enqueueRun } from "@/lib/backup/worker";
import { backupError, ID_RE } from "@/lib/backup/http";

type Params = { params: Promise<{ id: string }> };

/** GET lists the repository's snapshots. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.view");
  if (!gate.ok) return gate.response;
  if (!ID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return NextResponse.json(await snapshotsFor(id));
  } catch (err) {
    return backupError(err);
  }
}

/**
 * POST { action }:
 *  - kit: the recovery kit (once; admins, with step-up)
 *  - check, drill: queue a repository check or restore drill
 *  - restore: { snapshotId, target, endpointId?, name?, overwrite? } (admins, with step-up)
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.run");
  if (!gate.ok) return gate.response;
  const { user } = gate;
  const repo = ID_RE.test(id) ? await prisma.backupRepo.findUnique({ where: { id } }) : null;
  if (!repo) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(request);
  const actor = { id: user.id, email: user.email };
  try {
    if (body.action === "kit") {
      if (!can(user, "backup.manage")) return NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 });
      const stepUp = requireStepUp(user);
      if (stepUp) return stepUp;
      const kit = await takeKit(id);
      await audit({ actor, ip: clientIp(request), action: "backup.kit", targetType: "backup_repo", targetId: id, message: `${user.email} viewed the recovery kit for a backup repository` });
      return NextResponse.json({ kit });
    }
    if (body.action === "check" || body.action === "drill") {
      if (await prisma.backupRun.findFirst({ where: { repoId: id, kind: body.action, status: { in: ["queued", "running"] } } })) {
        return NextResponse.json({ error: "Already queued" }, { status: 409 });
      }
      const run = await enqueueRun({ kind: body.action, repoId: id, trigger: "manual", actorEmail: user.email });
      return NextResponse.json({ runId: run.id }, { status: 202 });
    }
    if (body.action === "restore") {
      if (!can(user, "backup.restore")) return NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 });
      const stepUp = requireStepUp(user);
      if (stepUp) return stepUp;
      const target = String(body.target ?? "");
      if (!["same", "volume", "path", "container"].includes(target)) return NextResponse.json({ error: "Choose where to restore to" }, { status: 400 });
      const snapshotId = String(body.snapshotId ?? "");
      if (!/^[0-9a-f]{8,64}$/.test(snapshotId)) return NextResponse.json({ error: "Invalid snapshot id" }, { status: 400 });
      const endpointId = body.endpointId ? String(body.endpointId) : undefined;
      if (endpointId && !can(user, "container.control", { endpointId })) return NextResponse.json({ error: "You can't restore to that endpoint" }, { status: 403 });
      const params = { snapshotId, target, endpointId, name: body.name ? String(body.name).slice(0, 500) : undefined, overwrite: Boolean(body.overwrite) };
      const run = await enqueueRun({ kind: "restore", repoId: id, trigger: "manual", params, actorEmail: user.email });
      await audit({ actor, ip: clientIp(request), action: "backup.restore.start", targetType: "backup_repo", targetId: id, endpointId: endpointId ?? (repo.scope === "instance" ? undefined : repo.scope), message: `${user.email} started a restore of snapshot ${snapshotId.slice(0, 8)}`, details: JSON.stringify(params) });
      return NextResponse.json({ runId: run.id }, { status: 202 });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return backupError(err);
  }
}
