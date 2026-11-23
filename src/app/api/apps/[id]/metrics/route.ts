import { NextResponse } from "next/server";
import { appGate } from "@/lib/apps/access";
import { parseRange, readHistory } from "@/lib/containerMetrics";

/** CPU, memory, network and disk I/O history of the app's containers: ?range=1h|6h|24h|7d|30d */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await appGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const range = parseRange(new URL(request.url).searchParams.get("range"));
  return NextResponse.json(await readHistory({ applicationId: id }, range));
}
