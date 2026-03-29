import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

const mockPrisma = {
  activityLog: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

import { auth } from "@/lib/auth";

describe("GET /api/activity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/activity/route");
    const req = new Request("http://localhost/api/activity");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns paginated logs", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const logs = [
      { id: "1", action: "update", message: "Updated app", details: "", createdAt: new Date() },
    ];
    mockPrisma.activityLog.findMany
      .mockResolvedValueOnce(logs) // main query
      .mockResolvedValueOnce([{ action: "update" }, { action: "error" }]); // distinct actions
    mockPrisma.activityLog.count.mockResolvedValue(1);

    const { GET } = await import("@/app/api/activity/route");
    const req = new Request("http://localhost/api/activity?page=1&limit=10");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.logs).toHaveLength(1);
    expect(data.total).toBe(1);
    expect(data.page).toBe(1);
    expect(data.actionTypes).toEqual(["update", "error"]);
  });

  it("supports search parameter", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    mockPrisma.activityLog.findMany.mockResolvedValue([]);
    mockPrisma.activityLog.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/activity/route");
    const req = new Request("http://localhost/api/activity?search=nginx");
    const res = await GET(req);
    expect(res.status).toBe(200);

    // Verify the OR clause was passed to prisma
    const findCall = mockPrisma.activityLog.findMany.mock.calls[0][0];
    expect(findCall.where.OR).toBeDefined();
  });

  it("supports action filter", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    mockPrisma.activityLog.findMany.mockResolvedValue([]);
    mockPrisma.activityLog.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/activity/route");
    const req = new Request("http://localhost/api/activity?action=error");
    const res = await GET(req);

    const findCall = mockPrisma.activityLog.findMany.mock.calls[0][0];
    expect(findCall.where.action).toBe("error");
  });

  it("defaults sort to desc", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    mockPrisma.activityLog.findMany.mockResolvedValue([]);
    mockPrisma.activityLog.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/activity/route");
    const req = new Request("http://localhost/api/activity");
    await GET(req);

    const findCall = mockPrisma.activityLog.findMany.mock.calls[0][0];
    expect(findCall.orderBy.createdAt).toBe("desc");
  });

  it("supports sort=asc", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    mockPrisma.activityLog.findMany.mockResolvedValue([]);
    mockPrisma.activityLog.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/activity/route");
    const req = new Request("http://localhost/api/activity?sort=asc");
    await GET(req);

    const findCall = mockPrisma.activityLog.findMany.mock.calls[0][0];
    expect(findCall.orderBy.createdAt).toBe("asc");
  });

  it("clamps limit to 100 max", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    mockPrisma.activityLog.findMany.mockResolvedValue([]);
    mockPrisma.activityLog.count.mockResolvedValue(0);

    const { GET } = await import("@/app/api/activity/route");
    const req = new Request("http://localhost/api/activity?limit=500");
    await GET(req);

    const findCall = mockPrisma.activityLog.findMany.mock.calls[0][0];
    expect(findCall.take).toBe(100);
  });
});
