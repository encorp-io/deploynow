import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { canPlaceOn, PLACE_DENIED } from "@/lib/apps/placement";
import { ID_RE, notFound, projectGate } from "@/lib/apps/access";

type Params = { params: Promise<{ id: string }> };

async function load(id: string) {
  return ID_RE.test(id) ? prisma.environment.findUnique({ where: { id } }) : null;
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const env = await load(id);
  if (!env) return notFound("Environment");
  const gate = await projectGate(env.projectId, "app.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const defaultEndpointId = typeof body.endpointId === "string" && body.endpointId ? body.endpointId : null;
  if (defaultEndpointId && !(await prisma.endpoint.findUnique({ where: { id: defaultEndpointId } }))) return notFound("Endpoint");
  if (defaultEndpointId && defaultEndpointId !== env.defaultEndpointId && !canPlaceOn(gate.user, defaultEndpointId)) return NextResponse.json({ error: PLACE_DENIED }, { status: 403 });
  const updated = await prisma.environment.update({ where: { id }, data: { defaultEndpointId } });
  return NextResponse.json(updated);
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const env = await load(id);
  if (!env) return notFound("Environment");
  const gate = await projectGate(env.projectId, "app.manage");
  if (!gate.ok) return gate.response;
  const apps = await prisma.application.count({ where: { environmentId: id } });
  if (apps) return NextResponse.json({ error: "Delete or move this environment's apps first" }, { status: 409 });
  const others = await prisma.environment.count({ where: { projectId: env.projectId, NOT: { id } } });
  if (!others) return NextResponse.json({ error: "A project keeps at least one environment" }, { status: 409 });
  await prisma.environment.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "environment.delete", message: `${gate.user.email} deleted environment ${env.name} of ${gate.project.name}`, targetType: "project", targetId: env.projectId });
  return NextResponse.json({ success: true });
}
