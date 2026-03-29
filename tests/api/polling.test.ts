import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockPrisma = {
  activityLog: {
    findMany: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/polling", () => ({
  syncServicesFromPortainer: vi.fn(),
  checkForUpdates: vi.fn(),
  initializeDigests: vi.fn(),
}));

vi.mock("@/lib/sessionHelpers", () => ({
  isAdmin: vi.fn((s: any) => s?.user?.role === "admin"),
}));

import { auth } from "@/lib/auth";

describe("POST /api/polling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { POST } = await import("@/app/api/polling/route");
    const req = new Request("http://localhost/api/polling", {
      method: "POST",
      body: JSON.stringify({ action: "check" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const { POST } = await import("@/app/api/polling/route");
    const req = new Request("http://localhost/api/polling", {
      method: "POST",
      body: JSON.stringify({ action: "check" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("handles check action", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { POST } = await import("@/app/api/polling/route");
    const req = new Request("http://localhost/api/polling", {
      method: "POST",
      body: JSON.stringify({ action: "check" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("handles init action", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { POST } = await import("@/app/api/polling/route");
    const req = new Request("http://localhost/api/polling", {
      method: "POST",
      body: JSON.stringify({ action: "init" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("returns 400 for invalid action", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    const { POST } = await import("@/app/api/polling/route");
    const req = new Request("http://localhost/api/polling", {
      method: "POST",
      body: JSON.stringify({ action: "invalid" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/polling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/polling/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns activity logs for any authenticated user", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const logs = [{ id: "1", action: "check", message: "Checked", createdAt: new Date() }];
    mockPrisma.activityLog.findMany.mockResolvedValue(logs);

    const { GET } = await import("@/app/api/polling/route");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
  });
});
