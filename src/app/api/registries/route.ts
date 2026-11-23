import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { canManageRegistry, RegistryError, serializeRegistry, validateRegistry, visibleRegistries } from "@/lib/registryAuth";

/**
 * GET lists your personal logins and every shared one (credentials masked).
 * ?projectId= narrows it to the logins an app in that project may use.
 */
export async function GET(request?: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const projectId = request ? new URL(request.url).searchParams.get("projectId") ?? undefined : undefined;
  const rows = await visibleRegistries(gate.user, { projectId });
  return NextResponse.json(rows.map((r) => serializeRegistry(r, gate.user)));
}

/** POST adds a login: { ownerType: "personal" | "shared", projectId?, name, host, username, password, namespace? } */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  try {
    const v = await validateRegistry(await readJson(request), gate.user);
    if (!canManageRegistry(gate.user, v)) {
      return NextResponse.json({ error: v.projectId ? "Only admins of this project can add its shared logins" : "Only admins can add shared logins" }, { status: 403 });
    }
    const r = await prisma.registry.create({ data: { ...v, password: v.password!, createdBy: gate.user.email }, include: { project: { select: { id: true, name: true } } } });
    const kind = r.ownerType === "personal" ? "personal login" : r.projectId ? `shared login for project ${r.project?.name}` : "shared login";
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "registry.create", targetType: "registry", targetId: r.id, message: `${gate.user.email} added ${kind} ${r.name} (${r.host})` });
    return NextResponse.json(serializeRegistry(r, gate.user), { status: 201 });
  } catch (err) {
    if (err instanceof RegistryError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
