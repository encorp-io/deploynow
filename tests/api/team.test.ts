import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockPrisma = {
  user: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  },
  teamInvite: {
    findMany: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/sessionHelpers", () => ({
  isAdmin: vi.fn((s: any) => s?.user?.role === "admin"),
  getSessionUserId: vi.fn((s: any) => s?.user?.id || ""),
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed_password") },
}));

import { auth } from "@/lib/auth";

describe("GET /api/team", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { GET } = await import("@/app/api/team/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns users and invites", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin", id: "u1" } } as any);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "u1", email: "admin@test.com", name: "Admin", role: "admin", createdAt: new Date() },
    ]);
    mockPrisma.teamInvite.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/team/route");
    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.users).toHaveLength(1);
    expect(data.invites).toHaveLength(0);
  });
});

describe("POST /api/team", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      body: JSON.stringify({ action: "invite", email: "test@test.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member", id: "u2" } } as any);
    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      body: JSON.stringify({ action: "invite", email: "test@test.com" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it("creates invite for valid email", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin", id: "u1" } } as any);
    mockPrisma.teamInvite.create.mockResolvedValue({ token: "abc123" });

    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invite", email: "new@test.com", role: "member" }),
    });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.token).toBeDefined();
  });

  it("rejects invalid role", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin", id: "u1" } } as any);
    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invite", email: "test@test.com", role: "superadmin" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("prevents removing last admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin", id: "u1" } } as any);
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u2", role: "admin" });
    mockPrisma.user.count.mockResolvedValue(1); // only 1 admin

    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", userId: "u2" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("last admin");
  });

  it("removes member successfully", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin", id: "u1" } } as any);
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u2", role: "member" });
    mockPrisma.user.delete.mockResolvedValue({});

    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", userId: "u2" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it("prevents demoting last admin", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin", id: "u1" } } as any);
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u2", role: "admin" });
    mockPrisma.user.count.mockResolvedValue(1);

    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "updateRole", userId: "u2", role: "member" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid action", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin", id: "u1" } } as any);
    const { POST } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "doSomethingBad" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/team (invite registration)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects invalid token format", async () => {
    const { PUT } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bad-token", name: "Test User", password: "longenoughpassw" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("rejects short password", async () => {
    const { PUT } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "a".repeat(64),
        name: "Test",
        password: "short",
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("rejects expired/used token", async () => {
    mockPrisma.teamInvite.findUnique.mockResolvedValue(null);

    const { PUT } = await import("@/app/api/team/route");
    const validToken = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const req = new Request("http://localhost/api/team", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: validToken, name: "Test User", password: "longenoughpassw" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("creates user from valid invite", async () => {
    const validToken = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    mockPrisma.teamInvite.findUnique.mockResolvedValue({
      id: "inv1",
      email: "new@test.com",
      role: "member",
      token: validToken,
    });
    mockPrisma.user.create.mockResolvedValue({ id: "u3" });
    mockPrisma.teamInvite.update.mockResolvedValue({});

    const { PUT } = await import("@/app/api/team/route");
    const req = new Request("http://localhost/api/team", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: validToken, name: "New User", password: "longenoughpassw" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(mockPrisma.user.create).toHaveBeenCalled();
    expect(mockPrisma.teamInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { used: true } })
    );
  });
});
