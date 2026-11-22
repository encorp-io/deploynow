import { NextResponse } from "next/server";
import { createTicket, finishLogin, SsoError } from "@/lib/sso";
import { publicOrigin } from "@/lib/publicOrigin";
import { audit, clientIp } from "@/lib/audit";
import { recordFailure } from "@/lib/rateLimit";

/** Public: the provider sends the browser back here with a code. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fallback = publicOrigin(request);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const ip = clientIp(request);
  const back = (origin: string, q: Record<string, string>) => NextResponse.redirect(`${origin}/login?${new URLSearchParams(q)}`);
  if (url.searchParams.get("error")) return back(fallback, { error: "sso_cancelled" });
  if (!state || !code) return back(fallback, { error: "sso_failed" });
  try {
    const { user, provider, origin } = await finishLogin({ state, code });
    const ticket = await createTicket(user.id, "sso", provider.name);
    return back(origin, { ticket });
  } catch (err) {
    if (ip) await recordFailure(`ip:${ip}`);
    const message = err instanceof SsoError ? err.message : "Single sign-on failed";
    if (!(err instanceof SsoError)) console.error("[sso] callback failed:", err);
    await audit({ action: "auth.login", outcome: "failure", message: `Failed single sign-on: ${message}`, ip });
    return back(fallback, { error: "sso_failed", message: message.slice(0, 200) });
  }
}
