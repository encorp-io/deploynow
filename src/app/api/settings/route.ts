import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/secretsCrypto";
import { requireUser, readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";

const MASK = "••••••••";

export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return NextResponse.json({
    githubUser: settings?.githubUser ?? "",
    githubToken: settings?.githubToken ? MASK : "",
    pollingInterval: settings?.pollingInterval ?? 60,
    autoUpdateLatest: settings?.autoUpdateLatest ?? false,
    require2faForAdmins: settings?.require2faForAdmins ?? true,
  });
}

export async function PUT(request: Request) {
  const gate = await requireUser("settings.manage");
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  const data: Record<string, unknown> = {};

  if (typeof body.githubUser === "string") {
    data.githubUser = body.githubUser.trim().slice(0, 100);
  }

  if (typeof body.githubToken === "string" && body.githubToken !== MASK) {
    if (body.githubToken.length > 512) {
      return NextResponse.json({ error: "GitHub token too long" }, { status: 400 });
    }
    data.githubToken = body.githubToken ? encryptSecret(body.githubToken) : "";
  }

  if (body.pollingInterval !== undefined) {
    const interval = Number(body.pollingInterval);
    if (!Number.isInteger(interval) || interval < 30 || interval > 3600) {
      return NextResponse.json({ error: "pollingInterval must be an integer between 30 and 3600" }, { status: 400 });
    }
    data.pollingInterval = interval;
  }

  if (body.autoUpdateLatest !== undefined) data.autoUpdateLatest = Boolean(body.autoUpdateLatest);

  if (body.require2faForAdmins !== undefined) {
    // Turning the requirement off weakens every admin account; owners only
    if (!body.require2faForAdmins && gate.user.role !== "owner") {
      return NextResponse.json({ error: "Only an owner can turn off required 2FA" }, { status: 403 });
    }
    data.require2faForAdmins = Boolean(body.require2faForAdmins);
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", schemaVersion: 2, ...data },
  });

  await audit({
    actor: { id: gate.user.id, email: gate.user.email },
    ip: clientIp(request),
    action: "settings.update",
    message: `${gate.user.email} changed settings: ${Object.keys(data).join(", ") || "nothing"}`,
  });

  return NextResponse.json({ success: true });
}
