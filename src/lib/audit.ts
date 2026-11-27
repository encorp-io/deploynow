import { prisma } from "./prisma";

export interface AuditActor {
  id: string;
  email: string;
}

export interface AuditInput {
  actor?: AuditActor | null;
  action: string;
  message: string;
  targetType?: string;
  targetId?: string;
  endpointId?: string | null;
  serviceId?: string | null;
  ip?: string;
  outcome?: "success" | "failure";
  details?: string;
}

/**
 * Write one audit event. Never throws: a failing audit write must not break the
 * action it describes, but it is logged so it can't fail silently.
 */
export async function audit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        actorType: input.actor ? "user" : "system",
        actorId: input.actor?.id ?? null,
        actorEmail: input.actor?.email ?? "",
        action: input.action,
        message: input.message.slice(0, 1000),
        targetType: input.targetType ?? "",
        targetId: input.targetId ?? "",
        endpointId: input.endpointId ?? null,
        serviceId: input.serviceId ?? null,
        ip: input.ip ?? "",
        outcome: input.outcome ?? "success",
        details: (input.details ?? "").slice(0, 4000),
      },
    });
  } catch (err) {
    console.error("[audit] write failed:", err instanceof Error ? err.message : "unknown error");
  }
}

/** Best-effort client IP behind nginx. */
export function clientIp(request: Request | { headers: Headers }): string {
  // nginx sets X-Real-IP: from the TCP peer on :9444, and on :9080 from Traefik only
  // when its X-DeployNow-Proxy-Auth secret matches (nginx/nginx.conf), so clients
  // and other containers on the proxy network can't spoof it.
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim().slice(0, 64);
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "").slice(0, 64);
}
