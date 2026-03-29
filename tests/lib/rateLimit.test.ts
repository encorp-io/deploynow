import { describe, it, expect, beforeEach, vi } from "vitest";

// We need to isolate the module for each test to reset the store
let isRateLimited: typeof import("@/lib/rateLimit").isRateLimited;
let recordFailure: typeof import("@/lib/rateLimit").recordFailure;
let recordSuccess: typeof import("@/lib/rateLimit").recordSuccess;

beforeEach(async () => {
  vi.resetModules();
  // Re-import to get a fresh store
  const mod = await import("@/lib/rateLimit");
  isRateLimited = mod.isRateLimited;
  recordFailure = mod.recordFailure;
  recordSuccess = mod.recordSuccess;
});

describe("rateLimit", () => {
  const email = "test@example.com";

  describe("isRateLimited", () => {
    it("returns false for unknown key", () => {
      expect(isRateLimited("never-seen@test.com")).toBe(false);
    });

    it("returns false after a few failures", () => {
      for (let i = 0; i < 5; i++) recordFailure(email);
      expect(isRateLimited(email)).toBe(false);
    });

    it("returns true after 10 failures", () => {
      for (let i = 0; i < 10; i++) recordFailure(email);
      expect(isRateLimited(email)).toBe(true);
    });

    it("returns true at exactly 10 failures", () => {
      for (let i = 0; i < 10; i++) recordFailure(email);
      expect(isRateLimited(email)).toBe(true);
    });
  });

  describe("recordFailure", () => {
    it("increments count", () => {
      recordFailure(email);
      recordFailure(email);
      // After 2 failures, not yet limited
      expect(isRateLimited(email)).toBe(false);
    });

    it("locks out after MAX_ATTEMPTS", () => {
      for (let i = 0; i < 10; i++) recordFailure(email);
      expect(isRateLimited(email)).toBe(true);
    });

    it("tracks different keys independently", () => {
      for (let i = 0; i < 10; i++) recordFailure("alice@test.com");
      expect(isRateLimited("alice@test.com")).toBe(true);
      expect(isRateLimited("bob@test.com")).toBe(false);
    });
  });

  describe("recordSuccess", () => {
    it("clears rate limit for the key", () => {
      for (let i = 0; i < 10; i++) recordFailure(email);
      expect(isRateLimited(email)).toBe(true);
      recordSuccess(email);
      expect(isRateLimited(email)).toBe(false);
    });

    it("is safe to call for unknown key", () => {
      expect(() => recordSuccess("unknown@test.com")).not.toThrow();
    });
  });

  describe("window expiry", () => {
    it("resets after window expires", () => {
      vi.useFakeTimers();
      for (let i = 0; i < 10; i++) recordFailure(email);
      expect(isRateLimited(email)).toBe(true);

      // Advance past the 15-minute window + lockout
      vi.advanceTimersByTime(16 * 60 * 1000);
      expect(isRateLimited(email)).toBe(false);
      vi.useRealTimers();
    });
  });
});
