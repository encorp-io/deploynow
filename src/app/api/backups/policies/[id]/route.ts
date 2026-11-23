import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { savePolicy, serializePolicy } from "@/lib/backup/service";
import { enqueueRun, getOrCreateRepo } from "@/lib/backup/worker";
import { backupError, ID_RE } from "@/lib/backup/http";

type Params = { params: Promise<{ id: string }> };

async function load(id: string) {
  return ID_RE.test(id) ? prisma.backupPolicy.findUnique({ where: { id }, include: { endpoint: true, destination: true } }) : null;
}

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.view");
  if (!gate.ok) return gate.response;
  const p = await load(id);
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { repo } = await getOrCreateRepo(p.destinationId, p.endpointId ?? "instance");
  return NextResponse.json({ ...serializePolicy(p), repoId: repo.id });
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  const existing = await load(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const { policy } = await savePolicy(await readJson(request), existing);
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "backup.policy.update", targetType: "backup_policy", targetId: id, endpointId: policy.endpointId ?? undefined, message: `${gate.user.email} updated backup policy ${policy.name}` });
    return NextResponse.json(serializePolicy(policy));
  } catch (err) {
    return backupError(err);
  }
}

/** POST { action: "run" } backs up now. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.run");
  if (!gate.ok) return gate.response;
  const p = await load(id);
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = await readJson(request);
  if (body.action !== "run" && body.action !== "prune") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const { repo } = await getOrCreateRepo(p.destinationId, p.endpointId ?? "instance");
  const kind = body.action === "run" ? "backup" : "prune";
  if (await prisma.backupRun.findFirst({ where: { policyId: id, kind, status: { in: ["queued", "running"] } } })) {
    return NextResponse.json({ error: "Already running" }, { status: 409 });
  }
  const run = await enqueueRun({ kind, repoId: repo.id, policyId: id, trigger: "manual", actorEmail: gate.user.email });
  return NextResponse.json({ runId: run.id }, { status: 202 });
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  const p = await load(id);
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // The snapshots stay in the repository until they are removed there
  await prisma.backupPolicy.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "backup.policy.delete", targetType: "backup_policy", targetId: id, endpointId: p.endpointId ?? undefined, message: `${gate.user.email} removed backup policy ${p.name}` });
  return NextResponse.json({ success: true });
}
