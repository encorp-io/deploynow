import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { performUpdate } from "@/lib/polling";
import { requireUser, readJson } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import { clientIp } from "@/lib/audit";

// cuid v1 pattern: all Prisma-generated IDs match this
const CUID_PATTERN = /^c[a-z0-9]{24}$/;

export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const { serviceId } = await readJson(request);
  if (!serviceId || typeof serviceId !== "string" || !CUID_PATTERN.test(serviceId)) {
    return NextResponse.json({ error: "Invalid serviceId" }, { status: 400 });
  }

  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) return NextResponse.json({ error: "Service not found" }, { status: 404 });
  if (!can(gate.user, "service.update", { endpointId: service.endpointId ?? undefined })) {
    return NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 });
  }

  try {
    await performUpdate(serviceId, { id: gate.user.id, email: gate.user.email }, clientIp(request));
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
