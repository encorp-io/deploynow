import { describe, it, expect } from "vitest";
import { getSessionRole, getSessionUserId, isAdmin } from "@/lib/sessionHelpers";

describe("sessionHelpers", () => {
  describe("getSessionRole", () => {
    it("returns role from session", () => {
      expect(getSessionRole({ user: { role: "admin" } })).toBe("admin");
    });

    it("returns member role", () => {
      expect(getSessionRole({ user: { role: "member" } })).toBe("member");
    });

    it("returns undefined for missing user", () => {
      expect(getSessionRole({})).toBeUndefined();
    });

    it("returns undefined for null session", () => {
      expect(getSessionRole(null)).toBeUndefined();
    });

    it("returns undefined for undefined session", () => {
      expect(getSessionRole(undefined)).toBeUndefined();
    });
  });

  describe("getSessionUserId", () => {
    it("returns id from session", () => {
      expect(getSessionUserId({ user: { id: "abc123" } })).toBe("abc123");
    });

    it("returns empty string for missing user", () => {
      expect(getSessionUserId({})).toBe("");
    });

    it("returns empty string for null session", () => {
      expect(getSessionUserId(null)).toBe("");
    });
  });

  describe("isAdmin", () => {
    it("returns true for admin role", () => {
      expect(isAdmin({ user: { role: "admin" } })).toBe(true);
    });

    it("returns false for member role", () => {
      expect(isAdmin({ user: { role: "member" } })).toBe(false);
    });

    it("returns false for null session", () => {
      expect(isAdmin(null)).toBe(false);
    });

    it("returns false for empty session", () => {
      expect(isAdmin({})).toBe(false);
    });

    it("returns false for missing role", () => {
      expect(isAdmin({ user: {} })).toBe(false);
    });
  });
});
