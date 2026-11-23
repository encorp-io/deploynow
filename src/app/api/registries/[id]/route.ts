import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { RegistryError, serializeRegistry, testRegistry, validateRegistry } from "@/lib/registryAuth";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const existing = await prisma.registry.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const r = await prisma.registry.update({ where: { id }, data: validateRegistry(await readJson(request), existing) });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "registry.update", targetType: "registry", targetId: id, message: `${gate.user.email} updated registry ${r.name}` });
    return NextResponse.json(serializeRegistry(r));
  } catch (err) {
    if (err instanceof RegistryError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

/** POST tests the credentials. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const r = await prisma.registry.findUnique({ where: { id } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await testRegistry(r));
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const r = await prisma.registry.findUnique({ where: { id } });
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (await prisma.application.count({ where: { registryId: id } })) return NextResponse.json({ error: "Apps build through this registry; change them first" }, { status: 409 });
  await prisma.registry.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "registry.delete", targetType: "registry", targetId: id, message: `${gate.user.email} removed registry ${r.name}` });
  return NextResponse.json({ success: true });
}
