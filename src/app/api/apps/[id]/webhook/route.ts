import crypto from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit, clientIp } from "@/lib/audit";
import { appGate, publicOrigin } from "@/lib/apps/access";
import { decryptSecret, encryptSecret } from "@/lib/secretsCrypto";
import { requireStepUp } from "@/lib/apiAuth";

type Params = { params: Promise<{ id: string }> };

/** Show the GitHub webhook secret (step-up), so it can be pasted into GitHub. */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const stepUp = requireStepUp(gate.user);
  if (stepUp) return stepUp;
  return NextResponse.json({ url: `${publicOrigin(request)}/api/webhooks/github/${id}`, secret: decryptSecret(gate.app.webhookSecret) });
}

/** Make a new secret; the old one stops working. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.manage");
  if (!gate.ok) return gate.response;
  const stepUp = requireStepUp(gate.user);
  if (stepUp) return stepUp;
  const secret = crypto.randomBytes(24).toString("hex");
  await prisma.application.update({ where: { id }, data: { webhookSecret: encryptSecret(secret) } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "app.webhook_rotate", message: `${gate.user.email} made a new webhook secret for ${gate.app.name}`, targetType: "application", targetId: id, endpointId: gate.app.endpointId });
  return NextResponse.json({ url: `${publicOrigin(request)}/api/webhooks/github/${id}`, secret });
}
