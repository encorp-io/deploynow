/**
 * Simple in-memory rate limiter for the Node.js runtime.
 * Tracks failed login attempts per identifier (email or IP).
 */

interface RateLimitEntry {
  count: number;
  firstAttempt: number;
  lockedUntil: number;
}

const store = new Map<string, RateLimitEntry>();

const MAX_ATTEMPTS = 10;          // max failures before lockout
const WINDOW_MS    = 15 * 60 * 1000; // 15-minute window
const LOCKOUT_MS   = 15 * 60 * 1000; // 15-minute lockout

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry) return false;

  // If locked, check if lockout has expired
  if (entry.lockedUntil > now) return true;

  // If window expired, reset
  if (now - entry.firstAttempt > WINDOW_MS) {
    store.delete(key);
    return false;
  }

  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailure(key: string): void {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    store.set(key, { count: 1, firstAttempt: now, lockedUntil: 0 });
    return;
  }

  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
}

export function recordSuccess(key: string): void {
  store.delete(key);
}

// Purge stale entries every 30 minutes to prevent memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now - entry.firstAttempt > WINDOW_MS * 2) {
      store.delete(key);
    }
  }
}, 30 * 60 * 1000).unref();
