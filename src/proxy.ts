import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// State-changing HTTP methods
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Reconstruct the public-facing origin from the request headers.
 *
 * Behind nginx, Next.js sees http://127.0.0.1:3001 as the origin.
 * The real origin is built from X-Forwarded-Proto + Host (which nginx
 * sets to $http_host, including the port).
 */
function getPublicOrigin(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost";
  return `${proto}://${host}`;
}

export default auth((req: NextRequest & { auth: unknown }) => {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // ── CSRF: verify Origin header matches the public-facing origin ───────────
  // Behind nginx, req.nextUrl.origin is http://127.0.0.1:3001 — useless.
  // We reconstruct the real origin from forwarded headers and compare against
  // the browser's Origin header.
  if (MUTATING_METHODS.has(method) && !pathname.startsWith("/api/auth")) {
    const requestOrigin = req.headers.get("origin");
    if (requestOrigin) {
      const publicOrigin = getPublicOrigin(req);
      if (requestOrigin !== publicOrigin && requestOrigin !== req.nextUrl.origin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }

  // ── Authentication gates ────────────────────────────────────────────────────
  // NextAuth routes — always public
  if (pathname.startsWith("/api/auth")) return NextResponse.next();

  // Login, setup pages — public
  if (pathname === "/login" || pathname.startsWith("/setup")) {
    return NextResponse.next();
  }

  // GitHub push webhooks — authenticated by their HMAC signature in the route
  if (pathname.startsWith("/api/webhooks/github/") && method === "POST") {
    return NextResponse.next();
  }

  // API tokens: the route handlers check the token (requireUser)
  if (pathname.startsWith("/api/") && /^Bearer\s+dn_/i.test(req.headers.get("authorization") ?? "")) {
    // Account, token and sign-in management stay with signed-in people
    if (/^\/api\/(account|tokens|passkeys|sso|team)(\/|$)/.test(pathname)) {
      return NextResponse.json({ error: "Not available with an API token" }, { status: 403 });
    }
    return NextResponse.next();
  }

  // The OpenAPI description, SSO callbacks and passkey sign-in are public
  // …and so is the platform domain probe (Settings → Domain checks the domain reaches this instance)
  if (pathname === "/api/openapi.json" || pathname.startsWith("/api/sso/") || pathname.startsWith("/api/passkeys/login") || (pathname === "/api/platform-domain/probe" && method === "GET")) {
    return NextResponse.next();
  }

  // ONLY PUT /api/team is public (invite registration — user has no session yet)
  if (pathname.startsWith("/api/team") && method === "PUT") {
    return NextResponse.next();
  }

  // All other routes require authentication
  if (!req.auth) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Redirect to /login on the same origin the browser is using
    const publicOrigin = getPublicOrigin(req);
    return NextResponse.redirect(new URL("/login", publicOrigin));
  }

  // ── Admins and owners must set up 2FA before doing anything else ──────────
  const user = (req.auth as { user?: { mfaSetupRequired?: boolean } } | null)?.user;
  if (user?.mfaSetupRequired && !pathname.startsWith("/account") && !pathname.startsWith("/api/account") && !pathname.startsWith("/api/passkeys")) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Set up two-factor authentication first", mfaSetupRequired: true }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/account?setup=2fa", getPublicOrigin(req)));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
