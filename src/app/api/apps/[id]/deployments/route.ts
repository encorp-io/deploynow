import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { appGate, serializeDeployment } from "@/lib/apps/access";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const take = Math.min(Number(new URL(request.url).searchParams.get("limit")) || 30, 100);
  const deployments = await prisma.deployment.findMany({ where: { applicationId: id }, orderBy: { createdAt: "desc" }, take });
  return NextResponse.json(deployments.map(serializeDeployment));
}
