import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// auth(handler) returns the handler itself, so the test can call it with `auth` set
vi.mock("@/lib/auth", () => ({ auth: (fn: unknown) => fn }));

import proxy, { config } from "@/proxy";

type Handler = (req: NextRequest & { auth: unknown }) => Response;
const handler = proxy as unknown as Handler;

function call(path: string, { method = "GET", auth = null as unknown, origin = "", authorization = "" } = {}) {
  const req = new NextRequest(`http://127.0.0.1:3001${path}`, {
    method,
    headers: { host: "deploy.example.com:9444", "x-forwarded-proto": "https", ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) },
  }) as NextRequest & { auth: unknown };
  req.auth = auth;
  return handler(req);
}

const signedIn = { user: { id: "u", mfaSetupRequired: false } };
const mustEnrol = { user: { id: "u", mfaSetupRequired: true } };

describe("proxy", () => {
  it("matches everything except static assets", () => {
    expect(config.matcher[0]).toContain("_next/static");
  });

  it("blocks cross-origin writes and allows same-origin ones", () => {
    expect(call("/api/settings", { method: "PUT", auth: signedIn, origin: "https://evil.example" }).status).toBe(403);
    expect(call("/api/settings", { method: "PUT", auth: signedIn, origin: "https://deploy.example.com:9444" }).status).toBe(200);
  });

  it("sends signed-out visitors to login, and APIs get 401", () => {
    const page = call("/dashboard");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://deploy.example.com:9444/login?next=%2Fdashboard");
    expect(call("/").headers.get("location")).toBe("https://deploy.example.com:9444/login");
    expect(call("/oauth/authorize?client_id=x&state=y").headers.get("location")).toBe("https://deploy.example.com:9444/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx%26state%3Dy");
    expect(call("/api/services").status).toBe(401);
  });

  it("lets OAuth clients reach discovery, registration, tokens and /mcp without a session or same-origin check", () => {
    const evil = "https://claude.ai";
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/api/oauth/metadata"]) {
      expect(call(p).status).toBe(200);
    }
    for (const p of ["/mcp", "/api/mcp", "/api/oauth/token", "/api/oauth/register", "/api/oauth/revoke"]) {
      expect(call(p, { method: "POST", origin: evil }).status).toBe(200);
    }
    // The consent answer is a browser form: it keeps the session and origin checks
    expect(call("/api/oauth/authorize", { method: "POST" }).status).toBe(401);
    expect(call("/api/oauth/authorize", { method: "POST", auth: signedIn, origin: evil }).status).toBe(403);
    expect(call("/oauth/authorize", { auth: signedIn }).status).toBe(200);
  });

  it("refuses OAuth access tokens anywhere but /mcp", () => {
    const authorization = "Bearer dno_" + "a".repeat(43);
    expect(call("/api/endpoints", { authorization }).status).toBe(401);
    expect(call("/api/endpoints", { authorization, auth: signedIn }).status).toBe(401);
    expect(call("/mcp", { method: "POST", authorization }).status).toBe(200);
  });

  it("keeps login, invite setup and invite registration public", () => {
    expect(call("/login").status).toBe(200);
    expect(call("/setup?token=x").status).toBe(200);
    expect(call("/api/team", { method: "PUT" }).status).toBe(200);
    expect(call("/api/team", { method: "POST" }).status).toBe(401);
  });

  it("holds admins without 2FA on the account page", () => {
    const page = call("/endpoints", { auth: mustEnrol });
    expect(page.headers.get("location")).toBe("https://deploy.example.com:9444/account?setup=2fa");
    expect(call("/api/endpoints", { auth: mustEnrol }).status).toBe(403);
    expect(call("/account", { auth: mustEnrol }).status).toBe(200);
    expect(call("/api/account/2fa", { method: "POST", auth: mustEnrol }).status).toBe(200);
    expect(call("/endpoints", { auth: signedIn }).status).toBe(200);
  });
});
