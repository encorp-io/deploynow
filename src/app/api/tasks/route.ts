import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { nextRun } from "@/lib/backup/config";
import { validateTask } from "@/lib/tasks";
import { backupError } from "@/lib/backup/http";

export async function GET(request: Request) {
  const gate = await requireUser("task.view");
  if (!gate.ok) return gate.response;
  const endpointId = new URL(request.url).searchParams.get("endpointId");
  const tasks = await prisma.scheduledTask.findMany({ where: endpointId ? { endpointId } : {}, include: { endpoint: { select: { name: true } } }, orderBy: { name: "asc" } });
  return NextResponse.json(tasks.map((t) => ({ ...t, endpointName: t.endpoint.name, endpoint: undefined })));
}

export async function POST(request: Request) {
  const gate = await requireUser("task.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  try {
    const endpointId = String(body.endpointId ?? "");
    if (!(await prisma.endpoint.findUnique({ where: { id: endpointId } }))) return NextResponse.json({ error: "Choose an endpoint" }, { status: 400 });
    const v = validateTask(body);
    const task = await prisma.scheduledTask.create({ data: { ...v, endpointId, nextRunAt: v.enabled ? nextRun(v.schedule) : null } });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "task.create", targetType: "task", targetId: task.id, endpointId, message: `${gate.user.email} created scheduled task ${task.name}` });
    return NextResponse.json(task, { status: 201 });
  } catch (err) {
    return backupError(err);
  }
}
