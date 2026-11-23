import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";

/** Revoke one of your tokens (admins can revoke anyone's). */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  if (user.tokenId) return NextResponse.json({ error: "Not available with an API token" }, { status: 403 });
  const t = await prisma.apiToken.findUnique({ where: { id } });
  const isAdmin = user.role === "admin" || user.role === "owner";
  if (!t || (t.userId !== user.id && !isAdmin)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.apiToken.update({ where: { id }, data: { revokedAt: t.revokedAt ?? new Date() } });
  await audit({ actor: { id: user.id, email: user.email }, ip: clientIp(request), action: "token.revoke", targetType: "api_token", targetId: id, message: `${user.email} revoked API token ${t.name}` });
  return NextResponse.json({ success: true });
}
