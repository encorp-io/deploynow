/**
 * One-time data upgrade from v1 (Portainer companion) to v2 (standalone).
 * Runs at startup after `prisma db push`; safe to run more than once.
 *
 *   - roles:     v1 admin → owner (oldest admin) / admin, member → operator
 *   - activity:  ActivityLog rows copied into AuditEvent
 *   - endpoints: if none exist and the Docker socket is mounted, add "local"
 *                and attach the services v1 was tracking to it
 */
import { prisma } from "./prisma";
import { DEFAULT_SOCKET, localSocketAvailable } from "./endpoints";

export const CURRENT_SCHEMA_VERSION = 2;

const ACTION_MAP: Record<string, string> = {
  check: "service.check",
  update: "service.update",
  manual_update: "service.update",
  update_available: "service.update_available",
  health_restart: "health.restart",
  error: "system.error",
};

export async function ensureLocalEndpoint(socketPath = DEFAULT_SOCKET): Promise<string | null> {
  if ((await prisma.endpoint.count()) > 0) return null;
  if (!localSocketAvailable(socketPath)) return null;
  const ep = await prisma.endpoint.create({
    data: { name: "local", type: "socket", host: socketPath, labels: "local" },
  });
  await prisma.service.updateMany({ where: { endpointId: null }, data: { endpointId: ep.id } });
  return ep.id;
}

export async function runUpgrade(): Promise<{ upgraded: boolean; localEndpointId: string | null }> {
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton", schemaVersion: CURRENT_SCHEMA_VERSION },
  });

  let upgraded = false;
  if (settings.schemaVersion < 2) {
    // Roles
    const admins = await prisma.user.findMany({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
    const hasOwner = (await prisma.user.count({ where: { role: "owner" } })) > 0;
    if (!hasOwner && admins.length > 0) {
      await prisma.user.update({ where: { id: admins[0].id }, data: { role: "owner" } });
    }
    await prisma.user.updateMany({ where: { role: "member" }, data: { role: "operator" } });
    await prisma.teamInvite.updateMany({ where: { role: "member" }, data: { role: "operator" } });

    // Activity log → audit log
    const logs = await prisma.activityLog.findMany({ orderBy: { createdAt: "asc" } });
    for (const log of logs) {
      await prisma.auditEvent.create({
        data: {
          createdAt: log.createdAt,
          actorType: "system",
          action: ACTION_MAP[log.action] ?? `legacy.${log.action}`,
          outcome: log.action === "error" ? "failure" : "success",
          message: log.message,
          details: log.details,
          serviceId: log.serviceId,
        },
      });
    }
    await prisma.activityLog.deleteMany({});

    await prisma.settings.update({ where: { id: "singleton" }, data: { schemaVersion: 2 } });
    upgraded = true;
    console.log(`[deployer] Upgraded data to v2 (${logs.length} activity entries moved to the audit log)`);
  }

  const localEndpointId = await ensureLocalEndpoint();
  if (localEndpointId) console.log("[deployer] Added the local Docker socket as endpoint \"local\"");

  return { upgraded, localEndpointId };
}
