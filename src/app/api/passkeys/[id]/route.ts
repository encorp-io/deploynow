import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireStepUp, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { serializePasskey } from "@/lib/passkeys";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const name = String((await readJson(request)).name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: "Give the passkey a name" }, { status: 400 });
  const res = await prisma.passkey.updateMany({ where: { id, userId: gate.user.id }, data: { name } });
  if (!res.count) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(serializePasskey(await prisma.passkey.findUniqueOrThrow({ where: { id } })));
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const stepUp = requireStepUp(gate.user);
  if (stepUp) return stepUp;
  const p = await prisma.passkey.findFirst({ where: { id, userId: gate.user.id } });
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.passkey.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "passkey.delete", targetType: "user", targetId: gate.user.id, message: `${gate.user.email} removed passkey "${p.name}"` });
  return NextResponse.json({ success: true });
}
