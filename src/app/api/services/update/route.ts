import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { performUpdate } from "@/lib/polling";

// cuid v1 pattern — all Prisma-generated IDs match this
const CUID_PATTERN = /^c[a-z0-9]{24}$/;

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Members can trigger a manual update for a specific service;
  // only admins can trigger bulk sync / polling cycles (see /api/services and /api/polling)

  const body = await request.json();
  const { serviceId } = body;

  if (!serviceId || typeof serviceId !== "string" || !CUID_PATTERN.test(serviceId)) {
    return NextResponse.json({ error: "Invalid serviceId" }, { status: 400 });
  }

  try {
    await performUpdate(serviceId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
