import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { projectGate } from "@/lib/apps/access";
import { readHistory } from "@/lib/containerMetrics";
import { appsOf } from "@/lib/usageSummary";

/** What every app in the project uses now, per service and in total, with the last hour as a trend. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await projectGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const apps = await prisma.application.findMany({ where: { environment: { projectId: id } }, select: { id: true } });
  const now = Date.now();
  const h = apps.length ? await readHistory({ applicationId: { in: apps.map((a) => a.id) } }, "1h", now) : null;
  return NextResponse.json({ at: new Date(now).toISOString(), apps: h ? Object.fromEntries(appsOf(h, now)) : {} });
}
