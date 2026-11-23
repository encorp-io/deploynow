import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { serializePasskey } from "@/lib/passkeys";

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const rows = await prisma.passkey.findMany({ where: { userId: gate.user.id }, orderBy: { createdAt: "asc" } });
  return NextResponse.json(rows.map(serializePasskey));
}
