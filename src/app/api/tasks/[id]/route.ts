import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { nextRun } from "@/lib/backup/config";
import { isTaskRunning, runTask, validateTask } from "@/lib/tasks";
import { backupError, ID_RE } from "@/lib/backup/http";

type Params = { params: Promise<{ id: string }> };

async function load(id: string) {
  return ID_RE.test(id) ? prisma.scheduledTask.findUnique({ where: { id } }) : null;
}

/** GET returns the task and its recent runs. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("task.view");
  if (!gate.ok) return gate.response;
  const task = await load(id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const runs = await prisma.taskRun.findMany({ where: { taskId: id }, orderBy: { startedAt: "desc" }, take: 20 });
  return NextResponse.json({ ...task, running: isTaskRunning(id), runs });
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("task.manage");
  if (!gate.ok) return gate.response;
  const existing = await load(id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const v = validateTask(await readJson(request), existing);
    const task = await prisma.scheduledTask.update({ where: { id }, data: { ...v, nextRunAt: v.enabled ? nextRun(v.schedule) : null } });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "task.update", targetType: "task", targetId: id, endpointId: task.endpointId, message: `${gate.user.email} updated scheduled task ${task.name}` });
    return NextResponse.json(task);
  } catch (err) {
    return backupError(err);
  }
}

/** POST runs the task now and returns when it finishes (or 202 if it takes longer than 25 s). */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("task.run");
  if (!gate.ok) return gate.response;
  const task = await load(id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (isTaskRunning(id)) return NextResponse.json({ error: "Already running" }, { status: 409 });
  const p = runTask(id, "manual", gate.user.email);
  const result = await Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), 25_000))]);
  if (result === "pending") return NextResponse.json({ status: "running" }, { status: 202 });
  return NextResponse.json(result);
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("task.manage");
  if (!gate.ok) return gate.response;
  const task = await load(id);
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.scheduledTask.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "task.delete", targetType: "task", targetId: id, endpointId: task.endpointId, message: `${gate.user.email} removed scheduled task ${task.name}` });
  return NextResponse.json({ success: true });
}
