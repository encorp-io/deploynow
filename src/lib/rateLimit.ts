/**
 * Login throttle stored in the database, so a restart doesn't reset it.
 * Keys are e.g. "email:alice@x.com" and "ip:203.0.113.7".
 */
import { prisma } from "./prisma";

export const MAX_ATTEMPTS = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

export async function isRateLimited(key: string, now = Date.now()): Promise<boolean> {
  const entry = await prisma.loginThrottle.findUnique({ where: { key } });
  if (!entry) return false;
  if (entry.lockedUntil && entry.lockedUntil.getTime() > now) return true;
  if (now - entry.firstAttempt.getTime() > WINDOW_MS) {
    await prisma.loginThrottle.delete({ where: { key } }).catch(() => {});
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export async function recordFailure(key: string, now = Date.now()): Promise<void> {
  const entry = await prisma.loginThrottle.findUnique({ where: { key } });
  if (!entry || now - entry.firstAttempt.getTime() > WINDOW_MS) {
    await prisma.loginThrottle.upsert({
      where: { key },
      create: { key, count: 1, firstAttempt: new Date(now), lockedUntil: null },
      update: { count: 1, firstAttempt: new Date(now), lockedUntil: null },
    });
    return;
  }
  const count = entry.count + 1;
  await prisma.loginThrottle.update({
    where: { key },
    data: { count, lockedUntil: count >= MAX_ATTEMPTS ? new Date(now + LOCKOUT_MS) : entry.lockedUntil },
  });
}

export async function recordSuccess(key: string): Promise<void> {
  await prisma.loginThrottle.delete({ where: { key } }).catch(() => {});
}
