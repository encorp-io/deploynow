import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({ user: { updateMany: vi.fn() }, recoveryCode: { updateMany: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/secretsCrypto", () => ({ decryptSecret: (v: string) => v }));

import { currentStep, generateTotpSecret, totpAt } from "@/lib/totp";
import { generateRecoveryCodes } from "@/lib/recoveryCodes";
import { mustEnrolTwoFactor, verifySecondFactor } from "@/lib/twoFactor";

const secret = generateTotpSecret();
const user = { id: "u1", totpSecret: secret, totpEnabledAt: new Date(), totpLastStep: 0 };

beforeEach(() => vi.clearAllMocks());

describe("verifySecondFactor", () => {
  it("accepts a current TOTP code and records its step", async () => {
    mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
    const step = currentStep();
    expect(await verifySecondFactor(user, totpAt(secret, step))).toEqual({ ok: true, method: "totp" });
    expect(mockPrisma.user.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "u1", totpLastStep: { lt: expect.any(Number) } } });
  });

  it("loses the race when another login used the step first", async () => {
    mockPrisma.user.updateMany.mockResolvedValue({ count: 0 });
    expect((await verifySecondFactor(user, totpAt(secret, currentStep()))).ok).toBe(false);
  });

  it("accepts an unused recovery code once", async () => {
    const { codes } = generateRecoveryCodes();
    mockPrisma.recoveryCode.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await verifySecondFactor(user, codes[0])).toEqual({ ok: true, method: "recovery" });
    expect((await verifySecondFactor(user, codes[0])).ok).toBe(false);
  });

  it("fails without 2FA enabled or a code", async () => {
    expect((await verifySecondFactor({ ...user, totpEnabledAt: null }, "123456")).ok).toBe(false);
    expect((await verifySecondFactor(user, "")).ok).toBe(false);
    expect((await verifySecondFactor(user, "000000")).ok).toBe(false);
  });
});

describe("mustEnrolTwoFactor", () => {
  it("applies to admins and owners only when required", () => {
    expect(mustEnrolTwoFactor("admin", false, true)).toBe(true);
    expect(mustEnrolTwoFactor("owner", false, true)).toBe(true);
    expect(mustEnrolTwoFactor("operator", false, true)).toBe(false);
    expect(mustEnrolTwoFactor("admin", true, true)).toBe(false);
    expect(mustEnrolTwoFactor("admin", false, false)).toBe(false);
  });
});
