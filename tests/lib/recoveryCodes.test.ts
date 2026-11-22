import { describe, it, expect } from "vitest";
import { generateRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode, normaliseRecoveryCode } from "@/lib/recoveryCodes";

describe("recovery codes", () => {
  it("generates ten unique codes with matching hashes", () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    codes.forEach((c, i) => {
      expect(looksLikeRecoveryCode(c)).toBe(true);
      expect(hashRecoveryCode(c)).toBe(hashes[i]);
    });
  });

  it("normalises case, spaces and dashes", () => {
    const { codes } = generateRecoveryCodes();
    const messy = ` ${codes[0].toLowerCase().replace("-", " ")} `;
    expect(hashRecoveryCode(messy)).toBe(hashRecoveryCode(codes[0]));
    expect(normaliseRecoveryCode("ab-cd")).toBe(normaliseRecoveryCode("ABCD"));
  });

  it("does not mistake a TOTP code for a recovery code", () => {
    expect(looksLikeRecoveryCode("123456")).toBe(false);
  });
});
