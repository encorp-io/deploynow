/**
 * The "ticket" sign-in: single sign-on and passkeys hand the login page a
 * one-time ticket, which becomes a normal session here.
 */
import { prisma } from "./prisma";
import { isRateLimited, recordFailure } from "./rateLimit";
import { createSession } from "./sessions";
import { verifySecondFactor } from "./twoFactor";
import { normalizeRole } from "./rbac";
import { audit, clientIp } from "./audit";
import { consumeTicket, peekTicket } from "./sso";
import { InvalidTwoFactorCode, TooManyAttempts, TwoFactorRequired } from "./authErrors";

export async function authorizeTicket(credentials: Partial<Record<string, unknown>> | undefined, request: Request | undefined) {
  const ticket = typeof credentials?.ticket === "string" ? credentials.ticket : "";
  const code = typeof credentials?.code === "string" ? credentials.code.trim() : "";
  const ip = request ? clientIp(request) : "";
  const userAgent = request?.headers.get("user-agent") ?? "";
  if (ip && (await isRateLimited(`ip:${ip}`))) throw new TooManyAttempts();
  const t = await peekTicket(ticket);
  if (!t) {
    if (ip) await recordFailure(`ip:${ip}`);
    return null;
  }
  const user = await prisma.user.findUnique({ where: { id: t.userId } });
  if (!user || user.disabledAt) return null;
  // A passkey is already two factors (possession plus the device's own check).
  // SSO is one factor, so an account with an authenticator app still needs its code.
  if (t.method === "sso" && user.totpEnabledAt) {
    if (await isRateLimited(`email:${user.email}`)) throw new TooManyAttempts();
    if (!code) throw new TwoFactorRequired();
    const result = await verifySecondFactor(user, code);
    if (!result.ok) {
      await recordFailure(`email:${user.email}`);
      await audit({ action: "auth.login", outcome: "failure", message: `Failed sign-in for ${user.email}: wrong 2FA code after ${t.detail}`, targetType: "user", targetId: user.email, ip });
      throw new InvalidTwoFactorCode();
    }
  }
  if (!(await consumeTicket(ticket))) return null;
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const sid = await createSession(user.id, ip, userAgent);
  await audit({
    actor: { id: user.id, email: user.email },
    action: "auth.login",
    message: `${user.email} signed in with ${t.method === "sso" ? t.detail : `a passkey (${t.detail})`}`,
    ip,
  });
  return { id: user.id, email: user.email, name: user.name, role: normalizeRole(user.role), sid };
}
