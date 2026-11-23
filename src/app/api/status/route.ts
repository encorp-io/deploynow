import { NextResponse } from "next/server";
import { publicStatus } from "@/lib/statusPage";

/** The public status page's data: names, states and uptime of the public checks, never their targets. */
export async function GET() {
  const status = await publicStatus();
  if (!status) return NextResponse.json({ error: "The status page is turned off" }, { status: 404 });
  return NextResponse.json(status, { headers: { "Cache-Control": "public, max-age=30" } });
}
