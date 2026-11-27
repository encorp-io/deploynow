import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { mustEnrolTwoFactor } from "@/lib/twoFactor";
import { hasRecentStepUp } from "@/lib/sessions";

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const [codesLeft, settings, passkeys] = await Promise.all([
    prisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } }),
    prisma.settings.findUnique({ where: { id: "singleton" } }),
    prisma.passkey.count({ where: { userId: user.id } }),
  ]);
  const require2fa = settings?.require2faForAdmins ?? false;

  return NextResponse.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    totpEnabled: user.totpEnabled,
    recoveryCodesLeft: codesLeft,
    passkeys,
    // A passkey satisfies the "2FA for admins" policy too
    mfaSetupRequired: mustEnrolTwoFactor(user.role, user.totpEnabled || passkeys > 0, require2fa),
    twoFactorRequiredForRole: require2fa && (user.role === "admin" || user.role === "owner"),
    stepUpActive: hasRecentStepUp(user.stepUpAt),
  });
}

export async function PATCH(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { name } = await readJson(request);
  const clean = typeof name === "string" ? name.trim() : "";
  if (clean.length < 2 || clean.length > 100) {
    return NextResponse.json({ error: "Name must be 2–100 characters" }, { status: 400 });
  }
  await prisma.user.update({ where: { id: gate.user.id }, data: { name: clean } });
  return NextResponse.json({ success: true });
}
