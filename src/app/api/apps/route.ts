import crypto from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { ID_RE, notFound, projectGate } from "@/lib/apps/access";
import { ConfigError, validateAppInput } from "@/lib/apps/config";
import { validateAppExtras } from "@/lib/apps/extras";
import { validateAutoUpdateInput } from "@/lib/apps/autoUpdate";
import { EnvError } from "@/lib/apps/env";
import { encryptSecret } from "@/lib/secretsCrypto";
import { canPlaceOn, PLACE_DENIED } from "@/lib/apps/placement";

export async function POST(request: Request) {
  const body = await readJson(request);
  const environmentId = String(body.environmentId ?? "");
  const env = ID_RE.test(environmentId) ? await prisma.environment.findUnique({ where: { id: environmentId } }) : null;
  if (!env) return notFound("Environment");
  const gate = await projectGate(env.projectId, "app.manage");
  if (!gate.ok) return gate.response;

  const endpointId = String(body.endpointId || env.defaultEndpointId || "");
  const endpoint = ID_RE.test(endpointId) ? await prisma.endpoint.findUnique({ where: { id: endpointId } }) : null;
  if (!endpoint) return NextResponse.json({ error: "Choose the endpoint this app runs on" }, { status: 400 });
  if (!canPlaceOn(gate.user, endpointId)) return NextResponse.json({ error: PLACE_DENIED }, { status: 403 });

  let input;
  try {
    input = validateAppInput(body);
    input = { ...input, ...(await validateAppExtras(body, input.sourceType, endpointId, { actor: gate.user, projectId: env.projectId })), ...validateAutoUpdateInput(body) };
  } catch (err) {
    if (err instanceof ConfigError || err instanceof EnvError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  if (await prisma.application.findUnique({ where: { endpointId_slug: { endpointId, slug: input.slug } } })) {
    return NextResponse.json({ error: `An app named ${input.slug} already runs on ${endpoint.name}; choose another Docker name` }, { status: 409 });
  }
  const app = await prisma.application.create({
    data: { ...input, environmentId, endpointId, webhookSecret: encryptSecret(crypto.randomBytes(24).toString("hex")) },
  });
  await audit({
    actor: { id: gate.user.id, email: gate.user.email },
    ip: clientIp(request),
    action: "app.create",
    message: `${gate.user.email} created app ${app.name} in ${gate.project.name}/${env.name}`,
    targetType: "application",
    targetId: app.id,
    endpointId,
  });
  return NextResponse.json({ id: app.id }, { status: 201 });
}
