import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockPrisma = {
  service: { findMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/polling", () => ({
  syncServicesFromPortainer: vi.fn(),
  initializeDigests: vi.fn(),
}));

vi.mock("@/lib/sessionHelpers", () => ({
  isAdmin: vi.fn((s: any) => s?.user?.role === "admin"),
}));

import { auth } from "@/lib/auth";

describe("GET /api/services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/services/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns services list", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const services = [
      { id: "1", containerName: "app", image: "ghcr.io/org/app:latest", status: "running" },
    ];
    mockPrisma.service.findMany.mockResolvedValue(services);

    const { GET } = await import("@/app/api/services/route");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].containerName).toBe("app");
  });
});

describe("POST /api/services", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const { POST } = await import("@/app/api/services/route");
    const req = new Request("http://localhost/api/services", {
      method: "POST",
      body: JSON.stringify({ action: "sync" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid action", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { POST } = await import("@/app/api/services/route");
    const req = new Request("http://localhost/api/services", {
      method: "POST",
      body: JSON.stringify({ action: "invalid" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("syncs services for admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    mockPrisma.service.findMany.mockResolvedValue([]);

    const { POST } = await import("@/app/api/services/route");
    const req = new Request("http://localhost/api/services", {
      method: "POST",
      body: JSON.stringify({ action: "sync" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });
});
