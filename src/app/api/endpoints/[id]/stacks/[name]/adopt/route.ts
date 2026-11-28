import crypto from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { endpointGate, dockerError } from "@/lib/endpointRoute";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { can } from "@/lib/rbac";
import { ID_RE } from "@/lib/apps/access";
import { ConfigError, validateAppInput } from "@/lib/apps/config";
import { EnvError } from "@/lib/apps/env";
import { canPlaceOn, PLACE_DENIED } from "@/lib/apps/placement";
import { encryptSecret } from "@/lib/secretsCrypto";
import { planStackAdoption, STACK_RE, type AdoptPlan } from "@/lib/externalContainers";

type Params = { params: Promise<{ id: string; name: string }> };

/**
 * Turning a stack into an app reads its containers' env values (admins on the
 * endpoint: container.env) and runs an app there (container.control). The
 * project's app.manage is checked when the app is created.
 */
async function plan(id: string, name: string) {
  if (!STACK_RE.test(name)) return { ok: false as const, response: NextResponse.json({ error: "Invalid stack name" }, { status: 400 }) };
  const gate = await endpointGate(id, "container.env");
  if (!gate.ok) return gate;
  if (!canPlaceOn(gate.ctx.user, id)) return { ok: false as const, response: NextResponse.json({ error: PLACE_DENIED }, { status: 403 }) };
  const { endpoint, docker } = gate.ctx;
  const appIds = new Set((await prisma.application.findMany({ where: { endpointId: id }, select: { id: true } })).map((a) => a.id));
  const p = await planStackAdoption(docker, name, { proxyNetwork: endpoint.proxyMode === "none" ? null : endpoint.proxyNetwork, appIds });
  if (!p) {
    return { ok: false as const, response: NextResponse.json({ error: "That stack isn't on this endpoint, or part of it is already managed by DeployNow" }, { status: 404 }) };
  }
  return { ok: true as const, ctx: gate.ctx, plan: p };
}

/** What the browser may see of a plan: variable names and kinds, never their values. */
function forClient(p: AdoptPlan) {
  return {
    stack: p.stack,
    slug: p.slug,
    inPlace: p.inPlace,
    yaml: p.yaml,
    services: p.services,
    warnings: p.warnings,
    blocker: p.blocker,
    env: p.env.map((e) => ({ key: e.key, kind: e.kind })),
    taken: false,
  };
}

/** Preview: the compose file DeployNow would run for this stack. */
export async function GET(_req: Request, { params }: Params) {
  const { id, name } = await params;
  try {
    const res = await plan(id, name);
    if (!res.ok) return res.response;
    const taken = !!(await prisma.application.findUnique({ where: { endpointId_slug: { endpointId: id, slug: res.plan.slug } } }));
    return NextResponse.json({ ...forClient(res.plan), taken });
  } catch (err) {
    return dockerError(err);
  }
}

/**
 * Create a compose app from the stack: { environmentId, name, compose? }.
 * The env values come from the containers again here, not from the browser.
 * Nothing is deployed: the first deploy (started from the app page) takes over the containers.
 */
export async function POST(request: Request, { params }: Params) {
  const { id, name } = await params;
  const body = await readJson(request);
  const environmentId = String(body.environmentId ?? "");
  const env = ID_RE.test(environmentId) ? await prisma.environment.findUnique({ where: { id: environmentId }, include: { project: true } }) : null;
  if (!env) return NextResponse.json({ error: "Choose the project and environment for the app" }, { status: 400 });
  try {
    const res = await plan(id, name);
    if (!res.ok) return res.response;
    const { user, endpoint } = res.ctx;
    if (!can(user, "app.manage", { projectId: env.projectId })) {
      return NextResponse.json({ error: "You don't have permission to add apps to that project" }, { status: 403 });
    }
    const compose = typeof body.compose === "string" && body.compose.trim() ? body.compose : res.plan.yaml;
    let input;
    try {
      input = validateAppInput({
        name: String(body.name ?? "").trim() || res.plan.stack,
        slug: res.plan.slug,
        sourceType: "compose",
        composeInline: compose,
        env: res.plan.env,
      });
    } catch (err) {
      if (err instanceof ConfigError || err instanceof EnvError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
    if (await prisma.application.findUnique({ where: { endpointId_slug: { endpointId: id, slug: input.slug } } })) {
      return NextResponse.json({ error: `An app named ${input.slug} already runs on ${endpoint.name}` }, { status: 409 });
    }
    const app = await prisma.application.create({
      data: { ...input, environmentId, endpointId: id, webhookSecret: encryptSecret(crypto.randomBytes(24).toString("hex")) },
    });
    await audit({
      actor: { id: user.id, email: user.email },
      ip: clientIp(request),
      action: "app.adopt",
      message: `${user.email} turned stack ${name} on ${endpoint.name} into app ${app.name} in ${env.project.name}/${env.name}`,
      targetType: "application",
      targetId: app.id,
      endpointId: id,
      details: `${res.plan.services.length} services, ${res.plan.env.length} variables imported`,
    });
    return NextResponse.json({ id: app.id }, { status: 201 });
  } catch (err) {
    return dockerError(err);
  }
}
