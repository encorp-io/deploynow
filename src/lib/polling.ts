import { prisma } from "./prisma";
import { getContainers, parseImageRef, isFloatingTag, pullImage, recreateContainer } from "./portainer";
import { getRemoteDigest } from "./ghcr";

let pollingTimer: ReturnType<typeof setInterval> | null = null;

export async function syncServicesFromPortainer() {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
  });
  if (!settings?.portainerUrl || !settings?.portainerApiKey) return;

  const containers = await getContainers(1);

  for (const container of containers) {
    const name = container.Names[0]?.replace(/^\//, "") || container.Id.slice(0, 12);
    const parsed = parseImageRef(container.Image);

    await prisma.service.upsert({
      where: { containerId: container.Id },
      update: {
        containerName: name,
        image: parsed.full,
        registry: parsed.registry,
        tag: parsed.tag,
        status: container.State?.toLowerCase() || "unknown",
        isFloatingTag: isFloatingTag(parsed.tag),
      },
      create: {
        containerId: container.Id,
        containerName: name,
        image: parsed.full,
        registry: parsed.registry,
        tag: parsed.tag,
        status: container.State?.toLowerCase() || "unknown",
        isFloatingTag: isFloatingTag(parsed.tag),
      },
    });
  }

  // Remove services for containers that no longer exist
  const activeIds = containers.map((c) => c.Id);
  await prisma.service.deleteMany({
    where: {
      containerId: { notIn: activeIds },
    },
  });
}

export async function checkForUpdates() {
  const services = await prisma.service.findMany();
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
  });

  for (const service of services) {
    try {
      const parsed = parseImageRef(service.image);
      const remoteDigest = await getRemoteDigest(
        parsed.registry,
        parsed.repository,
        parsed.tag
      );

      if (!remoteDigest) continue;

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

      if (hasUpdate && service.isFloatingTag && settings?.autoUpdateLatest) {
        // Auto-update floating tags
        await performUpdate(service.id);
      } else if (hasUpdate) {
        await prisma.activityLog.create({
          data: {
            serviceId: service.id,
            action: "update_available",
            message: `New version available for ${service.containerName}`,
            details: `Current: ${service.currentDigest.slice(0, 16)}... Remote: ${remoteDigest.slice(0, 16)}...`,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await prisma.activityLog.create({
        data: {
          serviceId: service.id,
          action: "error",
          message: `Check failed for ${service.containerName}: ${message}`,
        },
      });
    }
  }
}

export async function performUpdate(serviceId: string) {
  const service = await prisma.service.findUnique({ where: { id: serviceId } });
  if (!service) throw new Error("Service not found");

  await prisma.service.update({
    where: { id: serviceId },
    data: { status: "updating" },
  });

  try {
    // 1. Pull the latest image
    await pullImage(1, service.image);

    // 2. Recreate the container
    const newContainerId = await recreateContainer(1, service.containerId);

    // 3. Get the new digest
    const parsed = parseImageRef(service.image);
    const newDigest = await getRemoteDigest(
      parsed.registry,
      parsed.repository,
      parsed.tag
    );

    // 4. Update the database
    await prisma.service.update({
      where: { id: serviceId },
      data: {
        containerId: newContainerId,
        currentDigest: newDigest || "",
        remoteDigest: newDigest || "",
        updateAvailable: false,
        status: "running",
        lastUpdated: new Date(),
      },
    });

    await prisma.activityLog.create({
      data: {
        serviceId: serviceId,
        action: "update",
        message: `Updated ${service.containerName} successfully`,
        details: `New digest: ${newDigest?.slice(0, 16) || "unknown"}...`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.service.update({
      where: { id: serviceId },
      data: { status: "error" },
    });
    await prisma.activityLog.create({
      data: {
        serviceId: serviceId,
        action: "error",
        message: `Update failed for ${service.containerName}: ${message}`,
      },
    });
    throw error;
  }
}

export async function initializeDigests() {
  // On first sync, set currentDigest to match remote so we don't trigger immediate updates
  const services = await prisma.service.findMany({
    where: { currentDigest: "" },
  });

  for (const service of services) {
    try {
      const parsed = parseImageRef(service.image);
      const digest = await getRemoteDigest(
        parsed.registry,
        parsed.repository,
        parsed.tag
      );
      if (digest) {
        await prisma.service.update({
          where: { id: service.id },
          data: {
            currentDigest: digest,
            remoteDigest: digest,
            lastChecked: new Date(),
          },
        });
      }
    } catch {
      // Skip on error
    }
  }
}

export function startPolling(intervalSeconds: number = 60) {
  stopPolling();
  pollingTimer = setInterval(async () => {
    try {
      await syncServicesFromPortainer();
      await checkForUpdates();
    } catch (error) {
      console.error("Polling error:", error);
    }
  }, intervalSeconds * 1000);
}

export function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}
