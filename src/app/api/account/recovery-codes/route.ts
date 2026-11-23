import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { generateRecoveryCodes } from "@/lib/recoveryCodes";
import { verifySecondFactor } from "@/lib/twoFactor";
import { audit, clientIp } from "@/lib/audit";

/** POST { code } → { recoveryCodes }: replaces all recovery codes. */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row?.totpEnabledAt) return NextResponse.json({ error: "Turn on 2FA first" }, { status: 409 });

  const { code } = await readJson(request);
  const check = await verifySecondFactor(row, String(code ?? ""));
  if (!check.ok || check.method !== "totp") {
    return NextResponse.json({ error: "Enter a code from your authenticator app" }, { status: 400 });
  }

  const { codes, hashes } = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.recoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId: user.id, codeHash })) }),
  ]);
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "auth.recovery_codes_regenerate",
    message: `${user.email} generated new recovery codes`,
  });
  return NextResponse.json({ recoveryCodes: codes });
}
