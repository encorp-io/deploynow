import { NextResponse } from "next/server";
import { readJson, requireStepUp } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { appGate } from "@/lib/apps/access";
import { readStoredEnv } from "@/lib/apps/env";
import { decryptSecret } from "@/lib/secretsCrypto";

type Params = { params: Promise<{ id: string }> };

/** Reveal one secret env var: admins only, after a fresh 2FA code, always audited. */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.secrets");
  if (!gate.ok) return gate.response;
  const stepUp = requireStepUp(gate.user);
  if (stepUp) return stepUp;
  const body = await readJson(request);
  const key = String(body.key ?? "");
  const entry = readStoredEnv(gate.app.env).find((e) => e.key === key && e.kind === "secret");
  if (!entry) return NextResponse.json({ error: "No secret with that name" }, { status: 404 });
  const value = decryptSecret(entry.value);
  await audit({
    actor: { id: gate.user.id, email: gate.user.email },
    ip: clientIp(request),
    action: "secret.reveal",
    message: `${gate.user.email} revealed ${key} of ${gate.app.name}`,
    targetType: "application",
    targetId: id,
    endpointId: gate.app.endpointId,
  });
  return NextResponse.json({ key, value });
}
