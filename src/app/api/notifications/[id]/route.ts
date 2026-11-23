import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { decryptConfig, encryptConfig, EVENTS, sendTo, validateChannel } from "@/lib/notify";
import { ID_RE } from "@/lib/apps/access";

type Params = { params: Promise<{ id: string }> };

async function load(id: string) {
  return ID_RE.test(id) ? prisma.notificationChannel.findUnique({ where: { id } }) : null;
}

export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("notifications.manage");
  if (!gate.ok) return gate.response;
  const ch = await load(id);
  if (!ch) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  const body = await readJson(request);
  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = String(body.name).trim().slice(0, 64) || ch.name;
  if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
  if (body.events !== undefined) {
    const list = (Array.isArray(body.events) ? body.events : String(body.events).split(",")).map(String).filter((e) => (EVENTS as readonly string[]).includes(e));
    if (!list.length) return NextResponse.json({ error: "Pick at least one event" }, { status: 400 });
    data.events = [...new Set(list)].join(",");
  }
  if (body.url !== undefined || body.botToken !== undefined || body.chatId !== undefined) {
    try {
      data.config = encryptConfig(validateChannel(ch.type, body, decryptConfig(ch.config)));
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }
  }
  await prisma.notificationChannel.update({ where: { id }, data });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "notification.update", message: `${gate.user.email} updated notification channel ${ch.name}` });
  return NextResponse.json({ success: true });
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("notifications.manage");
  if (!gate.ok) return gate.response;
  const ch = await load(id);
  if (!ch) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  await prisma.notificationChannel.delete({ where: { id } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "notification.delete", message: `${gate.user.email} removed notification channel ${ch.name}` });
  return NextResponse.json({ success: true });
}

/** Send a test message. */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await requireUser("notifications.manage");
  if (!gate.ok) return gate.response;
  const ch = await load(id);
  if (!ch) return NextResponse.json({ error: "Channel not found" }, { status: 404 });
  try {
    await sendTo(ch, { event: "deploy.success", ok: true, title: "Test message from DeployNow", text: `Sent by ${gate.user.email}` });
    await prisma.notificationChannel.update({ where: { id }, data: { lastError: "" } });
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = (err as Error).message.slice(0, 300);
    await prisma.notificationChannel.update({ where: { id }, data: { lastError: msg } });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
