import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireStepUp } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { projectGate } from "@/lib/apps/access";
import { can } from "@/lib/rbac";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const gate = await projectGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const environments = await prisma.environment.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "asc" },
    include: {
      defaultEndpoint: { select: { id: true, name: true } },
      applications: {
        orderBy: { name: "asc" },
        include: {
          endpoint: { select: { id: true, name: true } },
          domains: { select: { host: true, path: true, https: true } },
          deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, createdAt: true, finishedAt: true, commitSha: true } },
        },
      },
    },
  });
  return NextResponse.json({
    ...gate.project,
    canManage: can(gate.user, "app.manage", { projectId: id }),
    environments: environments.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      defaultEndpoint: e.defaultEndpoint,
      apps: e.applications.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        sourceType: a.sourceType,
        status: a.status,
        image: a.image,
        gitRepo: a.gitRepo,
        endpoint: a.endpoint,
        domains: a.domains,
        lastDeployment: a.deployments[0] ?? null,
      })),
    })),
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await projectGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const data: { name?: string; description?: string } = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 64) return NextResponse.json({ error: "Give the project a name (up to 64 characters)" }, { status: 400 });
    if (name !== gate.project.name && (await prisma.project.findUnique({ where: { name } }))) {
      return NextResponse.json({ error: "A project with that name already exists" }, { status: 409 });
    }
    data.name = name;
  }
  if (body.description !== undefined) data.description = String(body.description).slice(0, 500);
  const project = await prisma.project.update({ where: { id }, data });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "project.update", message: `${gate.user.email} updated project ${project.name}`, targetType: "project", targetId: id });
  return NextResponse.json(project);
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await projectGate(id, "project.manage");
  if (!gate.ok) return gate.response;
  const stepUp = requireStepUp(gate.user);
  if (stepUp) return stepUp;
  const apps = await prisma.application.count({ where: { environment: { projectId: id } } });
  if (apps) return NextResponse.json({ error: `Delete the project's ${apps} app${apps === 1 ? "" : "s"} first` }, { status: 409 });
  await prisma.$transaction([
    prisma.roleBinding.deleteMany({ where: { scopeType: "project", scopeId: id } }),
    prisma.project.delete({ where: { id } }),
  ]);
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "project.delete", message: `${gate.user.email} deleted project ${gate.project.name}`, targetType: "project", targetId: id });
  return NextResponse.json({ success: true });
}
