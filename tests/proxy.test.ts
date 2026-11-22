import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// auth(handler) returns the handler itself, so the test can call it with `auth` set
vi.mock("@/lib/auth", () => ({ auth: (fn: unknown) => fn }));

import proxy, { config } from "@/proxy";

type Handler = (req: NextRequest & { auth: unknown }) => Response;
const handler = proxy as unknown as Handler;

function call(path: string, { method = "GET", auth = null as unknown, origin = "" } = {}) {
  const req = new NextRequest(`http://127.0.0.1:3001${path}`, {
    method,
    headers: { host: "deploy.example.com:9444", "x-forwarded-proto": "https", ...(origin ? { origin } : {}) },
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
    expect(page.headers.get("location")).toBe("https://deploy.example.com:9444/login");
    expect(call("/api/services").status).toBe(401);
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
