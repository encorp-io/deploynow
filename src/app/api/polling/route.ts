import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { syncServicesFromPortainer, checkForUpdates, initializeDigests } from "@/lib/polling";
import { prisma } from "@/lib/prisma";
import { isAdmin } from "@/lib/sessionHelpers";

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await request.json();

  if (body.action === "check") {
    await syncServicesFromPortainer();
    await checkForUpdates();
    return NextResponse.json({ success: true, timestamp: new Date() });
  }

  if (body.action === "init") {
    await syncServicesFromPortainer();
    await initializeDigests();
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const logs = await prisma.activityLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      serviceId: true,
      action: true,
      message: true,
      details: true,
      createdAt: true,
    },
  });

  return NextResponse.json(logs);
}
