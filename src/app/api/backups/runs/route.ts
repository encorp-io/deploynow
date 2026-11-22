import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { serializeRun } from "@/lib/backup/service";

export async function GET(request: Request) {
  const gate = await requireUser("backup.view");
  if (!gate.ok) return gate.response;
  const q = new URL(request.url).searchParams;
  const take = Math.min(Number(q.get("limit") ?? 50) || 50, 200);
  const where: Record<string, string> = {};
  for (const k of ["policyId", "repoId", "kind", "status"]) {
    const v = q.get(k);
    if (v && /^[a-z0-9_-]{1,40}$/i.test(v)) where[k] = v;
  }
  const runs = await prisma.backupRun.findMany({ where, orderBy: { createdAt: "desc" }, take });
  return NextResponse.json(runs.map((r) => serializeRun(r)));
}
