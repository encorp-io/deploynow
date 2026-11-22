import { describe, it, expect } from "vitest";
import { base32Decode, base32Encode, currentStep, generateTotpSecret, otpauthUri, totpAt, verifyTotp } from "@/lib/totp";

// RFC 6238 appendix B, SHA-1 secret "12345678901234567890"
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));

describe("totp", () => {
  it("round-trips base32", () => {
    const buf = Buffer.from("hello world, 2fa");
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Decode(base32Encode(buf).toLowerCase())).toEqual(buf);
  });

  it("matches the RFC 6238 test vectors (6 digits)", () => {
    expect(totpAt(RFC_SECRET, currentStep(59_000))).toBe("287082");
    expect(totpAt(RFC_SECRET, currentStep(1111111109_000))).toBe("081804");
    expect(totpAt(RFC_SECRET, currentStep(1234567890_000))).toBe("005924");
  });

  it("accepts the current and adjacent steps only", () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), 0, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), 0, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), 0, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 3), 0, now)).toBeNull();
  });

  it("rejects replays and malformed codes", () => {
    const now = 1_700_000_000_000;
    const step = currentStep(now);
    const code = totpAt(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, step, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", 0, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code.slice(0, 3) + " " + code.slice(3), 0, now)).toBe(step);
  });

  it("generates 160-bit secrets and a provisioning URI", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    const uri = otpauthUri(secret, "a@b.co");
    expect(uri.startsWith("otpauth://totp/DeployNow%3Aa%40b.co?")).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
  });
});
