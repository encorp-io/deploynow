import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { serializeRepo } from "@/lib/backup/service";

export async function GET() {
  const gate = await requireUser("backup.view");
  if (!gate.ok) return gate.response;
  const repos = await prisma.backupRepo.findMany({ include: { destination: true }, orderBy: { createdAt: "asc" } });
  return NextResponse.json(await Promise.all(repos.map(serializeRepo)));
}
