import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, isEncrypted } from "@/lib/secretsCrypto";

describe("secretsCrypto", () => {
  describe("encryptSecret", () => {
    it("returns empty string for empty input", () => {
      expect(encryptSecret("")).toBe("");
    });

    it("encrypts a plaintext string", () => {
      const ciphertext = encryptSecret("my-secret-token");
      expect(ciphertext).not.toBe("my-secret-token");
      expect(ciphertext.length).toBeGreaterThan(0);
    });

    it("produces different ciphertext for the same plaintext (random IV)", () => {
      const a = encryptSecret("same-value");
      const b = encryptSecret("same-value");
      expect(a).not.toBe(b);
    });

    it("output is valid base64", () => {
      const ciphertext = encryptSecret("test");
      const buf = Buffer.from(ciphertext, "base64");
      expect(buf.length).toBeGreaterThan(32); // iv(16) + tag(16) + data
    });
  });

  describe("decryptSecret", () => {
    it("returns empty string for empty input", () => {
      expect(decryptSecret("")).toBe("");
    });

    it("round-trips with encryptSecret", () => {
      const original = "ptr_Un5AtqRc+BYmz8Zb9JVVPPnv01x7qQpK0zgXOpW/aKA=";
      const encrypted = encryptSecret(original);
      const decrypted = decryptSecret(encrypted);
      expect(decrypted).toBe(original);
    });

    it("handles unicode", () => {
      const original = "пароль-密码-🔑";
      const decrypted = decryptSecret(encryptSecret(original));
      expect(decrypted).toBe(original);
    });

    it("returns empty string for corrupted ciphertext", () => {
      expect(decryptSecret("not-valid-base64!!!")).toBe("");
    });

    it("returns empty string for tampered ciphertext", () => {
      const encrypted = encryptSecret("secret");
      const tampered = encrypted.slice(0, -4) + "AAAA";
      expect(decryptSecret(tampered)).toBe("");
    });

    it("returns empty string for truncated ciphertext", () => {
      expect(decryptSecret("AAAA")).toBe("");
    });
  });

  describe("isEncrypted", () => {
    it("returns false for empty string", () => {
      expect(isEncrypted("")).toBe(false);
    });

    it("returns false for short string", () => {
      // 32 bytes base64-encoded = 44 chars, but needs >32 bytes decoded
      expect(isEncrypted("c2hvcnQ=")).toBe(false); // "short" = 5 bytes
    });

    it("returns true for encrypted output", () => {
      const encrypted = encryptSecret("test-value");
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it("returns true for any base64 string with >32 bytes", () => {
      // 33 zero bytes in base64
      const fake = Buffer.alloc(33).toString("base64");
      expect(isEncrypted(fake)).toBe(true);
    });
  });
});
