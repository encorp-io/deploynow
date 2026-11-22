import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireStepUp } from "@/lib/apiAuth";
import { encryptCredentials, serializeEndpoint, validateEndpointInput, refreshEndpoint } from "@/lib/endpoints";
import { testConnection } from "@/lib/endpointTest";
import { endpointGate } from "@/lib/endpointRoute";
import { audit, clientIp } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.view");
  if (!gate.ok) return gate.response;
  return NextResponse.json(serializeEndpoint(gate.ctx.endpoint));
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.manage");
  if (!gate.ok) return gate.response;
  const { user, endpoint } = gate.ctx;

  const body = await readJson(request);
  const { data, error } = validateEndpointInput(body, endpoint);
  if (!data) return NextResponse.json({ error }, { status: 400 });

  if (data.name !== endpoint.name && (await prisma.endpoint.findUnique({ where: { name: data.name } }))) {
    return NextResponse.json({ error: "An endpoint with that name already exists" }, { status: 409 });
  }

  // A new address means a new host key; keep the pin only for the same host
  const sameHost = data.type === endpoint.type && data.host === endpoint.host && data.port === endpoint.port;
  const test = await testConnection(data, sameHost ? endpoint.hostKeyFingerprint : "");
  if (!test.ok && !body.saveOffline) {
    return NextResponse.json({ error: `Could not connect: ${test.error}`, test }, { status: 422 });
  }

  const updated = await prisma.endpoint.update({
    where: { id },
    data: {
      name: data.name,
      type: data.type,
      host: data.host,
      port: data.port,
      username: data.username,
      labels: data.labels,
      credentials: encryptCredentials(data.credentials),
      hostKeyFingerprint: sameHost ? endpoint.hostKeyFingerprint || test.hostKeyFingerprint || "" : test.hostKeyFingerprint ?? "",
    },
  });
  const fresh = await refreshEndpoint(updated);

  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "endpoint.update",
    message: `${user.email} updated endpoint ${fresh.name}`,
    targetType: "endpoint",
    targetId: id,
    endpointId: id,
  });
  return NextResponse.json(serializeEndpoint(fresh));
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.manage");
  if (!gate.ok) return gate.response;
  const { user, endpoint } = gate.ctx;

  const stepUp = requireStepUp(user);
  if (stepUp) return stepUp;

  // Removes the endpoint and the services tracked on it; containers keep running
  await prisma.$transaction([
    prisma.roleBinding.deleteMany({ where: { scopeType: "endpoint", scopeId: id } }),
    prisma.endpoint.delete({ where: { id } }),
  ]);

  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "endpoint.delete",
    message: `${user.email} removed endpoint ${endpoint.name}`,
    targetType: "endpoint",
    targetId: id,
  });
  return NextResponse.json({ success: true });
}
