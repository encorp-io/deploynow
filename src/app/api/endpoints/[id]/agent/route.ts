import { NextResponse } from "next/server";
import { readJson, requireStepUp } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { endpointGate } from "@/lib/endpointRoute";
import { joinInfo, revokeAgent } from "@/lib/agent/hub";

type Params = { params: Promise<{ id: string }> };

/** {action: "join"} -> a new one-time join command; {action: "revoke"} -> cut the agent off. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.manage");
  if (!gate.ok) return gate.response;
  const { user, endpoint } = gate.ctx;
  if (endpoint.type !== "agent") return NextResponse.json({ error: "This endpoint doesn't use the agent" }, { status: 400 });
  const body = await readJson(request);
  const actor = { id: user.id, email: user.email };

  if (body.action === "join") {
    const join = await joinInfo(id);
    await audit({ actor, ip: clientIp(request), action: "agent.join_token", message: `${user.email} created an agent join token for ${endpoint.name}`, targetType: "endpoint", targetId: id, endpointId: id });
    return NextResponse.json(join);
  }
  if (body.action === "revoke") {
    const stepUp = requireStepUp(user);
    if (stepUp) return stepUp;
    await revokeAgent(id);
    await audit({ actor, ip: clientIp(request), action: "agent.revoke", message: `${user.email} revoked the agent of ${endpoint.name}`, targetType: "endpoint", targetId: id, endpointId: id });
    return NextResponse.json({ success: true });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
