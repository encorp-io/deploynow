import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { serializeProvider, SsoError, validateProvider, callbackUrl } from "@/lib/sso";
import { publicOrigin } from "@/lib/apps/access";

export async function GET(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  const providers = await prisma.ssoProvider.findMany({ orderBy: { createdAt: "asc" }, include: { _count: { select: { identities: true } } } });
  return NextResponse.json({
    redirectUri: callbackUrl(publicOrigin(request)),
    providers: providers.map((p) => ({ ...serializeProvider(p), linkedUsers: p._count.identities })),
  });
}

export async function POST(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;
  try {
    const v = validateProvider(await readJson(request));
    const p = await prisma.ssoProvider.create({ data: { ...v, clientSecret: v.clientSecret! } });
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "sso.create", targetType: "sso", targetId: p.id, message: `${gate.user.email} added sign-in with ${p.name}` });
    return NextResponse.json(serializeProvider(p), { status: 201 });
  } catch (err) {
    if (err instanceof SsoError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
