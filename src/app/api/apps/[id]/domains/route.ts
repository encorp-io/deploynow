import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { appGate, ID_RE } from "@/lib/apps/access";
import { ConfigError, validateHost, validatePath } from "@/lib/apps/config";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const { app, user } = gate;
  const body = await readJson(request);
  let host: string, path: string;
  try {
    host = validateHost(body.host);
    path = validatePath(body.path);
  } catch (err) {
    return NextResponse.json({ error: (err as ConfigError).message }, { status: 400 });
  }
  const containerPort = Number(body.containerPort);
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    return NextResponse.json({ error: "Enter the port the app listens on inside the container" }, { status: 400 });
  }
  const service = String(body.service ?? "").trim();
  if (service && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(service)) return NextResponse.json({ error: "Invalid service name" }, { status: 400 });
  if (app.endpoint.proxyMode === "none") {
    return NextResponse.json({ error: `Set up the edge proxy on ${app.endpoint.name} first (Endpoints → ${app.endpoint.name})` }, { status: 409 });
  }
  if (await prisma.domain.findUnique({ where: { host_path: { host, path } } })) {
    return NextResponse.json({ error: `${host}${path === "/" ? "" : path} is already used by an app` }, { status: 409 });
  }
  const domain = await prisma.domain.create({ data: { applicationId: id, host, path, containerPort, service, https: body.https !== false } });
  await audit({ actor: { id: user.id, email: user.email }, ip: clientIp(request), action: "app.domain_add", message: `${user.email} added ${host}${path === "/" ? "" : path} to ${app.name}`, targetType: "application", targetId: id, endpointId: app.endpointId });
  return NextResponse.json({ ...domain, redeployNeeded: true }, { status: 201 });
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const domainId = new URL(request.url).searchParams.get("domainId") ?? "";
  if (!ID_RE.test(domainId)) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
  const res = await prisma.domain.deleteMany({ where: { id: domainId, applicationId: id } });
  if (!res.count) return NextResponse.json({ error: "Domain not found" }, { status: 404 });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "app.domain_remove", message: `${gate.user.email} removed a domain from ${gate.app.name}`, targetType: "application", targetId: id, endpointId: gate.app.endpointId });
  return NextResponse.json({ success: true, redeployNeeded: true });
}
