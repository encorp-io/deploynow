import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/secretsCrypto";
import { isAdmin } from "@/lib/sessionHelpers";

/**
 * SSRF protection — rejects dangerous URL targets.
 * Allows localhost and private IPs (intended use: local Portainer).
 * Blocks cloud metadata endpoints and non-http(s) schemes.
 */
function validatePortainerUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "URL must use http or https";
    }
    const host = url.hostname.toLowerCase();
    // Block AWS/GCP/Azure metadata endpoints
    if (
      host === "169.254.169.254" ||
      host === "metadata.google.internal" ||
      host === "169.254.170.2" // ECS metadata
    ) {
      return "That host is not allowed";
    }
    return null; // valid
  } catch {
    return "Invalid URL";
  }
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });

  return NextResponse.json({
    portainerUrl:       settings?.portainerUrl ?? "",
    portainerApiKey:    settings?.portainerApiKey ? "••••••••" : "",
    githubUser:         settings?.githubUser ?? "",
    githubToken:        settings?.githubToken    ? "••••••••" : "",
    pollingInterval:    settings?.pollingInterval    ?? 60,
    autoUpdateLatest:   settings?.autoUpdateLatest   ?? true,
    portainerEndpointId: settings?.portainerEndpointId ?? 1,
  });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized — not logged in" }, { status: 401 });
  if (!isAdmin(session)) return NextResponse.json({ error: "Admin only — your role: " + (session as any)?.user?.role }, { status: 403 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const data: Record<string, unknown> = {};

  // ── portainerUrl ─────────────────────────────────────────────────────────────
  if (typeof body.portainerUrl === "string") {
    const trimmed = body.portainerUrl.trim();
    if (trimmed) {
      const urlError = validatePortainerUrl(trimmed);
      if (urlError) {
        return NextResponse.json({ error: `Invalid Portainer URL: ${urlError}` }, { status: 400 });
      }
    }
    data.portainerUrl = trimmed;
  }

  // ── portainerApiKey — encrypt before storing ──────────────────────────────
  if (
    typeof body.portainerApiKey === "string" &&
    body.portainerApiKey !== "••••••••"
  ) {
    if (body.portainerApiKey.length > 512) {
      return NextResponse.json({ error: "API key too long" }, { status: 400 });
    }
    data.portainerApiKey = body.portainerApiKey
      ? encryptSecret(body.portainerApiKey)
      : "";
  }

  // ── githubUser ────────────────────────────────────────────────────────────
  if (typeof body.githubUser === "string") {
    const trimmed = body.githubUser.trim().slice(0, 100);
    data.githubUser = trimmed;
  }

  // ── githubToken — encrypt before storing ─────────────────────────────────
  if (
    typeof body.githubToken === "string" &&
    body.githubToken !== "••••••••"
  ) {
    if (body.githubToken.length > 512) {
      return NextResponse.json({ error: "GitHub token too long" }, { status: 400 });
    }
    data.githubToken = body.githubToken ? encryptSecret(body.githubToken) : "";
  }

  // ── pollingInterval ───────────────────────────────────────────────────────
  if (body.pollingInterval !== undefined) {
    const interval = Number(body.pollingInterval);
    if (!Number.isInteger(interval) || interval < 30 || interval > 3600) {
      return NextResponse.json(
        { error: "pollingInterval must be an integer between 30 and 3600" },
        { status: 400 }
      );
    }
    data.pollingInterval = interval;
  }

  // ── autoUpdateLatest ──────────────────────────────────────────────────────
  if (body.autoUpdateLatest !== undefined) {
    data.autoUpdateLatest = Boolean(body.autoUpdateLatest);
  }

  // ── portainerEndpointId ───────────────────────────────────────────────────
  if (body.portainerEndpointId !== undefined) {
    const endpointId = Number(body.portainerEndpointId);
    if (!Number.isInteger(endpointId) || endpointId < 1) {
      return NextResponse.json(
        { error: "portainerEndpointId must be a positive integer" },
        { status: 400 }
      );
    }
    data.portainerEndpointId = endpointId;
  }

  try {
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: data,
      create: {
        id: "singleton",
        portainerUrl:        (data.portainerUrl        as string)  ?? "",
        portainerApiKey:     (data.portainerApiKey     as string)  ?? "",
        githubUser:          (data.githubUser           as string)  ?? "",
        githubToken:         (data.githubToken         as string)  ?? "",
        pollingInterval:     (data.pollingInterval     as number)  ?? 60,
        autoUpdateLatest:    (data.autoUpdateLatest    as boolean) ?? true,
        portainerEndpointId: (data.portainerEndpointId as number)  ?? 1,
      },
    });
  } catch (err) {
    console.error("[settings] Save failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to save: " + (err instanceof Error ? err.message : "unknown") }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

/**
 * Internal helper — returns the *decrypted* API key and token for use by
 * server-side lib code (portainer.ts, ghcr.ts). Never exposed to the client.
 */
export async function getDecryptedSettings() {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings) return null;
  return {
    ...settings,
    portainerApiKey: decryptSecret(settings.portainerApiKey),
    githubToken:     decryptSecret(settings.githubToken),
  };
}
