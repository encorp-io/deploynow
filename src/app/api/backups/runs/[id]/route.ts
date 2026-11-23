import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { serializeRun } from "@/lib/backup/service";
import { ID_RE } from "@/lib/backup/http";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireUser("backup.view");
  if (!gate.ok) return gate.response;
  const run = ID_RE.test(id) ? await prisma.backupRun.findUnique({ where: { id } }) : null;
  if (!run) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(serializeRun(run, true));
}
