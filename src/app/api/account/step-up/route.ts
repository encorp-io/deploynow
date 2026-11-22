import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { verifySecondFactor } from "@/lib/twoFactor";
import { markStepUp } from "@/lib/sessions";
import { isRateLimited, recordFailure, recordSuccess } from "@/lib/rateLimit";

/** POST { code }: confirms 2FA for sensitive actions for the next 10 minutes. */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;

  const key = `stepup:${user.id}`;
  if (await isRateLimited(key)) {
    return NextResponse.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
  }

  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row?.totpEnabledAt) return NextResponse.json({ success: true }); // nothing to confirm

  const { code } = await readJson(request);
  const check = await verifySecondFactor(row, String(code ?? ""));
  if (!check.ok) {
    await recordFailure(key);
    return NextResponse.json({ error: "Code is wrong" }, { status: 400 });
  }
  await recordSuccess(key);
  await markStepUp(user.sid);
  return NextResponse.json({ success: true });
}
