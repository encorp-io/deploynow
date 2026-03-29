import { prisma } from "./prisma";
import {
  getContainers,
  getConfiguredEndpointId,
  parseImageRef,
  isFloatingTag,
  pullImage,
  recreateContainer,
} from "./portainer";
import { getRemoteDigest } from "./ghcr";

export async function syncServicesFromPortainer() {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings?.portainerUrl || !settings?.portainerApiKey) return;

  const endpointId = settings.portainerEndpointId ?? 1;
  const containers = await getContainers(endpointId);

  for (const container of containers) {
    const name   = container.Names[0]?.replace(/^\//, "") || container.Id.slice(0, 12);
    const parsed = parseImageRef(container.Image);

    await prisma.service.upsert({
      where: { containerId: container.Id },
      update: {
        containerName:       name,
        image:               parsed.full,
        registry:            parsed.registry,
        tag:                 parsed.tag,
        status:              container.State?.toLowerCase() || "unknown",
        isFloatingTag:       isFloatingTag(parsed.tag),
        portainerEndpointId: endpointId,
      },
      create: {
        containerId:         container.Id,
        containerName:       name,
        image:               parsed.full,
        registry:            parsed.registry,
        tag:                 parsed.tag,
        status:              container.State?.toLowerCase() || "unknown",
        isFloatingTag:       isFloatingTag(parsed.tag),
        portainerEndpointId: endpointId,
      },
    });
  }

  // Remove tracked services for containers that no longer exist on this endpoint
  const activeIds = containers.map((c) => c.Id);
  await prisma.service.deleteMany({
    where: { containerId: { notIn: activeIds }, portainerEndpointId: endpointId },
  });
}

export async function checkForUpdates() {
  const services = await prisma.service.findMany();
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });

  for (const service of services) {
    try {
      const parsed       = parseImageRef(service.image);
      const remoteDigest = await getRemoteDigest(parsed.registry, parsed.repository, parsed.tag);

      if (!remoteDigest) continue;

      const hasUpdate =
        service.currentDigest !== "" && service.currentDigest !== remoteDigest;

      await prisma.service.update({
        where: { id: service.id },
        data: { remoteDigest, updateAvailable: hasUpdate, lastChecked: new Date() },
      });

      if (hasUpdate && service.isFloatingTag && settings?.autoUpdateLatest) {
        await performUpdate(service.id);
      } else if (hasUpdate) {
        await prisma.activityLog.create({
          data: {
            serviceId: service.id,
            action:    "update_available",
            message:   `New version available for ${service.containerName}`,
            details:   `Current: ${service.currentDigest.slice(0, 16)}…  Remote: ${remoteDigest.slice(0, 16)}…`,
          },
        });
      }
    } catch (error) {
      // Log only the message — never the full error object (may contain tokens)
      const message = error instanceof Error ? error.message : "Unknown error";
      await prisma.activityLog.create({
        data: {
          serviceId: service.id,
          action:    "error",
          message:   `Check failed for ${service.containerName}: ${message}`,
        },
      });
    }
  }
}

export async function performUpdate(serviceId: string) {
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) throw new Error("Service not found");

  const endpointId = service.portainerEndpointId ?? (await getConfiguredEndpointId());

  await prisma.service.update({ where: { id: serviceId }, data: { status: "updating" } });

  try {
    await pullImage(endpointId, service.image);
    const newContainerId = await recreateContainer(endpointId, service.containerId);

    const parsed    = parseImageRef(service.image);
    const newDigest = await getRemoteDigest(parsed.registry, parsed.repository, parsed.tag);

    await prisma.service.update({
      where: { id: serviceId },
      data: {
        containerId:    newContainerId,
        currentDigest:  newDigest || "",
        remoteDigest:   newDigest || "",
        updateAvailable: false,
        status:         "running",
        lastUpdated:    new Date(),
      },
    });

    await prisma.activityLog.create({
      data: {
        serviceId,
        action:  "update",
        message: `Updated ${service.containerName} successfully`,
        details: `New digest: ${newDigest?.slice(0, 16) ?? "unknown"}…`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.service.update({ where: { id: serviceId }, data: { status: "error" } });
    await prisma.activityLog.create({
      data: {
        serviceId,
        action:  "error",
        message: `Update failed for ${service.containerName}: ${message}`,
      },
    });
    throw error;
  }
}

export async function initializeDigests() {
  const services = await prisma.service.findMany({ where: { currentDigest: "" } });

  for (const service of services) {
    try {
      const parsed  = parseImageRef(service.image);
      const digest  = await getRemoteDigest(parsed.registry, parsed.repository, parsed.tag);
      if (digest) {
        await prisma.service.update({
          where: { id: service.id },
          data: { currentDigest: digest, remoteDigest: digest, lastChecked: new Date() },
        });
      }
    } catch {
      // Skip silently — will retry on next poll cycle
    }
  }
}
