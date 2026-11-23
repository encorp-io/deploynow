import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { endpointGate } from "@/lib/endpointRoute";

/** Host metric samples for charts: ?hours=24 (max 168). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await endpointGate(id, "endpoint.view");
  if (!gate.ok) return gate.response;
  const hours = Math.min(Math.max(Number(new URL(request.url).searchParams.get("hours") ?? 24) || 24, 1), 168);
  const samples = await prisma.metricSample.findMany({
    where: { endpointId: id, at: { gte: new Date(Date.now() - hours * 3600_000) } },
    orderBy: { at: "asc" },
    select: { at: true, cpus: true, load1: true, memTotal: true, memUsed: true, diskTotal: true, diskUsed: true },
  });
  return NextResponse.json(samples);
}
