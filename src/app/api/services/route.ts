import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncServices } from "@/lib/polling";
import { requireUser, readJson } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";

async function listServices(user: Parameters<typeof can>[0]) {
  const services = await prisma.service.findMany({
    where: { endpointId: { not: null } },
    include: { endpoint: { select: { id: true, name: true, status: true } } },
    orderBy: { containerName: "asc" },
  });
  return services.filter((s) => can(user, "endpoint.view", { endpointId: s.endpointId ?? undefined }));
}

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  return NextResponse.json(await listServices(gate.user));
}

export async function POST(request: Request) {
  const gate = await requireUser("polling.run");
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  if (body.action === "sync") {
    await syncServices();
    return NextResponse.json(await listServices(gate.user));
  }
  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
