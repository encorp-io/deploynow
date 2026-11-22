import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/** Public: the sign-in buttons for the login page. */
export async function GET() {
  const providers = await prisma.ssoProvider.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, type: true } });
  return NextResponse.json(providers);
}
