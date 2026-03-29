import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
  });

  if (!settings) {
    return NextResponse.json({
      portainerUrl: "",
      portainerApiKey: "",
      githubToken: "",
      pollingInterval: 60,
      autoUpdateLatest: true,
    });
  }

  return NextResponse.json({
    portainerUrl: settings.portainerUrl,
    portainerApiKey: settings.portainerApiKey ? "••••••••" : "",
    githubToken: settings.githubToken ? "••••••••" : "",
    pollingInterval: settings.pollingInterval,
    autoUpdateLatest: settings.autoUpdateLatest,
  });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if ((session.user as { role: string }).role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await request.json();
  const data: Record<string, unknown> = {};

  if (body.portainerUrl !== undefined) data.portainerUrl = body.portainerUrl;
  if (body.portainerApiKey && body.portainerApiKey !== "••••••••")
    data.portainerApiKey = body.portainerApiKey;
  if (body.githubToken && body.githubToken !== "••••••••")
    data.githubToken = body.githubToken;
  if (body.pollingInterval !== undefined)
    data.pollingInterval = body.pollingInterval;
  if (body.autoUpdateLatest !== undefined)
    data.autoUpdateLatest = body.autoUpdateLatest;

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: data,
    create: {
      id: "singleton",
      portainerUrl: (data.portainerUrl as string) || "",
      portainerApiKey: (data.portainerApiKey as string) || "",
      githubToken: (data.githubToken as string) || "",
      pollingInterval: (data.pollingInterval as number) || 60,
      autoUpdateLatest: (data.autoUpdateLatest as boolean) ?? true,
    },
  });

  return NextResponse.json({ success: true });
}
