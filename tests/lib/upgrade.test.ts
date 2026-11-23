import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  settings: { upsert: vi.fn(), update: vi.fn() },
  user: { findMany: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  teamInvite: { updateMany: vi.fn() },
  activityLog: { findMany: vi.fn(), deleteMany: vi.fn() },
  auditEvent: { create: vi.fn() },
  endpoint: { count: vi.fn(), create: vi.fn() },
  service: { updateMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/endpoints", () => ({ DEFAULT_SOCKET: "/var/run/docker.sock", localSocketAvailable: vi.fn(() => true) }));

import { runUpgrade, ensureLocalEndpoint } from "@/lib/upgrade";
import { localSocketAvailable } from "@/lib/endpoints";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockPrisma.endpoint.count.mockResolvedValue(1);
});

describe("runUpgrade", () => {
  it("moves a v1 install to v2", async () => {
    mockPrisma.settings.upsert.mockResolvedValue({ schemaVersion: 1 });
    mockPrisma.user.findMany.mockResolvedValue([{ id: "first" }, { id: "second" }]);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.activityLog.findMany.mockResolvedValue([
      { action: "update", message: "Updated web", details: "", serviceId: "s1", createdAt: new Date(0) },
      { action: "error", message: "Boom", details: "", serviceId: null, createdAt: new Date(1) },
    ]);

    expect((await runUpgrade()).upgraded).toBe(true);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: "first" }, data: { role: "owner" } });
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({ where: { role: "member" }, data: { role: "operator" } });
    const events = mockPrisma.auditEvent.create.mock.calls.map((c) => c[0].data);
    expect(events.map((e) => [e.action, e.outcome])).toEqual([["service.update", "success"], ["system.error", "failure"]]);
    expect(mockPrisma.activityLog.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.settings.update).toHaveBeenCalledWith({ where: { id: "singleton" }, data: { schemaVersion: 2 } });
  });

  it("does not promote anyone when an owner exists", async () => {
    mockPrisma.settings.upsert.mockResolvedValue({ schemaVersion: 1 });
    mockPrisma.user.findMany.mockResolvedValue([{ id: "a" }]);
    mockPrisma.user.count.mockResolvedValue(1);
    mockPrisma.activityLog.findMany.mockResolvedValue([]);
    await runUpgrade();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("is a no-op on v2", async () => {
    mockPrisma.settings.upsert.mockResolvedValue({ schemaVersion: 2 });
    expect((await runUpgrade()).upgraded).toBe(false);
    expect(mockPrisma.activityLog.findMany).not.toHaveBeenCalled();
  });
});

describe("ensureLocalEndpoint", () => {
  it("adds the socket when there are no endpoints and adopts v1 services", async () => {
    mockPrisma.endpoint.count.mockResolvedValue(0);
    mockPrisma.endpoint.create.mockResolvedValue({ id: "local1" });
    expect(await ensureLocalEndpoint()).toBe("local1");
    expect(mockPrisma.service.updateMany).toHaveBeenCalledWith({ where: { endpointId: null }, data: { endpointId: "local1" } });
  });

  it("does nothing when endpoints exist or there is no socket", async () => {
    expect(await ensureLocalEndpoint()).toBeNull();
    mockPrisma.endpoint.count.mockResolvedValue(0);
    vi.mocked(localSocketAvailable).mockReturnValue(false);
    expect(await ensureLocalEndpoint()).toBeNull();
    expect(mockPrisma.endpoint.create).not.toHaveBeenCalled();
  });
});
