import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));

const mockPrisma = {
  healthMonitor: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));


import { signInAs, signOut } from "../helpers/apiAuthMock";

describe("GET /api/health-monitor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    signOut();
    const { GET } = await import("@/app/api/health-monitor/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns defaults when no config exists", async () => {
    signInAs("operator");
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(null);
    const { GET } = await import("@/app/api/health-monitor/route");
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.enabled).toBe(false);
    expect(data.prefixes).toBe("");
    expect(data.logWindow).toBe(300);
    expect(data.cooldown).toBe(10);
    expect(typeof data.logPatterns).toBe("string");
    expect(data.logPatterns.length).toBeGreaterThan(0);
  });

  it("returns existing config values", async () => {
    signInAs("operator");
    mockPrisma.healthMonitor.findUnique.mockResolvedValue({
      enabled: true,
      prefixes: "n8n-worker\nglances",
      logWindow: 600,
      cooldown: 15,
      logPatterns: "timeout exceeded when trying to connect",
    });
    const { GET } = await import("@/app/api/health-monitor/route");
    const res = await GET();
    const data = await res.json();
    expect(data.enabled).toBe(true);
    expect(data.prefixes).toBe("n8n-worker\nglances");
    expect(data.logWindow).toBe(600);
    expect(data.cooldown).toBe(15);
    expect(data.logPatterns).toBe("timeout exceeded when trying to connect");
  });
});

describe("PUT /api/health-monitor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    signOut();
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      body: JSON.stringify({}),
    });
    const res = await PUT(req);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    signInAs("operator");
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid JSON body", async () => {
    signInAs("admin");
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("rejects logPatterns with only blank lines", async () => {
    signInAs("admin");
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logPatterns: "   \n  \n" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("logPatterns");
  });

  it("accepts empty prefixes (monitor all containers)", async () => {
    signInAs("admin");
    mockPrisma.healthMonitor.upsert.mockResolvedValue({});
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: "" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
  });

  it("rejects logWindow below minimum", async () => {
    signInAs("admin");
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logWindow: 30 }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("rejects logWindow above maximum", async () => {
    signInAs("admin");
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logWindow: 9999 }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("rejects cooldown below minimum", async () => {
    signInAs("admin");
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cooldown: 0 }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("rejects cooldown above maximum", async () => {
    signInAs("admin");
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cooldown: 100 }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("saves valid config with multiple prefixes and patterns", async () => {
    signInAs("admin");
    mockPrisma.healthMonitor.upsert.mockResolvedValue({});
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        prefixes: "n8n-worker\nglances",
        logPatterns: "timeout exceeded when trying to connect\ndatabase connection timed out",
        logWindow: 300,
        cooldown: 10,
      }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mockPrisma.healthMonitor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "singleton" } }),
    );
  });

  it("accepts partial updates (only enabled flag)", async () => {
    signInAs("admin");
    mockPrisma.healthMonitor.upsert.mockResolvedValue({});
    const { PUT } = await import("@/app/api/health-monitor/route");
    const req = new Request("http://localhost/api/health-monitor", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
  });
});
