import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));

vi.mock("@/lib/secretsCrypto", () => ({ decryptSecret: (v: string) => v }));

const mockPrisma = {
  settings: { update: vi.fn(), findUnique: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { signInAs, signOut } from "../helpers/apiAuthMock";

describe("POST /api/github/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns 401 when not authenticated", async () => {
    signOut();
    const { POST } = await import("@/app/api/github/test/route");
    const req = new Request("http://localhost/api/github/test", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("uses body token over DB token", async () => {
    signInAs("admin");
    mockPrisma.settings.findUnique.mockResolvedValue(null);

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: "testuser", name: "Test" }),
        headers: new Headers({ "x-oauth-scopes": "read:packages" }),
      })
      .mockResolvedValueOnce({ ok: true }); // GHCR check

    vi.stubGlobal("fetch", mockFetch);
    mockPrisma.settings.update.mockResolvedValue({});

    const { POST } = await import("@/app/api/github/test/route");
    const req = new Request("http://localhost/api/github/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubUser: "myuser", githubToken: "ghp_test123" }),
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.user).toBe("testuser");
    expect(data.hasPackagesRead).toBe(true);
  });

  it("falls back to DB token when body token is masked", async () => {
    signInAs("admin");
    mockPrisma.settings.findUnique.mockResolvedValue({
      githubToken: "ghp_from_db",
      githubUser: "dbuser",
    } as any);

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ login: "dbuser", name: "DB User" }),
        headers: new Headers({ "x-oauth-scopes": "read:packages, repo" }),
      })
      .mockResolvedValueOnce({ ok: true });

    vi.stubGlobal("fetch", mockFetch);
    mockPrisma.settings.update.mockResolvedValue({});

    const { POST } = await import("@/app/api/github/test/route");
    const req = new Request("http://localhost/api/github/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ githubToken: "••••••••" }),
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.user).toBe("dbuser");
  });

  it("returns error for invalid token (401)", async () => {
    signInAs("admin");
    mockPrisma.settings.findUnique.mockResolvedValue({
      githubToken: "bad_token",
      githubUser: "user",
    } as any);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }));

    const { POST } = await import("@/app/api/github/test/route");
    const req = new Request("http://localhost/api/github/test", {
      method: "POST",
      body: "{}",
    });
    const res = await POST(req);
    const data = await res.json();

    expect(data.success).toBe(false);
    expect(data.error).toContain("Invalid token");
  });

  it("is admin only", async () => {
    signInAs("operator");
    const { POST } = await import("@/app/api/github/test/route");
    const res = await POST(new Request("http://localhost/api/github/test", { method: "POST", body: "{}" }));
    expect(res.status).toBe(403);
  });

  it("returns error when no token configured", async () => {
    signInAs("admin");
    mockPrisma.settings.findUnique.mockResolvedValue({
      githubToken: "",
      githubUser: "",
    } as any);

    const { POST } = await import("@/app/api/github/test/route");
    const req = new Request("http://localhost/api/github/test", {
      method: "POST",
      body: "{}",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
