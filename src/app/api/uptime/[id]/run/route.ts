import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { runCheck } from "@/lib/uptime";

/** Run a check now and return the result. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser("uptime.manage");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const check = await prisma.uptimeCheck.findUnique({ where: { id } });
  if (!check) return NextResponse.json({ error: "Uptime check not found" }, { status: 404 });
  return NextResponse.json(await runCheck(check));
}
