import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireStepUp, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { saveDestination, serializeDestination, testDestination } from "@/lib/backup/service";
import { backupError, ID_RE } from "@/lib/backup/http";

type Params = { params: Promise<{ id: string }> };

async function load(id: string) {
  return ID_RE.test(id) ? prisma.backupDestination.findUnique({ where: { id } }) : null;
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  const existing = await load(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const d = await saveDestination(await readJson(request), existing);
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "backup.destination.update", targetType: "backup_destination", targetId: id, message: `${gate.user.email} updated backup destination ${d.name}` });
    return NextResponse.json(serializeDestination(d));
  } catch (err) {
    return backupError(err);
  }
}

/** POST tests the saved destination's credentials. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  const d = await load(id);
  if (!d) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return NextResponse.json(await testDestination(d));
  } catch (err) {
    return backupError(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  const stepUp = requireStepUp(gate.user);
  if (stepUp) return stepUp;
  const d = await load(id);
  if (!d) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Removes the policies and DeployNow's record of the repositories; the data in the bucket stays
  await prisma.backupDestination.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "backup.destination.delete", targetType: "backup_destination", targetId: id, message: `${gate.user.email} removed backup destination ${d.name}` });
  return NextResponse.json({ success: true });
}
