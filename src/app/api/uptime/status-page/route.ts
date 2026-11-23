import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";

/** Turn the public status page on or off and set its title. */
export async function PATCH(request: Request) {
  const gate = await requireUser("uptime.manage");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  const data: { statusPageEnabled?: boolean; statusPageTitle?: string } = {};
  if (body.enabled !== undefined) data.statusPageEnabled = Boolean(body.enabled);
  if (body.title !== undefined) data.statusPageTitle = String(body.title).trim().slice(0, 80);
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "uptime.status_page", message: `${gate.user.email} turned the status page ${s.statusPageEnabled ? "on" : "off"}` });
  return NextResponse.json({ enabled: s.statusPageEnabled, title: s.statusPageTitle });
}
