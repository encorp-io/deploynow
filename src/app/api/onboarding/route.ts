import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { localSocketAvailable } from "@/lib/endpoints";

/**
 * GET /api/onboarding
 * Onboarding is needed until at least one endpoint exists. The wizard itself
 * uses the endpoints and settings APIs.
 */
export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const [endpoints, settings] = await Promise.all([
    prisma.endpoint.count(),
    prisma.settings.findUnique({ where: { id: "singleton" } }),
  ]);

  return NextResponse.json({
    needsOnboarding: endpoints === 0,
    endpointCount: endpoints,
    localSocketAvailable: localSocketAvailable(),
    hasGithubToken: !!settings?.githubToken,
    hadPortainer: !!settings?.portainerUrl,
  });
}
