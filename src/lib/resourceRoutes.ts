/** List and remove images, volumes and networks on an endpoint. */
import { NextResponse } from "next/server";
import { endpointGate, dockerError, validRef } from "./endpointRoute";
import { requireStepUp } from "./apiAuth";
import { audit, clientIp } from "./audit";
import { withTimeout } from "./docker/client";

export type ResourceKind = "images" | "volumes" | "networks";

const REMOVE_PERMISSION = { images: "image.remove", volumes: "volume.remove", networks: "network.remove" } as const;
const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);

export async function listResources(kind: ResourceKind, id: string) {
  const gate = await endpointGate(id, "container.inspect");
  if (!gate.ok) return gate.response;
  const { docker } = gate.ctx;

  try {
    const containers = await withTimeout(docker.listContainers({ all: true }), 20_000, "Listing containers");

    if (kind === "images") {
      const images = await withTimeout(docker.listImages({ all: false }), 20_000, "Listing images");
      const used = new Set(containers.map((c) => c.ImageID));
      return NextResponse.json(
        images.map((i) => ({
          id: i.Id,
          tags: (i.RepoTags ?? []).filter((t) => t !== "<none>:<none>"),
          size: i.Size,
          created: i.Created,
          inUse: used.has(i.Id),
        })),
      );
    }

    if (kind === "volumes") {
      const res = await withTimeout(docker.listVolumes(), 20_000, "Listing volumes");
      const usedBy = new Map<string, string[]>();
      for (const c of containers) {
        for (const m of c.Mounts ?? []) {
          if (m.Type === "volume" && m.Name) {
            usedBy.set(m.Name, [...(usedBy.get(m.Name) ?? []), c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12)]);
          }
        }
      }
      return NextResponse.json(
        (res.Volumes ?? []).map((v) => ({
          id: v.Name,
          name: v.Name,
          driver: v.Driver,
          mountpoint: v.Mountpoint,
          created: (v as { CreatedAt?: string }).CreatedAt ?? null,
          usedBy: usedBy.get(v.Name) ?? [],
        })),
      );
    }

    const networks = await withTimeout(docker.listNetworks(), 20_000, "Listing networks");
    const usedBy = new Map<string, string[]>();
    for (const c of containers) {
      for (const n of Object.keys(c.NetworkSettings?.Networks ?? {})) {
        usedBy.set(n, [...(usedBy.get(n) ?? []), c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12)]);
      }
    }
    return NextResponse.json(
      networks.map((n) => ({
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        subnet: n.IPAM?.Config?.[0]?.Subnet ?? null,
        builtin: BUILTIN_NETWORKS.has(n.Name),
        usedBy: usedBy.get(n.Name) ?? [],
      })),
    );
  } catch (err) {
    return dockerError(err);
  }
}

export async function removeResource(kind: ResourceKind, id: string, request: Request) {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref") ?? "";
  if (!validRef(ref)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const gate = await endpointGate(id, REMOVE_PERMISSION[kind]);
  if (!gate.ok) return gate.response;
  const { docker, user, endpoint } = gate.ctx;

  // Deleting a volume destroys data
  if (kind === "volumes") {
    const stepUp = requireStepUp(user);
    if (stepUp) return stepUp;
  }
  if (kind === "networks" && BUILTIN_NETWORKS.has(ref)) {
    return NextResponse.json({ error: "Docker's built-in networks can't be removed" }, { status: 400 });
  }

  try {
    if (kind === "images") await docker.getImage(ref).remove({ force: url.searchParams.get("force") === "1" });
    if (kind === "volumes") await docker.getVolume(ref).remove();
    if (kind === "networks") await docker.getNetwork(ref).remove();
    const noun = kind.slice(0, -1);
    await audit({
      actor: { id: user.id, email: user.email },
      ip: clientIp(request),
      action: `${noun}.remove`,
      message: `${user.email} removed ${noun} ${ref.slice(0, 80)} (${endpoint.name})`,
      targetType: noun,
      targetId: ref,
      endpointId: id,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return dockerError(err);
  }
}
