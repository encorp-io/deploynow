import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/activity?search=...&action=...&sort=desc&page=1&limit=50
 *
 * Returns paginated activity logs with optional search and filter.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim() || "";
  const action = url.searchParams.get("action") || "";       // filter by action type
  const sort   = url.searchParams.get("sort") === "asc" ? "asc" as const : "desc" as const;
  const page   = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit  = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
  const skip   = (page - 1) * limit;

  // Build where clause
  const where: Record<string, unknown> = {};

  if (action) {
    where.action = action;
  }

  if (search) {
    where.OR = [
      { message: { contains: search } },
      { details: { contains: search } },
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: sort },
      skip,
      take: limit,
    }),
    prisma.activityLog.count({ where }),
  ]);

  // Get distinct action types for filter dropdown
  const actionTypes = await prisma.activityLog.findMany({
    select: { action: true },
    distinct: ["action"],
    orderBy: { action: "asc" },
  });

  return NextResponse.json({
    logs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    actionTypes: actionTypes.map((a) => a.action),
  });
}
