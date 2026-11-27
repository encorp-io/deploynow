import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireStepUp } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { appGate, serializeApp, serializeDeployment, type AppWithRelations } from "@/lib/apps/access";
import { ConfigError, validateAppInput } from "@/lib/apps/config";
import { validateAppExtras } from "@/lib/apps/extras";
import { validateAutoUpdateInput } from "@/lib/apps/autoUpdate";
import { removePreview } from "@/lib/apps/previews";
import { EnvError } from "@/lib/apps/env";
import { can } from "@/lib/rbac";
import { dockerFor } from "@/lib/endpoints";
import { withTimeout } from "@/lib/docker/client";
import { teardownApplication } from "@/lib/deploy/runner";
import { removeLog } from "@/lib/deploy/log";

type Params = { params: Promise<{ id: string }> };

async function liveContainers(app: AppWithRelations) {
  try {
    const docker = dockerFor(app.endpoint);
    const filter = app.sourceType === "compose" || app.sourceType === "git-compose" ? `com.docker.compose.project=${app.slug}` : `deploynow.app=${app.id}`;
    const list = await withTimeout(docker.listContainers({ all: true, filters: { label: [filter] } }), 8000, "Listing containers");
    return list.map((c) => ({
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      service: c.Labels["com.docker.compose.service"] ?? "",
      image: c.Image,
      state: c.State,
      status: c.Status,
    }));
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const { app, user } = gate;
  const projectId = app.environment.projectId;
  const [deployments, containers] = await Promise.all([
    prisma.deployment.findMany({ where: { applicationId: id }, orderBy: { createdAt: "desc" }, take: 30 }),
    liveContainers(app),
  ]);
  return NextResponse.json({
    ...serializeApp(app, request),
    deployments: deployments.map(serializeDeployment),
    containers,
    can: {
      deploy: can(user, "app.deploy", { projectId }),
      manage: can(user, "app.manage", { projectId }),
      secrets: can(user, "app.secrets", { projectId }),
      logs: can(user, "app.logs", { projectId }),
      // Runtime logs and the console go through the endpoint's container routes
      containerLogs: can(user, "container.logs", { endpointId: app.endpointId }),
      console: can(user, "container.exec", { endpointId: app.endpointId }),
    },
  });
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const { app, user } = gate;
  const body = await readJson(request);
  if (body.slug !== undefined && body.slug !== app.slug) {
    return NextResponse.json({ error: "The Docker name can't change after creation" }, { status: 400 });
  }
  if (body.env !== undefined && !can(user, "app.secrets", { projectId: app.environment.projectId })) {
    return NextResponse.json({ error: "You don't have permission to change environment variables" }, { status: 403 });
  }
  let input;
  try {
    input = validateAppInput(body, app);
    input = { ...input, ...(await validateAppExtras(body, input.sourceType, app.endpointId, { actor: user, projectId: app.environment.projectId, appId: app.id }, app)), ...validateAutoUpdateInput(body, app) };
  } catch (err) {
    if (err instanceof ConfigError || err instanceof EnvError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  await prisma.application.update({ where: { id }, data: input });
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "app.update",
    message: `${user.email} updated app ${app.name}`,
    targetType: "application",
    targetId: id,
    endpointId: app.endpointId,
    details: Object.keys(body).filter((k) => k !== "env").join(", ") + (body.env !== undefined ? (Object.keys(body).length > 1 ? ", env" : "env") : ""),
  });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const { app, user } = gate;
  const stepUp = requireStepUp(user);
  if (stepUp) return stepUp;
  const body = await readJson(request);
  const busy = await prisma.deployment.findFirst({ where: { applicationId: id, status: { in: ["queued", "running"] } } });
  if (busy) return NextResponse.json({ error: "Wait for the running deployment to finish or cancel it" }, { status: 409 });
  // Its pull request previews go with it
  for (const p of await prisma.application.findMany({ where: { previewOfId: id }, include: { endpoint: true } })) await removePreview(p);
  if (body.keepContainers !== true) {
    try {
      await teardownApplication(app);
    } catch (err) {
      return NextResponse.json({ error: `Couldn't remove the app's containers: ${(err as Error).message}. Remove them by hand or delete with "keep containers".` }, { status: 502 });
    }
  }
  const deps = await prisma.deployment.findMany({ where: { applicationId: id }, select: { id: true } });
  await prisma.application.delete({ where: { id } });
  deps.forEach((d) => removeLog(d.id));
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "app.delete",
    message: `${user.email} deleted app ${app.name}${body.keepContainers === true ? " (containers kept)" : ""}`,
    targetType: "application",
    targetId: id,
    endpointId: app.endpointId,
  });
  return NextResponse.json({ success: true });
}
