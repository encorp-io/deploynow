import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  healthMonitor: { findUnique: vi.fn() },
  service: { findMany: vi.fn(), update: vi.fn() },
}));
const container = vi.hoisted(() => ({ logs: vi.fn(), restart: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(() => ({ getContainer: () => container })) }));

import { audit } from "@/lib/audit";
import { runHealthMonitor } from "@/lib/healthMonitor";

const EP = { id: "ep1", name: "local" };
const svc = (name: string, extra = {}) => ({ id: `s-${name}`, containerId: `c-${name}`, containerName: name, endpointId: "ep1", endpoint: EP, lastHealthRestart: null, ...extra });
const config = (extra = {}) => mockPrisma.healthMonitor.findUnique.mockResolvedValue({ enabled: true, prefixes: "", logPatterns: "connection timeout\nout of memory", logWindow: 300, cooldown: 10, ...extra });
const logs = (text: string) => container.logs.mockResolvedValue(Buffer.from(text));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runHealthMonitor", () => {
  it("does nothing when disabled, missing or without patterns", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(null);
    await runHealthMonitor();
    config({ enabled: false });
    await runHealthMonitor();
    config({ logPatterns: "\n  \n" });
    await runHealthMonitor();
    expect(mockPrisma.service.findMany).not.toHaveBeenCalled();
  });

  it("only looks at running services on online endpoints", async () => {
    config();
    mockPrisma.service.findMany.mockResolvedValue([]);
    await runHealthMonitor();
    expect(mockPrisma.service.findMany.mock.calls[0][0].where).toEqual({ status: "running", endpoint: { status: "online" } });
  });

  it("filters by prefix, case-insensitively", async () => {
    config({ prefixes: "N8N-\nworker" });
    mockPrisma.service.findMany.mockResolvedValue([svc("n8n-main"), svc("Worker-1"), svc("postgres")]);
    logs("all good");
    await runHealthMonitor();
    expect(container.logs).toHaveBeenCalledTimes(2);
  });

  it("restarts on a matching pattern and audits it", async () => {
    config();
    mockPrisma.service.findMany.mockResolvedValue([svc("app")]);
    logs("2024 ERROR Connection Timeout to db");
    await runHealthMonitor();
    expect(container.restart).toHaveBeenCalledWith({ t: 10 });
    expect(mockPrisma.service.update).toHaveBeenCalledWith({ where: { id: "s-app" }, data: { lastHealthRestart: expect.any(Date) } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "health.restart", endpointId: "ep1" }));
  });

  it("reads multiplexed Docker log frames", async () => {
    config();
    mockPrisma.service.findMany.mockResolvedValue([svc("app")]);
    const payload = Buffer.from("fatal: out of memory\n");
    const header = Buffer.alloc(8);
    header[0] = 2;
    header.writeUInt32BE(payload.length, 4);
    container.logs.mockResolvedValue(Buffer.concat([header, payload]));
    await runHealthMonitor();
    expect(container.restart).toHaveBeenCalled();
  });

  it("does not restart without a match", async () => {
    config();
    mockPrisma.service.findMany.mockResolvedValue([svc("app")]);
    logs("fine");
    await runHealthMonitor();
    expect(container.restart).not.toHaveBeenCalled();
  });

  it("respects the cooldown", async () => {
    config({ cooldown: 10 });
    mockPrisma.service.findMany.mockResolvedValue([svc("recent", { lastHealthRestart: new Date(Date.now() - 60_000) }), svc("old", { lastHealthRestart: new Date(Date.now() - 3_600_000) })]);
    logs("connection timeout");
    await runHealthMonitor();
    expect(container.restart).toHaveBeenCalledTimes(1);
  });

  it("audits a failure and keeps going", async () => {
    config();
    mockPrisma.service.findMany.mockResolvedValue([svc("a"), svc("b")]);
    container.logs.mockRejectedValueOnce(new Error("no such container")).mockResolvedValueOnce(Buffer.from("connection timeout"));
    await runHealthMonitor();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "health.check", outcome: "failure" }));
    expect(container.restart).toHaveBeenCalledTimes(1);
  });
});
