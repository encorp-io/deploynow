import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { syncServicesFromPortainer, initializeDigests } from "@/lib/polling";
import { isAdmin } from "@/lib/sessionHelpers";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const services = await prisma.service.findMany({
    orderBy: { containerName: "asc" },
  });

  return NextResponse.json(services);
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await request.json();

  if (body.action === "sync") {
    await syncServicesFromPortainer();
    await initializeDigests();
    const services = await prisma.service.findMany({
      orderBy: { containerName: "asc" },
    });
    return NextResponse.json(services);
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
