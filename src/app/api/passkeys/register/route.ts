import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { finishRegistration, PasskeyError, registrationOptions, serializePasskey } from "@/lib/passkeys";

/** POST: options for navigator.credentials.create(). */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: gate.user.id } });
  try {
    return NextResponse.json(await registrationOptions(user, request));
  } catch (err) {
    if (err instanceof PasskeyError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}

/** PUT: the browser's answer, plus a name for the passkey. */
export async function PUT(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  if (!body.response || typeof body.response !== "object") return NextResponse.json({ error: "Missing the passkey response" }, { status: 400 });
  try {
    const p = await finishRegistration(gate.user.id, body.response as never, String(body.name ?? ""), request);
    await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "passkey.create", targetType: "user", targetId: gate.user.id, message: `${gate.user.email} added passkey "${p.name}"` });
    return NextResponse.json(serializePasskey(p), { status: 201 });
  } catch (err) {
    if (err instanceof PasskeyError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
}
