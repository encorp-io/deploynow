import { NextResponse } from "next/server";
import { endpointGate, dockerError } from "@/lib/endpointRoute";
import { withTimeout } from "@/lib/docker/client";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await endpointGate(id, "container.inspect");
  if (!gate.ok) return gate.response;

  try {
    const list = await withTimeout(gate.ctx.docker.listContainers({ all: true }), 20_000, "Listing containers");
    return NextResponse.json(
      list.map((c) => ({
        id: c.Id,
        name: c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
        image: c.Image,
        imageId: c.ImageID,
        state: c.State,
        status: c.Status,
        created: c.Created,
        ports: (c.Ports ?? []).map((p) => ({ ip: p.IP, private: p.PrivatePort, public: p.PublicPort, type: p.Type })),
        composeProject: c.Labels?.["com.docker.compose.project"] ?? null,
        composeService: c.Labels?.["com.docker.compose.service"] ?? null,
      })),
    );
  } catch (err) {
    return dockerError(err);
  }
}
