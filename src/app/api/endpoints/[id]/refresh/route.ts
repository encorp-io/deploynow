import { NextResponse } from "next/server";
import { refreshEndpoint, serializeEndpoint } from "@/lib/endpoints";
import { endpointGate } from "@/lib/endpointRoute";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.view");
  if (!gate.ok) return gate.response;
  return NextResponse.json(serializeEndpoint(await refreshEndpoint(gate.ctx.endpoint)));
}
