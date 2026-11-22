import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";

/**
 * GET /api/activity?search=&action=&outcome=&endpointId=&sort=desc&page=1&limit=50
 * The audit log: every sign-in, console session, container action and update.
 */
export async function GET(request: Request) {
  const gate = await requireUser("audit.view");
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim().slice(0, 200) || "";
  const action = url.searchParams.get("action") || "";
  const outcome = url.searchParams.get("outcome") || "";
  const endpointId = url.searchParams.get("endpointId") || "";
  const sort = url.searchParams.get("sort") === "asc" ? ("asc" as const) : ("desc" as const);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50") || 50));

  const where: Record<string, unknown> = {};
  if (action) where.action = action;
  if (outcome === "success" || outcome === "failure") where.outcome = outcome;
  if (endpointId) where.endpointId = endpointId;
  if (search) {
    where.OR = [
      { message: { contains: search } },
      { details: { contains: search } },
      { actorEmail: { contains: search } },
    ];
  }

  const [logs, total, actionTypes, endpoints] = await Promise.all([
    prisma.auditEvent.findMany({ where, orderBy: { createdAt: sort }, skip: (page - 1) * limit, take: limit }),
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({ select: { action: true }, distinct: ["action"], orderBy: { action: "asc" } }),
    prisma.endpoint.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return NextResponse.json({
    logs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    actionTypes: actionTypes.map((a) => a.action),
    endpoints,
  });
}
