import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock auth
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

// Mock prisma
const mockPrisma = {
  settings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

// Mock crypto
vi.mock("@/lib/secretsCrypto", () => ({
  encryptSecret: vi.fn((v: string) => `encrypted:${v}`),
  decryptSecret: vi.fn((v: string) => v.replace("encrypted:", "")),
}));

// Mock session helpers
vi.mock("@/lib/sessionHelpers", () => ({
  isAdmin: vi.fn((session: any) => session?.user?.role === "admin"),
}));

import { auth } from "@/lib/auth";

describe("GET /api/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns settings with masked secrets", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    mockPrisma.settings.findUnique.mockResolvedValue({
      portainerUrl: "https://portainer.test:9443",
      portainerApiKey: "encrypted:secret-key",
      githubUser: "testuser",
      githubToken: "encrypted:ghp_token",
      pollingInterval: 120,
      autoUpdateLatest: false,
      portainerEndpointId: 3,
    });

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.portainerUrl).toBe("https://portainer.test:9443");
    expect(data.portainerApiKey).toBe("••••••••");
    expect(data.githubToken).toBe("••••••••");
    expect(data.githubUser).toBe("testuser");
    expect(data.pollingInterval).toBe(120);
    expect(data.portainerEndpointId).toBe(3);
  });

  it("returns defaults when no settings exist", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    mockPrisma.settings.findUnique.mockResolvedValue(null);

    const { GET } = await import("@/app/api/settings/route");
    const res = await GET();
    const data = await res.json();

    expect(data.portainerUrl).toBe("");
    expect(data.pollingInterval).toBe(60);
    expect(data.autoUpdateLatest).toBe(true);
  });
});

describe("PUT /api/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      body: JSON.stringify({ portainerUrl: "https://test.com" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it("validates portainer URL rejects non-http schemes", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portainerUrl: "ftp://evil.com" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("URL must use http or https");
  });

  it("blocks AWS metadata endpoint", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portainerUrl: "http://169.254.169.254/latest/" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("validates polling interval range", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { PUT } = await import("@/app/api/settings/route");

    // Too low
    let req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollingInterval: 5 }),
    });
    let res = await PUT(req);
    expect(res.status).toBe(400);

    // Too high
    req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollingInterval: 9999 }),
    });
    res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("skips masked secrets (no overwrite)", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    mockPrisma.settings.upsert.mockResolvedValue({});

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        portainerApiKey: "••••••••",
        githubToken: "••••••••",
        pollingInterval: 60,
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);

    // Verify upsert was called without portainerApiKey or githubToken in data
    const upsertCall = mockPrisma.settings.upsert.mock.calls[0][0];
    expect(upsertCall.update).not.toHaveProperty("portainerApiKey");
    expect(upsertCall.update).not.toHaveProperty("githubToken");
  });

  it("accepts valid settings and saves", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    mockPrisma.settings.upsert.mockResolvedValue({});

    const { PUT } = await import("@/app/api/settings/route");
    const req = new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        portainerUrl: "https://portainer.test:9443",
        pollingInterval: 120,
        autoUpdateLatest: false,
        portainerEndpointId: 5,
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(mockPrisma.settings.upsert).toHaveBeenCalled();
  });
});
