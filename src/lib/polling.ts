/**
 * Image auto-update, now per endpoint and straight to Docker (no Portainer).
 *
 *   syncServices()     list containers on every online endpoint → Service rows
 *   checkForUpdates()  compare running image id with the registry digest;
 *                      recreate floating tags when auto-update is on
 *   performUpdate()    pull + recreate one service
 */
import os from "os";
import type Docker from "dockerode";
import type { Endpoint } from "@prisma/client";
import { prisma } from "./prisma";
import { getRemoteDigests } from "./ghcr";
import { isFloatingTag, parseImageRef } from "./imageRef";
import { dockerFor, refreshEndpoint } from "./endpoints";
import { recreateContainer } from "./docker/recreate";
import { withTimeout, dockerErrorMessage } from "./docker/client";
import { registryAuthFor } from "./registryAuth";
import { audit, type AuditActor } from "./audit";

/** Never auto-update the control plane itself or a Portainer that may still be in use. */
export function isProtectedContainer(image: string, containerId: string, labels: Record<string, string> = {}): boolean {
  if (labels["io.deploynow.self"] === "true") return true;
  const img = image.toLowerCase();
  if (img.includes("portainer") || img.includes("deployer-for-portainer") || img.includes("deploynow")) return true;
  const host = os.hostname();
  return !!host && /^[0-9a-f]{12}$/.test(host) && containerId.startsWith(host);
}

async function syncEndpoint(endpoint: Endpoint, docker: Docker): Promise<void> {
  const containers = await withTimeout(docker.listContainers({ all: true }), 20_000, "Listing containers");
  const imageCache = new Map<string, { arch: string; repoDigests: string }>();

  for (const c of containers) {
    const name = c.Names?.[0]?.replace(/^\//, "") || c.Id.slice(0, 12);
    const parsed = parseImageRef(c.Image);
    // Containers started from an image id or pinned to a digest have no tag to follow
    if (/^sha256:/.test(c.Image) || /^[0-9a-f]{12,64}$/.test(c.Image) || c.Image.includes("@sha256:")) continue;

    let img = imageCache.get(c.ImageID);
    if (!img) {
      try {
        const info = await docker.getImage(c.ImageID).inspect();
        img = { arch: info.Architecture || "amd64", repoDigests: (info.RepoDigests ?? []).join(",") };
      } catch {
        img = { arch: "amd64", repoDigests: "" };
      }
      imageCache.set(c.ImageID, img);
    }

    const data = {
      containerName: name,
      image: parsed.full,
      registry: parsed.registry,
      tag: parsed.tag,
      status: c.State?.toLowerCase() || "unknown",
      isFloatingTag: isFloatingTag(parsed.tag),
      currentDigest: c.ImageID || "",
      repoDigests: img.repoDigests,
      arch: img.arch,
      endpointId: endpoint.id,
    };
    await prisma.service.upsert({
      where: { containerId: c.Id },
      update: data,
      create: { containerId: c.Id, ...data },
    });
  }

  await prisma.service.deleteMany({
    where: { endpointId: endpoint.id, containerId: { notIn: containers.map((c) => c.Id) } },
  });
}

export async function syncServices(): Promise<void> {
  const endpoints = await prisma.endpoint.findMany();
  for (const ep of endpoints) {
    const fresh = await refreshEndpoint(ep);
    if (fresh.status !== "online") continue;
    try {
      await syncEndpoint(fresh, dockerFor(fresh));
    } catch (err) {
      console.error(`[deployer] Sync failed for endpoint ${ep.name}:`, dockerErrorMessage(err));
    }
  }
}

/**
 * Is the local image the one the tag points to now? The classic image store's
 * ImageID is the config digest; the containerd store (Docker 29+ default) uses
 * the index digest, which also appears in RepoDigests.
 */
export function isCurrent(local: { currentDigest: string; repoDigests?: string }, remote: { config: string; manifest: string }): boolean {
  if (!local.currentDigest) return true; // nothing to compare yet
  if (local.currentDigest === remote.config) return true;
  if (!remote.manifest) return false;
  if (local.currentDigest === remote.manifest) return true;
  return (local.repoDigests ?? "").split(",").some((d) => d.endsWith(`@${remote.manifest}`));
}

export async function checkForUpdates(): Promise<void> {
  const services = await prisma.service.findMany({ where: { endpointId: { not: null } } });
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });

  for (const service of services) {
    try {
      const parsed = parseImageRef(service.image);
      const remote = await getRemoteDigests(parsed.registry, parsed.repository, parsed.tag, service.arch);

      if (!remote) {
        await prisma.service.update({ where: { id: service.id }, data: { lastChecked: new Date() } });
        continue;
      }

      const remoteDigest = remote.config;
      const hasUpdate = !isCurrent(service, remote);
      const wasKnown = service.updateAvailable && service.remoteDigest === remoteDigest;

      await prisma.service.update({
        where: { id: service.id },
        data: { remoteDigest, updateAvailable: hasUpdate, lastChecked: new Date() },
      });

      if (
        hasUpdate &&
        service.isFloatingTag &&
        settings?.autoUpdateLatest &&
        !isProtectedContainer(service.image, service.containerId)
      ) {
        await performUpdate(service.id);
      } else if (hasUpdate && !wasKnown) {
        await audit({
          action: "service.update_available",
          message: `New version available for ${service.containerName}`,
          targetType: "container",
          targetId: service.containerId,
          endpointId: service.endpointId,
          serviceId: service.id,
          details: `Current: ${service.currentDigest.slice(0, 19)}…  Remote: ${remoteDigest.slice(0, 19)}…`,
        });
      }
    } catch (error) {
      await prisma.service.update({ where: { id: service.id }, data: { lastChecked: new Date() } }).catch(() => {});
      const message = error instanceof Error ? error.message : "Unknown error";
      await audit({
        action: "service.check",
        outcome: "failure",
        message: `Check failed for ${service.containerName}: ${message}`,
        targetType: "container",
        targetId: service.containerId,
        endpointId: service.endpointId,
        serviceId: service.id,
      });
    }
  }
}

export async function performUpdate(serviceId: string, actor?: AuditActor | null, ip?: string): Promise<void> {
  const service = await prisma.service.findUnique({ where: { id: serviceId }, include: { endpoint: true } });
  if (!service) throw new Error("Service not found");
  if (!service.endpoint) throw new Error("Service has no endpoint");

  await prisma.service.update({ where: { id: serviceId }, data: { status: "updating" } });

  try {
    const docker = dockerFor(service.endpoint);
    const authconfig = await registryAuthFor(service.image);
    const newContainerId = await recreateContainer(docker, service.containerId, { pull: true, authconfig });
    const newInfo = await docker.getContainer(newContainerId).inspect();
    const repoDigests = await docker
      .getImage(newInfo.Image)
      .inspect()
      .then((i) => (i.RepoDigests ?? []).join(","))
      .catch(() => "");

    await prisma.service.update({
      where: { id: serviceId },
      data: {
        containerId: newContainerId,
        currentDigest: newInfo.Image,
        repoDigests,
        // We just pulled what the tag points to
        updateAvailable: false,
        status: newInfo.State.Running ? "running" : newInfo.State.Status,
        lastUpdated: new Date(),
      },
    });

    await audit({
      actor,
      ip,
      action: "service.update",
      message: `Updated ${service.containerName} on ${service.endpoint.name}`,
      targetType: "container",
      targetId: newContainerId,
      endpointId: service.endpointId,
      serviceId,
      details: `New image: ${newInfo.Image.slice(0, 19)}…`,
    });
  } catch (error) {
    const message = dockerErrorMessage(error);
    await prisma.service.update({ where: { id: serviceId }, data: { status: "error" } });
    await audit({
      actor,
      ip,
      action: "service.update",
      outcome: "failure",
      message: `Update failed for ${service.containerName}: ${message}`,
      targetType: "container",
      targetId: service.containerId,
      endpointId: service.endpointId,
      serviceId,
    });
    throw new Error(message);
  }
}
