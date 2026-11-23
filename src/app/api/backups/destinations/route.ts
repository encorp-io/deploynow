import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { saveDestination, serializeDestination } from "@/lib/backup/service";
import { backupError } from "@/lib/backup/http";

export async function GET() {
  const gate = await requireUser("backup.view");
  if (!gate.ok) return gate.response;
  const list = await prisma.backupDestination.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json(list.map(serializeDestination));
}

export async function POST(request: Request) {
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  try {
    if (await prisma.backupDestination.findUnique({ where: { name: String(body.name ?? "").trim() } })) {
      return NextResponse.json({ error: "A destination with that name already exists" }, { status: 409 });
    }
    const d = await saveDestination(body);
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "backup.destination.create", targetType: "backup_destination", targetId: d.id, message: `${gate.user.email} added backup destination ${d.name}` });
    return NextResponse.json(serializeDestination(d), { status: 201 });
  } catch (err) {
    return backupError(err);
  }
}
