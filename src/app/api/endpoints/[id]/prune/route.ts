import { NextResponse } from "next/server";
import { endpointGate, dockerError } from "@/lib/endpointRoute";
import { readJson, requireStepUp } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";

const KINDS = ["containers", "images", "networks", "volumes"] as const;
type Kind = (typeof KINDS)[number];

/**
 * POST …/prune { kind } removes stopped containers, dangling images, unused
 * networks or unused volumes, like `docker <kind> prune`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await endpointGate(id, "docker.prune");
  if (!gate.ok) return gate.response;
  const { docker, user, endpoint } = gate.ctx;

  const { kind } = await readJson(request);
  if (!KINDS.includes(kind as Kind)) {
    return NextResponse.json({ error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
  }
  const stepUp = requireStepUp(user);
  if (stepUp) return stepUp;

  try {
    let result: { removed: number; reclaimed: number };
    switch (kind as Kind) {
      case "containers": {
        const r = await docker.pruneContainers();
        result = { removed: r.ContainersDeleted?.length ?? 0, reclaimed: r.SpaceReclaimed ?? 0 };
        break;
      }
      case "images": {
        const r = await docker.pruneImages();
        result = { removed: r.ImagesDeleted?.length ?? 0, reclaimed: r.SpaceReclaimed ?? 0 };
        break;
      }
      case "networks": {
        const r = await docker.pruneNetworks();
        result = { removed: r.NetworksDeleted?.length ?? 0, reclaimed: 0 };
        break;
      }
      case "volumes": {
        // Docker before 23 (API < 1.42) prunes every unused volume, named ones too,
        // so a stopped compose app would lose its database. Never prune volumes
        // that belong to a compose project; on newer Docker only anonymous volumes go.
        const r = await docker.pruneVolumes({ filters: { "label!": ["com.docker.compose.volume"] } });
        result = { removed: r.VolumesDeleted?.length ?? 0, reclaimed: r.SpaceReclaimed ?? 0 };
        break;
      }
    }
    await audit({
      actor: { id: user.id, email: user.email },
      ip: clientIp(request),
      action: `docker.prune_${kind}`,
      message: `${user.email} pruned ${kind} on ${endpoint.name}: ${result.removed} removed`,
      targetType: "endpoint",
      targetId: id,
      endpointId: id,
      details: `${Math.round(result.reclaimed / 1024 / 1024)} MB reclaimed`,
    });
    return NextResponse.json(result);
  } catch (err) {
    return dockerError(err);
  }
}
