import { NextResponse } from "next/server";
import type Docker from "dockerode";
import { summarizeStats } from "@/lib/docker/stats";
import { endpointGate, dockerError, validRef } from "@/lib/endpointRoute";
import { withTimeout } from "@/lib/docker/client";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  if (!validRef(cid)) return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  const gate = await endpointGate(id, "container.inspect");
  if (!gate.ok) return gate.response;

  try {
    const stats = await withTimeout(
      gate.ctx.docker.getContainer(cid).stats({ stream: false }) as Promise<Docker.ContainerStats>,
      10_000,
      "Reading stats",
    );
    return NextResponse.json(summarizeStats(stats));
  } catch (err) {
    return dockerError(err);
  }
}
