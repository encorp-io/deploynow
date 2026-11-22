import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireStepUp, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { serializeProvider, SsoError, validateProvider } from "@/lib/sso";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const existing = await prisma.ssoProvider.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const p = await prisma.ssoProvider.update({ where: { id }, data: validateProvider(await readJson(request), existing) });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "sso.update", targetType: "sso", targetId: id, message: `${gate.user.email} updated sign-in with ${p.name}` });
    return NextResponse.json(serializeProvider(p));
  } catch (err) {
    if (err instanceof SsoError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const stepUp = requireStepUp(gate.user);
  if (stepUp) return stepUp;
  const p = await prisma.ssoProvider.findUnique({ where: { id } });
  if (!p) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.ssoProvider.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "sso.delete", targetType: "sso", targetId: id, message: `${gate.user.email} removed sign-in with ${p.name}` });
  return NextResponse.json({ success: true });
}
