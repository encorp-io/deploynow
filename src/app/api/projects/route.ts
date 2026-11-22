import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { visibleProjectFilter } from "@/lib/apps/access";
import { slugify, SLUG_RE } from "@/lib/apps/config";

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const projects = await prisma.project.findMany({
    where: visibleProjectFilter(gate.user),
    orderBy: { name: "asc" },
    include: {
      environments: {
        orderBy: { createdAt: "asc" },
        include: { applications: { select: { id: true, name: true, status: true, sourceType: true, endpointId: true } } },
      },
    },
  });
  return NextResponse.json(
    projects.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      environments: p.environments.map((e) => ({ id: e.id, name: e.name, slug: e.slug, defaultEndpointId: e.defaultEndpointId, apps: e.applications })),
    })),
  );
}

export async function POST(request: Request) {
  const gate = await requireUser("project.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 64) return NextResponse.json({ error: "Give the project a name (up to 64 characters)" }, { status: 400 });
  const slug = String(body.slug ?? "").trim() || slugify(name);
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "The short name may use lowercase letters, digits and dashes" }, { status: 400 });
  if (await prisma.project.findFirst({ where: { OR: [{ name }, { slug }] } })) {
    return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
  }
  const defaultEndpointId = typeof body.endpointId === "string" && body.endpointId ? body.endpointId : null;
  if (defaultEndpointId && !(await prisma.endpoint.findUnique({ where: { id: defaultEndpointId } }))) {
    return NextResponse.json({ error: "Endpoint not found" }, { status: 404 });
  }
  const project = await prisma.project.create({
    data: {
      name,
      slug,
      description: String(body.description ?? "").slice(0, 500),
      environments: { create: { name: "production", slug: "production", defaultEndpointId } },
    },
    include: { environments: true },
  });
  await audit({
    actor: { id: gate.user.id, email: gate.user.email },
    ip: clientIp(request),
    action: "project.create",
    message: `${gate.user.email} created project ${name}`,
    targetType: "project",
    targetId: project.id,
  });
  return NextResponse.json(project, { status: 201 });
}
