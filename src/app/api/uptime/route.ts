import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { summarize, UptimeError, validateCheck } from "@/lib/uptime";

export async function GET() {
  const gate = await requireUser("monitoring.view");
  if (!gate.ok) return gate.response;
  const [checks, settings] = await Promise.all([
    prisma.uptimeCheck.findMany({ orderBy: { name: "asc" } }),
    prisma.settings.findUnique({ where: { id: "singleton" } }),
  ]);
  const sums = await summarize(checks);
  return NextResponse.json({
    checks: checks.map((c) => ({ ...c, ...sums.get(c.id) })),
    statusPage: { enabled: settings?.statusPageEnabled ?? false, title: settings?.statusPageTitle ?? "" },
  });
}

export async function POST(request: Request) {
  const gate = await requireUser("uptime.manage");
  if (!gate.ok) return gate.response;
  let data;
  try {
    data = validateCheck(await readJson(request));
  } catch (err) {
    if (err instanceof UptimeError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
  if ((await prisma.uptimeCheck.count()) >= 500) return NextResponse.json({ error: "At most 500 uptime checks" }, { status: 400 });
  const check = await prisma.uptimeCheck.create({ data: { ...data, nextCheckAt: new Date() } });
  await audit({ actor: { id: gate.user.id, email: gate.user.email }, ip: clientIp(request), action: "uptime.create", targetType: "uptime_check", targetId: check.id, message: `${gate.user.email} added uptime check ${check.name} (${check.target})` });
  return NextResponse.json(check, { status: 201 });
}
