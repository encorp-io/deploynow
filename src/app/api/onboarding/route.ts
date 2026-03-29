import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/secretsCrypto";
import { isAdmin } from "@/lib/sessionHelpers";
import { getEndpoints } from "@/lib/portainer";

/**
 * GET /api/onboarding
 * Returns whether onboarding is complete (settings have portainerUrl set).
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });

  const needsOnboarding = !settings?.portainerUrl;

  return NextResponse.json({
    needsOnboarding,
    hasPortainerUrl: !!settings?.portainerUrl,
    hasPortainerApiKey: !!settings?.portainerApiKey,
    hasGithubToken: !!settings?.githubToken,
  });
}

/**
 * PUT /api/onboarding
 * Saves onboarding data — Portainer URL, API key, GitHub PAT.
 * Admin-only.
 */
export async function PUT(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  const body = await request.json();

  // ── Validate portainerUrl ──────────────────────────────────────────────────
  if (!body.portainerUrl || typeof body.portainerUrl !== "string") {
    return NextResponse.json({ error: "Portainer URL is required" }, { status: 400 });
  }
  const portainerUrl = body.portainerUrl.trim();
  try {
    const url = new URL(portainerUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return NextResponse.json({ error: "URL must use http or https" }, { status: 400 });
    }
    const host = url.hostname.toLowerCase();
    if (host === "169.254.169.254" || host === "metadata.google.internal" || host === "169.254.170.2") {
      return NextResponse.json({ error: "That host is not allowed" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // ── Validate portainerApiKey ───────────────────────────────────────────────
  if (!body.portainerApiKey || typeof body.portainerApiKey !== "string") {
    return NextResponse.json({ error: "Portainer API key is required" }, { status: 400 });
  }
  if (body.portainerApiKey.length > 512) {
    return NextResponse.json({ error: "API key too long" }, { status: 400 });
  }

  // ── GitHub fields are optional ──────────────────────────────────────────────
  const data: Record<string, unknown> = {
    portainerUrl,
    portainerApiKey: encryptSecret(body.portainerApiKey),
  };

  if (body.githubUser && typeof body.githubUser === "string") {
    data.githubUser = body.githubUser.trim().slice(0, 100);
  }

  if (body.githubToken && typeof body.githubToken === "string") {
    if (body.githubToken.length > 512) {
      return NextResponse.json({ error: "GitHub token too long" }, { status: 400 });
    }
    data.githubToken = encryptSecret(body.githubToken);
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: data,
    create: {
      id: "singleton",
      portainerUrl,
      portainerApiKey: data.portainerApiKey as string,
      githubUser: (data.githubUser as string) ?? "",
      githubToken: (data.githubToken as string) ?? "",
      pollingInterval: 60,
      autoUpdateLatest: true,
      portainerEndpointId: 1,
    },
  });

  // Auto-detect the correct Portainer endpoint ID
  try {
    const endpoints = await getEndpoints();
    if (endpoints.length > 0) {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { portainerEndpointId: endpoints[0].Id },
      });
    }
  } catch {
    // Non-fatal — user can fix the endpoint ID in settings later
  }

  return NextResponse.json({ success: true });
}
