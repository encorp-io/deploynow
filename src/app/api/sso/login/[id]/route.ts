import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { startLogin } from "@/lib/sso";
import { publicOrigin } from "@/lib/publicOrigin";
import { isRateLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

/** Public: send the browser to the provider. */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const origin = publicOrigin(request);
  const ip = clientIp(request);
  if (ip && (await isRateLimited(`ip:${ip}`))) return NextResponse.redirect(`${origin}/login?error=rate_limited`);
  const provider = await prisma.ssoProvider.findUnique({ where: { id } });
  if (!provider || !provider.enabled) return NextResponse.redirect(`${origin}/login?error=sso_unavailable`);
  try {
    return NextResponse.redirect(await startLogin(provider, origin));
  } catch (err) {
    console.error("[sso] start failed:", err);
    return NextResponse.redirect(`${origin}/login?error=sso_unavailable`);
  }
}
