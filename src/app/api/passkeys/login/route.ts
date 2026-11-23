import { NextResponse } from "next/server";
import { authenticationOptions } from "@/lib/passkeys";
import { isRateLimited } from "@/lib/rateLimit";
import { clientIp } from "@/lib/audit";

/** Public: options for navigator.credentials.get(). */
export async function POST(request: Request) {
  const ip = clientIp(request);
  if (ip && (await isRateLimited(`ip:${ip}`))) return NextResponse.json({ error: "Too many failed attempts. Try again in 15 minutes." }, { status: 429 });
  return NextResponse.json(await authenticationOptions(request));
}
