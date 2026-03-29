import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/app/api/settings/route", () => ({
  getDecryptedSettings: vi.fn(),
}));

const mockPrisma = {
  settings: { update: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { auth } from "@/lib/auth";
import { getDecryptedSettings } from "@/app/api/settings/route";

describe("POST /api/github/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { POST } = await import("@/app/api/github/test/route");
    const req = new Request("http://localhost/api/github/test", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("uses body token over DB token", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    vi.mocked(getDecryptedSettings).mockResolvedValue(null);

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
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    vi.mocked(getDecryptedSettings).mockResolvedValue({
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
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    vi.mocked(getDecryptedSettings).mockResolvedValue({
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

  it("returns error when no token configured", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    vi.mocked(getDecryptedSettings).mockResolvedValue({
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
