import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { createApiToken, serializeToken, TokenError } from "@/lib/apiTokens";

/** The signed-in user's API tokens. */
export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  if (gate.user.tokenId) return NextResponse.json({ error: "Not available with an API token" }, { status: 403 });
  const tokens = await prisma.apiToken.findMany({ where: { userId: gate.user.id }, orderBy: { createdAt: "desc" } });
  return NextResponse.json(tokens.map(serializeToken));
}

/** Create a token. The token itself is returned once. */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  if (user.tokenId) return NextResponse.json({ error: "Not available with an API token" }, { status: 403 });
  try {
    const { token, row } = await createApiToken(user, await readJson(request));
    await audit({ actor: { id: user.id, email: user.email }, ip: clientIp(request), action: "token.create", targetType: "api_token", targetId: row.id, message: `${user.email} created API token ${row.name} (${row.scope})` });
    return NextResponse.json({ ...serializeToken(row), token }, { status: 201 });
  } catch (err) {
    if (err instanceof TokenError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
