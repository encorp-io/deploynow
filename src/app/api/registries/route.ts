import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { RegistryError, serializeRegistry, validateRegistry } from "@/lib/registryAuth";

export async function GET() {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  return NextResponse.json((await prisma.registry.findMany({ orderBy: { name: "asc" } })).map(serializeRegistry));
}

export async function POST(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  try {
    const v = validateRegistry(await readJson(request));
    if (await prisma.registry.findUnique({ where: { name: v.name } })) return NextResponse.json({ error: "A registry with that name already exists" }, { status: 409 });
    const r = await prisma.registry.create({ data: { ...v, password: v.password! } });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "registry.create", targetType: "registry", targetId: r.id, message: `${gate.user.email} added registry ${r.name} (${r.host})` });
    return NextResponse.json(serializeRegistry(r), { status: 201 });
  } catch (err) {
    if (err instanceof RegistryError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
