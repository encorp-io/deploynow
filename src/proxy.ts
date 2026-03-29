import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// State-changing HTTP methods
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export default auth((req: NextRequest & { auth: unknown }) => {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // ── CSRF: verify Origin header matches the server's own origin ─────────────
  // This blocks cross-origin AJAX requests from forging state changes.
  // We skip NextAuth's own routes (they have built-in CSRF protection).
  if (MUTATING_METHODS.has(method) && !pathname.startsWith("/api/auth")) {
    const requestOrigin = req.headers.get("origin");
    const serverOrigin = req.nextUrl.origin;
    if (requestOrigin && requestOrigin !== serverOrigin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // ── Authentication gates ────────────────────────────────────────────────────
  // NextAuth routes — always public
  if (pathname.startsWith("/api/auth")) return NextResponse.next();

  // Login and setup pages — public
  if (pathname === "/login" || pathname.startsWith("/setup")) {
    return NextResponse.next();
  }

  // ONLY PUT /api/team is public (invite registration — user has no session yet)
  // GET and POST on /api/team require a valid session (enforced inside the handler)
  if (pathname.startsWith("/api/team") && method === "PUT") {
    return NextResponse.next();
  }

  // All other routes require authentication
  if (!req.auth) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
