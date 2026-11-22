import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { decryptSecret } from "@/lib/secretsCrypto";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/github/test
 * Tests the GitHub PAT by calling the GitHub API and checking GHCR access.
 *
 * Accepts optional { githubUser, githubToken } in body to test credentials
 * directly without requiring a save first. Falls back to DB values.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let bodyUser = "";
  let bodyToken = "";
  try {
    const body = await request.json();
    bodyUser = (body.githubUser || "").trim();
    bodyToken = (body.githubToken || "").trim();
  } catch {
    // No body or invalid JSON — that's fine, fall back to DB
  }

  // Use body values if provided, otherwise fall back to stored settings
  let ghUser = bodyUser;
  let ghToken = bodyToken;

  if (!ghToken || ghToken === "••••••••") {
    const stored = await prisma.settings.findUnique({ where: { id: "singleton" } });
    const settings = stored ? { ...stored, githubToken: decryptSecret(stored.githubToken) } : null;
    if (!settings?.githubToken) {
      return NextResponse.json({ success: false, error: "GitHub token not configured" }, { status: 400 });
    }
    ghToken = settings.githubToken;
    if (!ghUser) ghUser = settings.githubUser || "";
  }

  const tokenPreview = ghToken.substring(0, 8) + "…";

  try {
    // 1. Verify the token against the GitHub API
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${ghToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "encorp-deployer",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!userRes.ok) {
      if (userRes.status === 401) {
        return NextResponse.json({
          success: false,
          error: `Invalid token (${tokenPreview}) — GitHub returned 401. Ensure it's a classic PAT with read:packages scope.`,
        });
      }
      return NextResponse.json({
        success: false,
        error: `GitHub API returned ${userRes.status}`,
      });
    }

    const user = await userRes.json();
    const login: string = user.login;

    // Auto-fill githubUser if empty
    if (!ghUser) ghUser = login;

    // Save the detected username to DB
    if (login) {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { githubUser: ghUser },
      }).catch(() => {});
    }

    // 2. Check token scopes from response headers
    const scopes = userRes.headers.get("x-oauth-scopes") || "";
    const hasPackagesRead =
      scopes.includes("read:packages") ||
      scopes.includes("write:packages") ||
      scopes.includes("delete:packages");

    // 3. Quick GHCR auth check — try to get a registry token
    let ghcrOk = false;
    try {
      const tokenRes = await fetch(
        `https://ghcr.io/token?scope=repository:${ghUser}/test:pull&service=ghcr.io`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${ghUser}:${ghToken}`).toString("base64")}`,
          },
        }
      );
      ghcrOk = tokenRes.ok;
    } catch {
      // GHCR check is non-fatal
    }

    return NextResponse.json({
      success: true,
      user: login,
      name: user.name || login,
      scopes,
      hasPackagesRead,
      ghcrOk,
      message: [
        `Authenticated as ${login}`,
        hasPackagesRead
          ? "read:packages scope present"
          : "WARNING: read:packages scope missing — GHCR digest checks will fail",
        ghcrOk ? "GHCR auth OK" : "GHCR auth could not be verified",
      ].join(" · "),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
