import { prisma } from "./prisma";
import { dockerFor } from "./endpoints";
import { logBufferToText, stripControl } from "./docker/streams";
import { withTimeout } from "./docker/client";
import { audit } from "./audit";

/**
 * Restart running containers whose recent logs contain a failure pattern
 * (DB timeouts, OOM, panics…), at most once per cooldown per container.
 */
export async function runHealthMonitor(): Promise<void> {
  const config = await prisma.healthMonitor.findUnique({ where: { id: "singleton" } });
  if (!config?.enabled) return;

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

  const services = await prisma.service.findMany({
    where: { status: "running", endpoint: { status: "online" } },
    include: { endpoint: true },
  });
  const matched = services.filter((s) => {
    const name = s.containerName.toLowerCase();
    return prefixList.length === 0 || prefixList.some((p: string) => name.startsWith(p));
  });

  for (const service of matched) {
    if (!service.endpoint) continue;
    try {
      if (service.lastHealthRestart && Date.now() - service.lastHealthRestart.getTime() < cooldownMs) continue;

      const container = dockerFor(service.endpoint).getContainer(service.containerId);
      const raw = await withTimeout(
        container.logs({
          stdout: true,
          stderr: true,
          since: Math.floor(Date.now() / 1000) - logWindowSecs,
          follow: false,
        }) as unknown as Promise<Buffer>,
        15_000,
        "Reading logs",
      );
      const logsLower = stripControl(logBufferToText(raw)).toLowerCase();
      const hit = patterns.find((p: string) => logsLower.includes(p));
      if (!hit) continue;

      await container.restart({ t: 10 });
      await prisma.service.update({ where: { id: service.id }, data: { lastHealthRestart: new Date() } });
      await audit({
        action: "health.restart",
        message: `Restarted ${service.containerName} on ${service.endpoint.name}: log pattern matched`,
        details: `Pattern: "${hit}" in last ${logWindowSecs}s of logs`,
        targetType: "container",
        targetId: service.containerId,
        endpointId: service.endpointId,
        serviceId: service.id,
      });

      const webhookUrl = process.env.HEALTH_MONITOR_WEBHOOK_URL;
      if (webhookUrl) {
        fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            container: service.containerName,
            endpoint: service.endpoint.name,
            pattern: hit,
            restartedAt: new Date().toISOString(),
            logWindow: logWindowSecs,
          }),
        }).catch((err: Error) => console.error("[health] Webhook delivery failed:", err.message));
      }
      console.log(`[health] Restarted ${service.containerName}: pattern "${hit}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[health] Error checking ${service.containerName}:`, message);
      await audit({
        action: "health.check",
        outcome: "failure",
        message: `Health monitor failed for ${service.containerName}: ${message}`,
        targetType: "container",
        targetId: service.containerId,
        endpointId: service.endpointId,
        serviceId: service.id,
      });
    }
  }
}
