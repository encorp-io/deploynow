import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import { hashPassword, needsRehash, validatePasswordStrength, verifyPassword } from "@/lib/password";

describe("password", () => {
  it("hashes with scrypt and verifies", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong horse battery", hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same-password-123")).not.toBe(await hashPassword("same-password-123"));
  });

  it("still accepts v1 bcrypt hashes and flags them for rehash", async () => {
    const old = await bcrypt.hash("legacy-password-1", 4);
    expect(await verifyPassword("legacy-password-1", old)).toBe(true);
    expect(await verifyPassword("nope", old)).toBe(false);
    expect(needsRehash(old)).toBe(true);
  });

  it("rejects garbage hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "scrypt$bad")).toBe(false);
  });

  it("enforces length", () => {
    expect(validatePasswordStrength("short")).toMatch(/12/);
    expect(validatePasswordStrength(123)).not.toBeNull();
    expect(validatePasswordStrength("x".repeat(300))).not.toBeNull();
    expect(validatePasswordStrength("a-good-long-password")).toBeNull();
  });
});
