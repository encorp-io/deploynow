import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncServices, checkForUpdates } from "@/lib/polling";
import { requireUser, readJson } from "@/lib/apiAuth";

export async function POST(request: Request) {
  const gate = await requireUser("polling.run");
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  if (body.action === "check") {
    await syncServices();
    await checkForUpdates();
    return NextResponse.json({ success: true, timestamp: new Date() });
  }
  if (body.action === "init") {
    await syncServices();
    return NextResponse.json({ success: true });
  }
  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

/** Recent events for the dashboard feed. */
export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const logs = await prisma.auditEvent.findMany({
    where: { action: { startsWith: "service." } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, serviceId: true, action: true, outcome: true, message: true, details: true, createdAt: true },
  });
  return NextResponse.json(logs);
}
