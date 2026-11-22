import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/password";
import { revokeAllSessions } from "@/lib/sessions";
import { audit, clientIp } from "@/lib/audit";

/** POST { currentPassword, newPassword }: signs out every other session. */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const body = await readJson(request);
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = body.newPassword;

  const weak = validatePasswordStrength(next);
  if (weak) return NextResponse.json({ error: weak }, { status: 400 });

  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row || !(await verifyPassword(current, row.password))) {
    return NextResponse.json({ error: "Current password is wrong" }, { status: 400 });
  }

  await prisma.user.update({ where: { id: user.id }, data: { password: await hashPassword(next as string) } });
  const revoked = await revokeAllSessions(user.id, user.sid);
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "auth.password_change",
    message: `${user.email} changed their password and signed out ${revoked} other session(s)`,
  });
  return NextResponse.json({ success: true, revokedSessions: revoked });
}
