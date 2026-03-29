import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const mockPrisma = {
  settings: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/portainer", () => ({
  getEndpoints: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getEndpoints } from "@/lib/portainer";

describe("POST /api/portainer/test", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth).mockResolvedValue(null as any);
    const { POST } = await import("@/app/api/portainer/test/route");
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns endpoints on success", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    vi.mocked(getEndpoints).mockResolvedValue([
      { Id: 3, Name: "local", Type: 1 },
    ]);
    mockPrisma.settings.findUnique.mockResolvedValue({ portainerEndpointId: 3 });

    const { POST } = await import("@/app/api/portainer/test/route");
    const res = await POST();
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.endpoints).toEqual([{ id: 3, name: "local" }]);
  });

  it("auto-corrects invalid endpoint ID", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    vi.mocked(getEndpoints).mockResolvedValue([
      { Id: 5, Name: "prod", Type: 1 },
    ]);
    // Current endpoint ID is 1, which doesn't exist
    mockPrisma.settings.findUnique.mockResolvedValue({ portainerEndpointId: 1 });
    mockPrisma.settings.update.mockResolvedValue({});

    const { POST } = await import("@/app/api/portainer/test/route");
    await POST();

    expect(mockPrisma.settings.update).toHaveBeenCalledWith({
      where: { id: "singleton" },
      data: { portainerEndpointId: 5 },
    });
  });

  it("returns error when getEndpoints throws", async () => {
    vi.mocked(auth).mockResolvedValue({ user: { role: "admin" } } as any);
    vi.mocked(getEndpoints).mockRejectedValue(new Error("Connection refused"));

    const { POST } = await import("@/app/api/portainer/test/route");
    const res = await POST();
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.success).toBe(false);
    expect(data.error).toBe("Connection refused");
  });
});
