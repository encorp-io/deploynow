import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { CHANNEL_TYPES, encryptConfig, EVENTS, parseEvents, validateChannel } from "@/lib/notify";

export async function GET() {
  const gate = await requireUser("notifications.manage");
  if (!gate.ok) return gate.response;
  const channels = await prisma.notificationChannel.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({
    events: EVENTS,
    types: CHANNEL_TYPES,
    channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, events: c.events.split(",").filter(Boolean), enabled: c.enabled, lastError: c.lastError })),
  });
}

export async function POST(request: Request) {
  const gate = await requireUser("notifications.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 64) return NextResponse.json({ error: "Name the channel" }, { status: 400 });
  let config;
  try {
    config = validateChannel(body.type, body);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
  const events = parseEvents(body.events ?? "deploy.failure,deploy.success");
  if (!events) return NextResponse.json({ error: "Pick at least one event" }, { status: 400 });
  const ch = await prisma.notificationChannel.create({ data: { name, type: String(body.type), config: encryptConfig(config), events } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "notification.create", message: `${gate.user.email} added notification channel ${name}` });
  return NextResponse.json({ id: ch.id, ...(body.type === "webhook" ? { secret: config.secret } : {}) }, { status: 201 });
}
