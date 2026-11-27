import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "./prisma";
import { isRateLimited, recordFailure, recordSuccess } from "./rateLimit";
import { hashPassword, needsRehash, verifyPassword } from "./password";
import { createSession, loadActiveSession, SESSION_TTL_MS } from "./sessions";
import { mustEnrolTwoFactor, verifySecondFactor } from "./twoFactor";
import { normalizeRole } from "./rbac";
import { audit, clientIp } from "./audit";
import { authorizeTicket } from "./ticketLogin";
import { InvalidTwoFactorCode, TooManyAttempts, TwoFactorRequired } from "./authErrors";


// Settings change rarely; cache the 2FA policy for 30 s so the per-request
// session check stays one primary-key lookup.
let policyCache: { value: boolean; at: number } | null = null;
async function requireTwoFactorForAdmins(): Promise<boolean> {
  if (policyCache && Date.now() - policyCache.at < 30_000) return policyCache.value;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  policyCache = { value: s?.require2faForAdmins ?? false, at: Date.now() };
  return policyCache.value;
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        code: { label: "Authentication code", type: "text" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = String(credentials.email).toLowerCase().trim();
        const password = String(credentials.password);
        const code = typeof credentials.code === "string" ? credentials.code.trim() : "";
        const ip = request ? clientIp(request) : "";
        const userAgent = request?.headers.get("user-agent") ?? "";

        const keys = [`email:${email}`, ...(ip ? [`ip:${ip}`] : [])];
        for (const k of keys) {
          if (await isRateLimited(k)) throw new TooManyAttempts();
        }
        const fail = async (reason: string) => {
          for (const k of keys) await recordFailure(k);
          await audit({
            action: "auth.login",
            outcome: "failure",
            message: `Failed sign-in for ${email}: ${reason}`,
            targetType: "user",
            targetId: email,
            ip,
          });
        };

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || user.disabledAt) {
          await fail(user ? "account disabled" : "unknown email");
          return null;
        }

        if (!(await verifyPassword(password, user.password))) {
          await fail("wrong password");
          return null;
        }

        if (user.totpEnabledAt) {
          if (!code) throw new TwoFactorRequired();
          const result = await verifySecondFactor(user, code);
          if (!result.ok) {
            await fail("wrong 2FA code");
            throw new InvalidTwoFactorCode();
          }
          if (result.method === "recovery") {
            await audit({
              actor: { id: user.id, email: user.email },
              action: "auth.recovery_code_used",
              message: `${user.email} signed in with a recovery code`,
              ip,
            });
          }
        }

        for (const k of keys) await recordSuccess(k);

        await prisma.user.update({
          where: { id: user.id },
          data: {
            lastLoginAt: new Date(),
            ...(needsRehash(user.password) ? { password: await hashPassword(password) } : {}),
          },
        });

        const sid = await createSession(user.id, ip, userAgent);
        await audit({
          actor: { id: user.id, email: user.email },
          action: "auth.login",
          message: `${user.email} signed in`,
          ip,
        });

        return { id: user.id, email: user.email, name: user.name, role: normalizeRole(user.role), sid };
      },
    }),
    // Single sign-on and passkeys end in a one-time ticket (see sso.ts) that is
    // exchanged here for a normal session.
    Credentials({
      id: "ticket",
      name: "ticket",
      credentials: {
        ticket: { label: "Ticket", type: "text" },
        code: { label: "Authentication code", type: "text" },
      },
      authorize: (credentials, request) => authorizeTicket(credentials, request),
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.sid = (user as { sid?: string }).sid;
      }
      // Every request re-checks the server-side session, so revoking a session,
      // disabling a user or changing a role takes effect immediately.
      const s = await loadActiveSession(token.sid as string | undefined);
      if (!s) return null;
      const role = normalizeRole(s.user.role);
      token.role = role;
      token.name = s.user.name;
      token.email = s.user.email;
      let secondFactor = !!s.user.totpEnabledAt;
      if (!secondFactor && (role === "admin" || role === "owner")) {
        // A passkey counts as two-factor for the "require 2FA for admins" policy
        secondFactor = (await prisma.passkey.count({ where: { userId: s.user.id } })) > 0;
      }
      token.mfaSetupRequired = mustEnrolTwoFactor(role, secondFactor, await requireTwoFactorForAdmins());
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        const u = session.user as unknown as Record<string, unknown>;
        u.id = token.id;
        u.role = token.role;
        u.sid = token.sid;
        u.mfaSetupRequired = token.mfaSetupRequired;
      }
      return session;
    },
  },
  events: {
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      if (token?.sid) {
        await prisma.session
          .update({ where: { id: token.sid as string }, data: { revokedAt: new Date() } })
          .catch(() => {});
      }
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
    maxAge: SESSION_TTL_MS / 1000,
  },
});
