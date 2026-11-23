import crypto from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { ID_RE, notFound, projectGate } from "@/lib/apps/access";
import { ConfigError, slugify, validateAppInput, validateHost } from "@/lib/apps/config";
import { EnvError } from "@/lib/apps/env";
import { encryptSecret } from "@/lib/secretsCrypto";
import { findTemplate, instantiate, TemplateError, TEMPLATES, templateForClient } from "@/lib/templates";
import { savePolicy } from "@/lib/backup/service";
import { BackupConfigError } from "@/lib/backup/config";
import { DeployBusyError, enqueueDeploy } from "@/lib/jobs";

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  return NextResponse.json(TEMPLATES.map(templateForClient));
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Create an app from a template, with its domain and backup policy, and deploy it. */
export async function POST(request: Request) {
  const body = await readJson(request);
  const template = findTemplate(String(body.templateId ?? ""));
  if (!template) return bad("Choose a template");
  const environmentId = String(body.environmentId ?? "");
  const env = ID_RE.test(environmentId) ? await prisma.environment.findUnique({ where: { id: environmentId } }) : null;
  if (!env) return notFound("Environment");
  const gate = await projectGate(env.projectId, "app.manage");
  if (!gate.ok) return gate.response;
  const { user, project } = gate;

  const endpointId = String(body.endpointId || env.defaultEndpointId || "");
  const endpoint = ID_RE.test(endpointId) ? await prisma.endpoint.findUnique({ where: { id: endpointId } }) : null;
  if (!endpoint) return bad("Choose the endpoint this app runs on");

  const name = String(body.name ?? "").trim() || template.name;
  const slug = String(body.slug ?? "").trim() || slugify(name);
  const destinationId = body.backupDestinationId ? String(body.backupDestinationId) : "";
  if (destinationId && !can(user, "backup.manage")) return bad("You don't have permission to create backup policies", 403);
  const deploy = body.deploy !== false;
  if (deploy && !can(user, "app.deploy", { projectId: project.id })) return bad("You don't have permission to deploy", 403);

  let made, input, domain = "";
  try {
    if (body.domain) domain = validateHost(body.domain);
    const hostPort = body.hostPort === undefined || body.hostPort === null || body.hostPort === "" ? null : Number(body.hostPort);
    const serverHost = endpoint.type === "ssh" || endpoint.type === "tls" ? endpoint.host : "";
    made = instantiate(template, { slug, domain, https: body.https !== false, hostPort, serverHost, values: (body.values ?? {}) as Record<string, unknown> });
    input = validateAppInput({ name, slug, sourceType: "compose", composeInline: made.composeInline, env: made.env, updatePolicy: "manual" });
  } catch (err) {
    if (err instanceof TemplateError || err instanceof ConfigError || err instanceof EnvError) return bad(err.message);
    throw err;
  }
  if (await prisma.application.findUnique({ where: { endpointId_slug: { endpointId, slug: input.slug } } })) {
    return bad(`An app named ${input.slug} already runs on ${endpoint.name}; choose another Docker name`, 409);
  }
  if (made.domain) {
    if (endpoint.proxyMode === "none") return bad(`Set up the edge proxy on ${endpoint.name} first (Endpoints → ${endpoint.name}), or publish a host port instead`, 409);
    if (await prisma.domain.findUnique({ where: { host_path: { host: made.domain.host, path: "/" } } })) return bad(`${made.domain.host} is already used by an app`, 409);
  }
  if (destinationId && !(await prisma.backupDestination.findUnique({ where: { id: destinationId } }))) return bad("That backup destination doesn't exist");

  const app = await prisma.application.create({
    data: { ...input, environmentId, endpointId, webhookSecret: encryptSecret(crypto.randomBytes(24).toString("hex")) },
  });
  if (made.domain) await prisma.domain.create({ data: { applicationId: app.id, host: made.domain.host, path: "/", containerPort: made.domain.containerPort, service: made.domain.service, https: made.domain.https } });
  const actor = { id: user.id, email: user.email };
  const ip = clientIp(request);
  await audit({
    actor,
    ip,
    action: "app.create",
    message: `${user.email} created app ${app.name} from the ${template.name} template in ${project.name}/${env.name}${made.domain ? ` at ${made.domain.host}` : ""}`,
    targetType: "application",
    targetId: app.id,
    endpointId,
  });

  const result: Record<string, unknown> = { id: app.id, notes: template.notes ?? "" };
  if (destinationId && made.backupSources.length) {
    try {
      const { policy, repo, repoCreated } = await savePolicy({ name: `${app.name} (${env.name})`, endpointId, destinationId, sources: made.backupSources, mode: made.backupMode });
      await audit({ actor, ip, action: "backup.policy.create", targetType: "backup_policy", targetId: policy.id, endpointId, message: `${user.email} created backup policy ${policy.name} for ${app.name}` });
      Object.assign(result, { backupPolicyId: policy.id, repoId: repo.id, kitAvailable: repoCreated || !repo.kitShownAt });
    } catch (err) {
      result.backupError = err instanceof BackupConfigError ? err.message : "The backup policy couldn't be created";
    }
  }
  if (deploy) {
    try {
      const dep = await enqueueDeploy(app.id, { trigger: "manual", actor });
      await audit({ actor, ip, action: "app.deploy_queued", message: `${user.email} started a deployment of ${app.name}`, targetType: "application", targetId: app.id, endpointId });
      result.deploymentId = dep.id;
    } catch (err) {
      if (!(err instanceof DeployBusyError)) throw err;
    }
  }
  return NextResponse.json(result, { status: 201 });
}
