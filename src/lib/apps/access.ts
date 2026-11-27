/** Loading projects and apps for API routes, with the caller's project-scoped permission checked. */
import { NextResponse } from "next/server";
import type { Application, Domain, Endpoint, Environment, Project } from "@prisma/client";
import { prisma } from "../prisma";
import { requireUser, type CurrentUser } from "../apiAuth";
import { can, type Permission } from "../rbac";
import { envForClient } from "./env";
import { parsePorts, parseVolumes } from "./config";
import { parseUpdateInfo } from "./updateCheck";

export const ID_RE = /^c[a-z0-9]{24}$/;

type Fail = { ok: false; response: NextResponse };

export type AppWithRelations = Application & {
  endpoint: Endpoint;
  environment: Environment & { project: Project };
  domains: Domain[];
};

export function notFound(what: string) {
  return NextResponse.json({ error: `${what} not found` }, { status: 404 });
}

export function badRequest(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function projectGate(projectId: string, permission: Permission): Promise<{ ok: true; user: CurrentUser; project: Project } | Fail> {
  const gate = await requireUser();
  if (!gate.ok) return gate;
  if (!ID_RE.test(projectId)) return { ok: false, response: notFound("Project") };
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return { ok: false, response: notFound("Project") };
  if (!can(gate.user, permission, { projectId })) {
    // Hide projects the caller can't see at all
    const visible = can(gate.user, "project.view", { projectId });
    return { ok: false, response: visible ? NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 }) : notFound("Project") };
  }
  return { ok: true, user: gate.user, project };
}

export async function appGate(appId: string, permission: Permission): Promise<{ ok: true; user: CurrentUser; app: AppWithRelations } | Fail> {
  const gate = await requireUser();
  if (!gate.ok) return gate;
  if (!ID_RE.test(appId)) return { ok: false, response: notFound("Application") };
  const app = await prisma.application.findUnique({
    where: { id: appId },
    include: { endpoint: true, environment: { include: { project: true } }, domains: { orderBy: { createdAt: "asc" } } },
  });
  if (!app) return { ok: false, response: notFound("Application") };
  const projectId = app.environment.projectId;
  if (!can(gate.user, permission, { projectId })) {
    const visible = can(gate.user, "project.view", { projectId });
    return { ok: false, response: visible ? NextResponse.json({ error: "You don't have permission to do that" }, { status: 403 }) : notFound("Application") };
  }
  return { ok: true, user: gate.user, app };
}

/** The projects a user may see. */
export function visibleProjectFilter(user: CurrentUser) {
  if (can(user, "project.view")) return {};
  const ids = user.bindings.filter((b) => b.scopeType === "project").map((b) => b.scopeId);
  return { id: { in: ids } };
}

export { publicOrigin } from "../publicOrigin";
import { publicOrigin } from "../publicOrigin";

export function serializeApp(app: AppWithRelations, request?: Request) {
  return {
    id: app.id,
    name: app.name,
    slug: app.slug,
    sourceType: app.sourceType,
    image: app.image,
    gitRepo: app.gitRepo,
    gitBranch: app.gitBranch,
    buildContext: app.buildContext,
    dockerfilePath: app.dockerfilePath,
    composePath: app.composePath,
    composeInline: app.composeInline,
    env: envForClient(app.env),
    ports: parsePorts(app.ports),
    volumes: parseVolumes(app.volumes),
    command: app.command,
    restartPolicy: app.restartPolicy,
    updatePolicy: app.updatePolicy,
    autoUpdate: app.autoUpdate,
    autoUpdateEvery: app.autoUpdateEvery,
    autoUpdateDays: app.autoUpdateDays ? app.autoUpdateDays.split(",").map(Number) : [],
    autoUpdateFrom: app.autoUpdateFrom,
    autoUpdateTo: app.autoUpdateTo,
    autoUpdateTimezone: app.autoUpdateTimezone,
    autoUpdateRollback: app.autoUpdateRollback,
    autoUpdateCheckedAt: app.autoUpdateCheckedAt,
    autoUpdatePending: app.autoUpdatePending,
    autoUpdateError: app.autoUpdateError,
    updates: parseUpdateInfo(app.updateInfo),
    updateError: app.updateError,
    updateCheckedAt: app.updateCheckedAt,
    status: app.status,
    currentDeploymentId: app.currentDeploymentId,
    hasWebhookSecret: !!app.webhookSecret,
    buildEndpointId: app.buildEndpointId,
    registryId: app.registryId,
    pullRegistryId: app.pullRegistryId,
    previewsEnabled: app.previewsEnabled,
    previewDomain: app.previewDomain,
    previewOfId: app.previewOfId,
    prNumber: app.prNumber,
    webhookUrl: request ? `${publicOrigin(request)}/api/webhooks/github/${app.id}` : null,
    endpoint: { id: app.endpoint.id, name: app.endpoint.name, proxyMode: app.endpoint.proxyMode, status: app.endpoint.status },
    environment: { id: app.environment.id, name: app.environment.name, slug: app.environment.slug },
    project: { id: app.environment.project.id, name: app.environment.project.name, slug: app.environment.project.slug },
    domains: app.domains.map((d) => ({ id: d.id, host: d.host, path: d.path, containerPort: d.containerPort, service: d.service, https: d.https, redirectTo: d.redirectTo, redirectCode: d.redirectCode, basicAuthUser: d.basicAuth ? d.basicAuth.split(":")[0] : "" })),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

export function serializeDeployment(d: {
  id: string;
  trigger: string;
  status: string;
  commitSha: string;
  commitMessage: string;
  imageRef: string;
  error: string;
  startedByEmail: string;
  rollbackOfId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}) {
  return {
    id: d.id,
    trigger: d.trigger,
    status: d.status,
    commitSha: d.commitSha,
    commitMessage: d.commitMessage,
    imageRef: d.imageRef,
    error: d.error,
    startedByEmail: d.startedByEmail,
    rollbackOfId: d.rollbackOfId,
    createdAt: d.createdAt,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
  };
}
