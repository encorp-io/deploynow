import { prisma } from "./prisma";
import { getContainerLogs, restartContainer } from "./portainer";

export async function runHealthMonitor(): Promise<void> {
  const config = await prisma.healthMonitor.findUnique({
    where: { id: "singleton" },
  });

  if (!config?.enabled) return;

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
  });
  if (!settings?.portainerUrl || !settings?.portainerApiKey) return;

  const prefixList = (config.prefixes ?? "")
    .split("\n")
    .map((p: string) => p.trim().toLowerCase())
    .filter(Boolean);

  const patterns = (config.logPatterns ?? "")
    .split("\n")
    .map((p: string) => p.trim().toLowerCase())
    .filter(Boolean);

  if (patterns.length === 0) return;

  const logWindowSecs = config.logWindow ?? 300;
  const cooldownMs = (config.cooldown ?? 10) * 60 * 1000;
  const endpointId = settings.portainerEndpointId ?? 1;

  const services = await prisma.service.findMany({
    where: { status: "running" },
  });
  const matched = services.filter((s) => {
    const name = s.containerName.toLowerCase();
    return (
      prefixList.length === 0 ||
      prefixList.some((p: string) => name.startsWith(p))
    );
  });

  for (const service of matched) {
    try {
      if (service.lastHealthRestart) {
        const elapsed = Date.now() - service.lastHealthRestart.getTime();
        if (elapsed < cooldownMs) continue;
      }

      const logs = await getContainerLogs(
        endpointId,
        service.containerId,
        logWindowSecs,
      );
      const logsLower = logs.toLowerCase();

      const hit = patterns.find((p: string) => logsLower.includes(p));

      if (!hit) continue;

      await restartContainer(endpointId, service.containerId);

      await prisma.service.update({
        where: { id: service.id },
        data: { lastHealthRestart: new Date() },
      });

      await prisma.activityLog.create({
        data: {
          serviceId: service.id,
          action: "health_restart",
          message: `Restarted ${service.containerName} — log pattern matched`,
          details: `Pattern: "${hit}" in last ${logWindowSecs}s of logs`,
        },
      });

      const webhookUrl = process.env.HEALTH_MONITOR_WEBHOOK_URL;
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            container: service.containerName,
            pattern: hit,
            restartedAt: new Date().toISOString(),
            logWindow: logWindowSecs,
          }),
        }).catch((err: Error) => {
          console.error("[health] Webhook delivery failed:", err.message);
        });
      }

      console.log(
        `[health] Restarted ${service.containerName} — pattern: "${hit}"`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[health] Error checking ${service.containerName}:`,
        message,
      );
      await prisma.activityLog.create({
        data: {
          serviceId: service.id,
          action: "error",
          message: `Health monitor failed for ${service.containerName}: ${message}`,
        },
      });
    }
  }
}
