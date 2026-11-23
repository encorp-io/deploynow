import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import {
  encryptCredentials,
  refreshEndpoint,
  serializeEndpoint,
  validateEndpointInput,
} from "@/lib/endpoints";
import { testConnection } from "@/lib/endpointTest";
import { audit, clientIp } from "@/lib/audit";
import { ensureAgentSocket, joinInfo } from "@/lib/agent/hub";

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const endpoints = await prisma.endpoint.findMany({ orderBy: { name: "asc" } });
  return NextResponse.json(
    endpoints.filter((e) => can(gate.user, "endpoint.view", { endpointId: e.id })).map(serializeEndpoint),
  );
}

export async function POST(request: Request) {
  const gate = await requireUser("endpoint.manage");
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  const { data, error } = validateEndpointInput(body);
  if (!data) return NextResponse.json({ error }, { status: 400 });

  if (await prisma.endpoint.findUnique({ where: { name: data.name } })) {
    return NextResponse.json({ error: "An endpoint with that name already exists" }, { status: 409 });
  }

  if (data.type === "agent") {
    const created = await prisma.endpoint.create({ data: { name: data.name, type: "agent", host: "", labels: data.labels, status: "offline", lastError: "Waiting for the agent to enrol" } });
    await ensureAgentSocket(created.id).catch(() => {});
    const join = await joinInfo(created.id);
    await audit({
      actor: { id: gate.user.id, email: gate.user.email },
      ip: clientIp(request),
      action: "endpoint.create",
      message: `${gate.user.email} added agent endpoint ${created.name}`,
      targetType: "endpoint",
      targetId: created.id,
      endpointId: created.id,
    });
    return NextResponse.json({ ...serializeEndpoint(await prisma.endpoint.findUniqueOrThrow({ where: { id: created.id } })), join }, { status: 201 });
  }

  // Connect before saving, and pin the SSH host key we saw
  const test = await testConnection(data);
  if (!test.ok && !body.saveOffline) {
    return NextResponse.json({ error: `Could not connect: ${test.error}`, test }, { status: 422 });
  }

  const created = await prisma.endpoint.create({
    data: {
      name: data.name,
      type: data.type,
      host: data.host,
      port: data.port,
      username: data.username,
      labels: data.labels,
      credentials: encryptCredentials(data.credentials),
      hostKeyFingerprint: test.hostKeyFingerprint ?? "",
    },
  });
  const endpoint = await refreshEndpoint(created);

  await audit({
    actor: { id: gate.user.id, email: gate.user.email },
    ip: clientIp(request),
    action: "endpoint.create",
    message: `${gate.user.email} added endpoint ${endpoint.name} (${endpoint.type} ${endpoint.host})`,
    targetType: "endpoint",
    targetId: endpoint.id,
    endpointId: endpoint.id,
    details: test.hostKeyFingerprint ? `Pinned SSH host key ${test.hostKeyFingerprint}` : "",
  });

  return NextResponse.json(serializeEndpoint(endpoint), { status: 201 });
}
