import { prisma } from "./prisma";
import { decryptSecret } from "./secretsCrypto";
import { verifyTotp } from "./totp";
import { hashRecoveryCode, looksLikeRecoveryCode } from "./recoveryCodes";

export interface TwoFactorUser {
  id: string;
  totpSecret: string;
  totpEnabledAt: Date | null;
  totpLastStep: number;
}

/**
 * Check a TOTP code or a recovery code for a user with 2FA enabled.
 * A TOTP step or a recovery code is consumed on success, so neither can be reused.
 */
export async function verifySecondFactor(
  user: TwoFactorUser,
  code: string,
): Promise<{ ok: boolean; method?: "totp" | "recovery" }> {
  if (!user.totpEnabledAt || !code) return { ok: false };

  const secret = decryptSecret(user.totpSecret);
  if (secret) {
    const step = verifyTotp(secret, code, user.totpLastStep);
    if (step !== null) {
      // Conditional update: two concurrent logins with the same code can't both win
      const res = await prisma.user.updateMany({
        where: { id: user.id, totpLastStep: { lt: step } },
        data: { totpLastStep: step },
      });
      return res.count > 0 ? { ok: true, method: "totp" } : { ok: false };
    }
  }

  if (looksLikeRecoveryCode(code)) {
    const res = await prisma.recoveryCode.updateMany({
      where: { userId: user.id, codeHash: hashRecoveryCode(code), usedAt: null },
      data: { usedAt: new Date() },
    });
    if (res.count > 0) return { ok: true, method: "recovery" };
  }

  return { ok: false };
}

/** Admins and owners must enrol when the instance setting requires it. */
export function mustEnrolTwoFactor(role: string, totpEnabled: boolean, requireForAdmins: boolean): boolean {
  return requireForAdmins && !totpEnabled && (role === "admin" || role === "owner");
}
