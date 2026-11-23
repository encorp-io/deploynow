import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { savePolicy, serializePolicy } from "@/lib/backup/service";
import { backupError } from "@/lib/backup/http";

export async function GET(request: Request) {
  const gate = await requireUser("backup.view");
  if (!gate.ok) return gate.response;
  const endpointId = new URL(request.url).searchParams.get("endpointId");
  const list = await prisma.backupPolicy.findMany({
    where: endpointId ? { endpointId: endpointId === "instance" ? null : endpointId } : {},
    include: { endpoint: true, destination: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(list.map(serializePolicy));
}

export async function POST(request: Request) {
  const gate = await requireUser("backup.manage");
  if (!gate.ok) return gate.response;
  try {
    const { policy, repo, repoCreated } = await savePolicy(await readJson(request));
    await audit({
      actor: { id: gate.user.id, email: gate.user.email },
      ip: clientIp(request),
      action: "backup.policy.create",
      targetType: "backup_policy",
      targetId: policy.id,
      endpointId: policy.endpointId ?? undefined,
      message: `${gate.user.email} created backup policy ${policy.name}`,
    });
    // A new repository's recovery kit is offered right away
    return NextResponse.json({ ...serializePolicy(policy), repoId: repo.id, kitAvailable: repoCreated || !repo.kitShownAt }, { status: 201 });
  } catch (err) {
    return backupError(err);
  }
}
