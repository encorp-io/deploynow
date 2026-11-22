import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory stand-in for the LoginThrottle table
const store = vi.hoisted(() => new Map<string, { key: string; count: number; firstAttempt: Date; lockedUntil: Date | null }>());
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loginThrottle: {
      findUnique: async ({ where }: { where: { key: string } }) => store.get(where.key) ?? null,
      delete: async ({ where }: { where: { key: string } }) => {
        if (!store.delete(where.key)) throw new Error("not found");
      },
      upsert: async ({ where, create }: { where: { key: string }; create: never }) => store.set(where.key, { ...(create as object) } as never),
      update: async ({ where, data }: { where: { key: string }; data: object }) => store.set(where.key, { ...store.get(where.key)!, ...data }),
    },
  },
}));

import { isRateLimited, recordFailure, recordSuccess, MAX_ATTEMPTS, WINDOW_MS, LOCKOUT_MS } from "@/lib/rateLimit";

const key = "email:test@example.com";
const fail = async (n: number, now = Date.now()) => {
  for (let i = 0; i < n; i++) await recordFailure(key, now);
};

beforeEach(() => store.clear());

describe("rateLimit", () => {
  it("allows unknown keys and a few failures", async () => {
    expect(await isRateLimited(key)).toBe(false);
    await fail(5);
    expect(await isRateLimited(key)).toBe(false);
  });

  it("locks after the maximum number of failures", async () => {
    await fail(MAX_ATTEMPTS);
    expect(await isRateLimited(key)).toBe(true);
    expect(await isRateLimited("email:other@example.com")).toBe(false);
  });

  it("clears on success", async () => {
    await fail(MAX_ATTEMPTS);
    await recordSuccess(key);
    expect(await isRateLimited(key)).toBe(false);
    await recordSuccess(key); // no row: must not throw
  });

  it("forgets failures outside the window", async () => {
    const t0 = Date.now();
    await fail(MAX_ATTEMPTS - 1, t0);
    await recordFailure(key, t0 + WINDOW_MS + 1);
    expect(store.get(key)!.count).toBe(1);
    expect(await isRateLimited(key, t0 + WINDOW_MS + 2)).toBe(false);
  });

  it("stays locked until the lockout ends, then resets", async () => {
    const t0 = Date.now();
    await fail(MAX_ATTEMPTS, t0);
    expect(await isRateLimited(key, t0 + LOCKOUT_MS - 1000)).toBe(true);
    expect(await isRateLimited(key, t0 + Math.max(LOCKOUT_MS, WINDOW_MS) + 1000)).toBe(false);
    expect(store.has(key)).toBe(false);
  });
});
