import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { projectGate } from "@/lib/apps/access";
import { slugify, SLUG_RE } from "@/lib/apps/config";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await projectGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const name = String(body.name ?? "").trim().toLowerCase();
  if (!name || name.length > 32) return NextResponse.json({ error: "Name the environment, e.g. staging" }, { status: 400 });
  const slug = slugify(name);
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "Invalid environment name" }, { status: 400 });
  if (await prisma.environment.findUnique({ where: { projectId_slug: { projectId: id, slug } } })) {
    return NextResponse.json({ error: "That environment already exists" }, { status: 409 });
  }
  const defaultEndpointId = typeof body.endpointId === "string" && body.endpointId ? body.endpointId : null;
  if (defaultEndpointId && !(await prisma.endpoint.findUnique({ where: { id: defaultEndpointId } }))) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }
  const env = await prisma.environment.create({ data: { projectId: id, name, slug, defaultEndpointId } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "environment.create", message: `${gate.user.email} added environment ${name} to ${gate.project.name}`, targetType: "project", targetId: id });
  return NextResponse.json(env, { status: 201 });
}
