import { NextResponse } from "next/server";
import { readJson } from "@/lib/apiAuth";
import { finishAuthentication, PasskeyError } from "@/lib/passkeys";
import { createTicket } from "@/lib/sso";
import { isRateLimited, recordFailure } from "@/lib/rateLimit";
import { audit, clientIp } from "@/lib/audit";

/** Public: verify the browser's answer and hand back a one-time login ticket. */
export async function POST(request: Request) {
  const ip = clientIp(request);
  if (ip && (await isRateLimited(`ip:${ip}`))) return NextResponse.json({ error: "Too many failed attempts. Try again in 15 minutes." }, { status: 429 });
  const body = await readJson(request);
  const response = body.response as { id?: unknown; response?: { clientDataJSON?: unknown } } | undefined;
  if (!response || typeof response.id !== "string" || typeof response.response?.clientDataJSON !== "string") {
    return NextResponse.json({ error: "Missing the passkey response" }, { status: 400 });
  }
  try {
    const passkey = await finishAuthentication(response as never, request);
    return NextResponse.json({ ticket: await createTicket(passkey.userId, "passkey", passkey.name) });
  } catch (err) {
    if (!(err instanceof PasskeyError)) throw err;
    if (ip) await recordFailure(`ip:${ip}`);
    await audit({ action: "auth.login", outcome: "failure", message: `Failed passkey sign-in: ${err.message}`, ip });
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
