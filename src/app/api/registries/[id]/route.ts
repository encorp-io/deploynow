import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser, type CurrentUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { canManageRegistry, RegistryError, serializeRegistry, testRegistry, validateRegistry } from "@/lib/registryAuth";

type Params = { params: Promise<{ id: string }> };
const include = { project: { select: { id: true, name: true } } } as const;

/** The login, if `user` may manage it. Someone else's personal login is a 404, not a 403. */
async function load(id: string, user: CurrentUser) {
  const r = await prisma.registry.findUnique({ where: { id }, include });
  if (!r || (r.ownerType === "personal" && r.userId !== user.id)) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!canManageRegistry(user, r)) return { error: NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 }) };
  return { r };
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const found = await load(id, gate.user);
  if (found.error) return found.error;
  try {
    const v = await validateRegistry(await readJson(request), gate.user, found.r);
    const r = await prisma.registry.update({ where: { id }, data: { ...v, ...(v.password ? { lastTestAt: null, lastTestOk: null } : {}) }, include });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "registry.update", targetType: "registry", targetId: id, message: `${gate.user.email} updated registry login ${r.name}${v.password ? " (new password)" : ""}` });
    return NextResponse.json(serializeRegistry(r, gate.user));
  } catch (err) {
    if (err instanceof RegistryError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

/** POST tests the credentials. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const found = await load(id, gate.user);
  if (found.error) return found.error;
  // Only admins may test a registry on a private address (their own LAN); metadata is refused for everyone
  const result = await testRegistry(found.r, { allowPrivate: can(gate.user, "settings.manage") });
  await prisma.registry.update({ where: { id }, data: { lastTestAt: new Date(), lastTestOk: result.ok } });
  return NextResponse.json(result);
}

/** DELETE removes it. Admins may also remove another user's personal login (offboarding). */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const r = await prisma.registry.findUnique({ where: { id } });
  const allowed = r && (canManageRegistry(gate.user, r) || (r.ownerType === "personal" && can(gate.user, "users.manage")));
  if (!r || !allowed) {
    if (r && r.ownerType === "shared") return NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const using = await prisma.application.findMany({ where: { OR: [{ registryId: id }, { pullRegistryId: id }] }, select: { name: true }, take: 5 });
  if (using.length) return NextResponse.json({ error: `Apps use this login (${using.map((a) => a.name).join(", ")}); change them first` }, { status: 409 });
  await prisma.registry.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "registry.delete", targetType: "registry", targetId: id, message: `${gate.user.email} removed registry login ${r.name}` });
  return NextResponse.json({ success: true });
}
