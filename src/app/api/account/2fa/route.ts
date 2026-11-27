import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { decryptSecret, encryptSecret } from "@/lib/secretsCrypto";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/totp";
import { generateRecoveryCodes } from "@/lib/recoveryCodes";
import { verifySecondFactor, mustEnrolTwoFactor } from "@/lib/twoFactor";
import { verifyPassword } from "@/lib/password";
import { markStepUp } from "@/lib/sessions";
import { audit, clientIp } from "@/lib/audit";

/**
 * POST { action: "setup" }                    → { secret, uri, qr }  (pending until enabled)
 * POST { action: "enable", code }             → { recoveryCodes }    (shown once)
 * POST { action: "disable", code, password }
 */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  const body = await readJson(request);
  const ip = clientIp(request);
  const actor = { id: user.id, email: user.email };

  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (body.action === "setup") {
    if (row.totpEnabledAt) return NextResponse.json({ error: "2FA is already on" }, { status: 409 });
    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: user.id }, data: { totpPending: encryptSecret(secret) } });
    const uri = otpauthUri(secret, user.email);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    return NextResponse.json({ secret, uri, qr });
  }

  if (body.action === "enable") {
    if (row.totpEnabledAt) return NextResponse.json({ error: "2FA is already on" }, { status: 409 });
    const secret = decryptSecret(row.totpPending);
    if (!secret) return NextResponse.json({ error: "Start the setup again" }, { status: 400 });
    const step = verifyTotp(secret, String(body.code ?? ""), 0);
    if (step === null) return NextResponse.json({ error: "That code didn't match. Check your phone's clock and try again." }, { status: 400 });

    const { codes, hashes } = generateRecoveryCodes();
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { totpSecret: row.totpPending, totpPending: "", totpEnabledAt: new Date(), totpLastStep: step },
      }),
      prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
      prisma.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId: user.id, codeHash })) }),
    ]);
    await markStepUp(user.sid);
    await audit({ actor, ip, action: "auth.2fa_enable", message: `${user.email} turned on 2FA` });
    return NextResponse.json({ recoveryCodes: codes });
  }

  if (body.action === "disable") {
    if (!row.totpEnabledAt) return NextResponse.json({ error: "2FA is not on" }, { status: 409 });
    const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
    if (mustEnrolTwoFactor(user.role, false, settings?.require2faForAdmins ?? false)) {
      return NextResponse.json({ error: "2FA is required for your role" }, { status: 403 });
    }
    if (!(await verifyPassword(String(body.password ?? ""), row.password))) {
      return NextResponse.json({ error: "Password is wrong" }, { status: 400 });
    }
    const check = await verifySecondFactor(row, String(body.code ?? ""));
    if (!check.ok) return NextResponse.json({ error: "Code is wrong" }, { status: 400 });

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { totpSecret: "", totpPending: "", totpEnabledAt: null, totpLastStep: 0 },
      }),
      prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    ]);
    await audit({ actor, ip, action: "auth.2fa_disable", message: `${user.email} turned off 2FA` });
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
