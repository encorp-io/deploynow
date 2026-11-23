import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { revokeAllSessions, revokeSession } from "@/lib/sessions";
import { audit, clientIp } from "@/lib/audit";

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const sessions = await prisma.session.findMany({
    where: { userId: gate.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, ip: true, userAgent: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  return NextResponse.json(sessions.map((s) => ({ ...s, current: s.id === gate.user.sid })));
}

/** DELETE ?id=<session> signs out one session; ?others=1 signs out all but this one. */
export async function DELETE(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  const url = new URL(request.url);

  let count = 0;
  if (url.searchParams.get("others") === "1") {
    count = await revokeAllSessions(user.id, user.sid);
  } else {
    const id = url.searchParams.get("id") ?? "";
    if (!/^c[a-z0-9]{24}$/.test(id)) return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
    count = (await revokeSession(id, user.id)) ? 1 : 0;
  }
  await audit({
    actor: { id: user.id, email: user.email },
    ip: clientIp(request),
    action: "auth.session_revoke",
    message: `${user.email} signed out ${count} session(s)`,
  });
  return NextResponse.json({ revoked: count });
}
