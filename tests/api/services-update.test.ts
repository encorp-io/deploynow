import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/polling", () => ({
  performUpdate: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { performUpdate } from "@/lib/polling";

describe("POST /api/services/update", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { POST } = await import("@/app/api/services/update/route");
    const req = new Request("http://localhost/api/services/update", {
      method: "POST",
      body: JSON.stringify({ serviceId: "c" + "a".repeat(24) }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("validates serviceId format", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const { POST } = await import("@/app/api/services/update/route");

    // Invalid ID
    const req = new Request("http://localhost/api/services/update", {
      method: "POST",
      body: JSON.stringify({ serviceId: "invalid" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects missing serviceId", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    const { POST } = await import("@/app/api/services/update/route");
    const req = new Request("http://localhost/api/services/update", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("calls performUpdate with valid cuid", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    vi.mocked(performUpdate).mockResolvedValue();

    const { POST } = await import("@/app/api/services/update/route");
    const validId = "c" + "a1b2c3d4e5f6g7h8i9j0k1l2".slice(0, 24);
    const req = new Request("http://localhost/api/services/update", {
      method: "POST",
      body: JSON.stringify({ serviceId: validId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(performUpdate).toHaveBeenCalledWith(validId);
  });

  it("returns 500 when performUpdate throws", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "member" } } as any);
    vi.mocked(performUpdate).mockRejectedValue(new Error("Container not found"));

    const { POST } = await import("@/app/api/services/update/route");
    const validId = "cabcdefghijklmnopqrstuvwx";
    const req = new Request("http://localhost/api/services/update", {
      method: "POST",
      body: JSON.stringify({ serviceId: validId }),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Container not found");
  });
});
