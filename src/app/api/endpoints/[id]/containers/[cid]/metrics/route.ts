import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { endpointGate, validRef } from "@/lib/endpointRoute";
import { parseRange, readHistory } from "@/lib/containerMetrics";

/**
 * Usage history of one container (by id or name): ?range=1h|6h|24h|7d|30d.
 * App containers are followed across redeploys (their series is the app's service).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  if (!validRef(cid)) return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  const gate = await endpointGate(id, "container.inspect");
  if (!gate.ok) return gate.response;
  const range = parseRange(new URL(request.url).searchParams.get("range"));
  const hit = await prisma.containerSample.findFirst({
    where: { endpointId: id, OR: [{ containerId: { startsWith: cid } }, { containerName: cid }] },
    orderBy: { at: "desc" },
    select: { key: true },
  });
  if (!hit) return NextResponse.json({ range, from: null, to: new Date().toISOString(), bucketSeconds: 0, series: [] });
  return NextResponse.json(await readHistory({ endpointId: id, key: hit.key }, range));
}
