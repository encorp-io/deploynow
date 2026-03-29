import { prisma } from "./prisma";
import {
  getContainers,
  getConfiguredEndpointId,
  getImageInspect,
  parseImageRef,
  isFloatingTag,
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

    // ImageID from Portainer is the config digest of the image actually running.
    // This is the ground truth for "what version is deployed".
    const localDigest = container.ImageID || "";

    // Detect architecture from the running image via Portainer's image inspect.
    // This ensures we compare against the same arch in the registry manifest list.
    let arch = "amd64"; // safe default
    if (container.ImageID) {
      try {
        const imgInfo = await getImageInspect(endpointId, container.ImageID);
        if (imgInfo.Architecture) {
          arch = imgInfo.Architecture;
        }
      } catch {
        // Non-fatal — fall back to amd64
      }
    }

    await prisma.service.upsert({
      where: { containerId: container.Id },
      update: {
        containerName:       name,
        image:               parsed.full,
        registry:            parsed.registry,
        tag:                 parsed.tag,
        status:              container.State?.toLowerCase() || "unknown",
        isFloatingTag:       isFloatingTag(parsed.tag),
        currentDigest:       localDigest,
        arch,
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
        currentDigest:       localDigest,
        arch,
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
      const remoteDigest = await getRemoteDigest(parsed.registry, parsed.repository, parsed.tag, service.arch);

      if (!remoteDigest) {
        // Still mark as checked even if no digest was returned
        await prisma.service.update({
          where: { id: service.id },
          data: { lastChecked: new Date() },
        });
        continue;
      }

      // currentDigest is the local ImageID from Portainer (set during sync).
      // remoteDigest is the config digest of the latest image in the registry.
      // If they differ, an update is available.
      const hasUpdate =
        service.currentDigest !== "" && service.currentDigest !== remoteDigest;

      await prisma.service.update({
        where: { id: service.id },
        data: {
          remoteDigest,
          updateAvailable: hasUpdate,
          lastChecked: new Date(),
        },
      });

      // Auto-update floating tags if enabled, but NEVER auto-update Portainer itself.
      // Auto-updating Portainer can break the API we depend on and crash the whole system.
      const isPortainer = service.image.includes("portainer");
      if (hasUpdate && service.isFloatingTag && settings?.autoUpdateLatest && !isPortainer) {
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
      // Still mark as checked so the UI doesn't show "Never"
      await prisma.service.update({
        where: { id: service.id },
        data: { lastChecked: new Date() },
      }).catch(() => {});

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
    // Use Portainer's native recreate with PullImage: true.
    // This safely pulls the new image and recreates the container in one step,
    // preserving all config (volumes, networks, env vars, labels, etc.).
    const newContainerId = await recreateContainer(endpointId, service.containerId, true);

    const parsed    = parseImageRef(service.image);
    const newDigest = await getRemoteDigest(parsed.registry, parsed.repository, parsed.tag, service.arch);

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

/**
 * @deprecated currentDigest is now set from Portainer's ImageID during sync.
 * Kept for backward compat but effectively a no-op if sync ran first.
 */
export async function initializeDigests() {
  // No-op — currentDigest is set during syncServicesFromPortainer from container.ImageID
}
