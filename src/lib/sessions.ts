import { prisma } from "./prisma";

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours, as in v1
export const STEP_UP_TTL_MS = 10 * 60 * 1000; // re-confirm 2FA every 10 minutes for sensitive actions
const TOUCH_INTERVAL_MS = 60 * 1000;

export async function createSession(userId: string, ip = "", userAgent = ""): Promise<string> {
  const s = await prisma.session.create({
    data: {
      userId,
      ip: ip.slice(0, 64),
      userAgent: userAgent.slice(0, 300),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return s.id;
}

/**
 * Returns the session with its user if it is still valid, or null if it was
 * revoked, expired, belongs to someone other than `userId`, or its user is
 * disabled or gone. Callers that hold a user id from a token must pass it, so a
 * session id can never stand in for another person's session.
 */
export async function loadActiveSession(sid: string | undefined | null, userId?: string | null) {
  if (!sid || typeof sid !== "string") return null;
  if (userId !== undefined && (!userId || typeof userId !== "string")) return null;
  const s = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s || s.revokedAt || s.expiresAt.getTime() < Date.now() || !s.user || s.user.disabledAt) {
    return null;
  }
  if (userId !== undefined && s.userId !== userId) return null;
  if (Date.now() - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.session.update({ where: { id: sid }, data: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return s;
}

export async function revokeSession(id: string, userId?: string): Promise<boolean> {
  const res = await prisma.session.updateMany({
    where: { id, revokedAt: null, ...(userId ? { userId } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

export async function revokeAllSessions(userId: string, exceptId?: string): Promise<number> {
  const res = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return res.count;
}

export async function markStepUp(sid: string): Promise<void> {
  await prisma.session.update({ where: { id: sid }, data: { stepUpAt: new Date() } });
}

export function hasRecentStepUp(stepUpAt: Date | null | undefined, now = Date.now()): boolean {
  return !!stepUpAt && now - stepUpAt.getTime() < STEP_UP_TTL_MS;
}
