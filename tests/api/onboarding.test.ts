import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

const mockPrisma = {
  settings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/secretsCrypto", () => ({
  encryptSecret: vi.fn((v: string) => `enc:${v}`),
}));

vi.mock("@/lib/sessionHelpers", () => ({
  isAdmin: vi.fn((s: any) => s?.user?.role === "admin"),
}));

vi.mock("@/lib/portainer", () => ({
  getEndpoints: vi.fn().mockResolvedValue([{ Id: 3, Name: "local" }]),
}));

import { auth } from "@/lib/auth";

describe("GET /api/onboarding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns needsOnboarding=true when no portainerUrl", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    mockPrisma.settings.findUnique.mockResolvedValue({ portainerUrl: "", portainerApiKey: "", githubToken: "" });

    const { GET } = await import("@/app/api/onboarding/route");
    const res = await GET();
    const data = await res.json();

    expect(data.needsOnboarding).toBe(true);
  });

  it("returns needsOnboarding=false when portainerUrl is set", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    mockPrisma.settings.findUnique.mockResolvedValue({
      portainerUrl: "https://test:9443",
      portainerApiKey: "enc:key",
      githubToken: "",
    });

    const { GET } = await import("@/app/api/onboarding/route");
    const res = await GET();
    const data = await res.json();

    expect(data.needsOnboarding).toBe(false);
    expect(data.hasPortainerUrl).toBe(true);
    expect(data.hasPortainerApiKey).toBe(true);
    expect(data.hasGithubToken).toBe(false);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/onboarding/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/onboarding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const { PUT } = await import("@/app/api/onboarding/route");
    const req = new Request("http://localhost/api/onboarding", {
      method: "PUT",
      body: JSON.stringify({ portainerUrl: "https://test:9443", portainerApiKey: "key" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it("requires portainerUrl", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { PUT } = await import("@/app/api/onboarding/route");
    const req = new Request("http://localhost/api/onboarding", {
      method: "PUT",
      body: JSON.stringify({ portainerApiKey: "key" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("requires portainerApiKey", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { PUT } = await import("@/app/api/onboarding/route");
    const req = new Request("http://localhost/api/onboarding", {
      method: "PUT",
      body: JSON.stringify({ portainerUrl: "https://test:9443" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("saves settings and auto-detects endpoint", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    mockPrisma.settings.upsert.mockResolvedValue({});
    mockPrisma.settings.update.mockResolvedValue({});

    const { PUT } = await import("@/app/api/onboarding/route");
    const req = new Request("http://localhost/api/onboarding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        portainerUrl: "https://portainer.test:9443",
        portainerApiKey: "ptr_testkey",
        githubUser: "testuser",
        githubToken: "ghp_testtoken",
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(mockPrisma.settings.upsert).toHaveBeenCalled();
    // Auto-detect endpoint sets it to 3
    expect(mockPrisma.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { portainerEndpointId: 3 },
      })
    );
  });

  it("rejects SSRF URLs", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { PUT } = await import("@/app/api/onboarding/route");
    const req = new Request("http://localhost/api/onboarding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        portainerUrl: "http://169.254.169.254/latest",
        portainerApiKey: "key",
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });
});
