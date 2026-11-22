import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { endpointGate, dockerError } from "@/lib/endpointRoute";
import { checkExternalProxy, installProxy, proxyStatus, removeProxy } from "@/lib/deploy/proxy";
import { validateNetworkName } from "@/lib/apps/config";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.view");
  if (!gate.ok) return gate.response;
  const { endpoint, docker } = gate.ctx;
  const base = { mode: endpoint.proxyMode, network: endpoint.proxyNetwork, email: endpoint.proxyEmail, error: endpoint.proxyError };
  try {
    if (endpoint.proxyMode === "managed") return NextResponse.json({ ...base, status: await proxyStatus(docker) });
    if (endpoint.proxyMode === "external") return NextResponse.json({ ...base, check: await checkExternalProxy(docker, endpoint.proxyNetwork) });
    return NextResponse.json(base);
  } catch (err) {
    return NextResponse.json({ ...base, error: (err as Error).message });
  }
}

/** {mode: "managed", email} | {mode: "external", network} | {mode: "none"} */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.manage");
  if (!gate.ok) return gate.response;
  const { endpoint, docker, user } = gate.ctx;
  const body = await readJson(request);
  const mode = String(body.mode ?? "");
  let data: { proxyMode: string; proxyNetwork: string; proxyEmail: string; proxyError: string };

  try {
    if (mode === "managed") {
      const email = String(body.email ?? "").trim();
      await installProxy(docker, { email, network: "deploynow" });
      data = { proxyMode: "managed", proxyNetwork: "deploynow", proxyEmail: email, proxyError: "" };
    } else if (mode === "external") {
      const network = validateNetworkName(body.network || "dokploy-network");
      const check = await checkExternalProxy(docker, network);
      if (!check.ok) return NextResponse.json({ error: check.message }, { status: 422 });
      if (endpoint.proxyMode === "managed") await removeProxy(docker);
      data = { proxyMode: "external", proxyNetwork: network, proxyEmail: "", proxyError: "" };
    } else if (mode === "none") {
      const apps = await prisma.domain.count({ where: { application: { endpointId: id } } });
      if (apps) return NextResponse.json({ error: `${apps} domain${apps === 1 ? "" : "s"} still use this proxy; remove them first` }, { status: 409 });
      if (endpoint.proxyMode === "managed") await removeProxy(docker);
      data = { proxyMode: "none", proxyNetwork: "deploynow", proxyEmail: "", proxyError: "" };
    } else {
      return NextResponse.json({ error: "Choose managed, external or none" }, { status: 400 });
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (/Enter the email|already in use|Invalid network/.test(msg)) return NextResponse.json({ error: msg }, { status: 400 });
    await prisma.endpoint.update({ where: { id }, data: { proxyError: msg.slice(0, 500) } });
    return dockerError(err);
  }

  await prisma.endpoint.update({ where: { id }, data });
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "endpoint.proxy",
    message: `${user.email} set the edge proxy on ${endpoint.name} to ${mode}${mode === "external" ? ` (${data.proxyNetwork})` : ""}`,
    targetType: "endpoint",
    targetId: id,
    endpointId: id,
  });
  return NextResponse.json({ mode: data.proxyMode, network: data.proxyNetwork, email: data.proxyEmail });
}
