import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/portainer", () => ({
  getContainerLogs: vi.fn(),
  restartContainer: vi.fn(),
}));

const mockPrisma = {
  healthMonitor: { findUnique: vi.fn() },
  settings: { findUnique: vi.fn() },
  service: { findMany: vi.fn(), update: vi.fn() },
  activityLog: { create: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { getContainerLogs, restartContainer } from "@/lib/portainer";

const defaultConfig = {
  id: "singleton",
  enabled: true,
  prefixes: "n8n-worker",
  logWindow: 300,
  cooldown: 10,
  logPatterns: "timeout exceeded when trying to connect\ndatabase connection timed out",
};
const defaultSettings = {
  portainerUrl: "https://portainer.test:9443",
  portainerApiKey: "key",
  portainerEndpointId: 1,
};
const runningWorker = {
  id: "svc1",
  containerId: "abc123",
  containerName: "n8n-worker-1",
  status: "running",
  lastHealthRestart: null,
};

describe("runHealthMonitor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns early when config not found", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(null);
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(mockPrisma.settings.findUnique).not.toHaveBeenCalled();
  });

  it("returns early when disabled", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue({ ...defaultConfig, enabled: false });
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(mockPrisma.settings.findUnique).not.toHaveBeenCalled();
  });

  it("returns early when Portainer URL is not configured", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(defaultConfig);
    mockPrisma.settings.findUnique.mockResolvedValue({ portainerUrl: "", portainerApiKey: "" });
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(mockPrisma.service.findMany).not.toHaveBeenCalled();
  });

  it("returns early when logPatterns is empty", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue({ ...defaultConfig, logPatterns: "   \n  " });
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(mockPrisma.service.findMany).not.toHaveBeenCalled();
  });

  it("skips containers whose names do not match any prefix", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(defaultConfig);
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([
      { ...runningWorker, containerName: "postgres" },
      { ...runningWorker, containerName: "redis-cache" },
    ]);
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(getContainerLogs).not.toHaveBeenCalled();
  });

  it("monitors all containers when prefixes is empty", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue({ ...defaultConfig, prefixes: "" });
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([
      { ...runningWorker, containerName: "postgres" },
      { ...runningWorker, id: "svc2", containerId: "def456", containerName: "redis-cache" },
    ]);
    vi.mocked(getContainerLogs).mockResolvedValue("all good");
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(getContainerLogs).toHaveBeenCalledTimes(2);
  });

  it("matches multiple prefixes — skips containers that match none", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue({
      ...defaultConfig,
      prefixes: "n8n-worker\nglances",
    });
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([
      { ...runningWorker, containerName: "n8n-worker-1" },
      { ...runningWorker, id: "svc2", containerId: "def456", containerName: "glances-monitor" },
      { ...runningWorker, id: "svc3", containerId: "ghi789", containerName: "postgres" },
    ]);
    vi.mocked(getContainerLogs).mockResolvedValue("clean logs");
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(getContainerLogs).toHaveBeenCalledTimes(2);
  });

  it("skips a container that is still within the cooldown window", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(defaultConfig); // cooldown: 10 min
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([
      { ...runningWorker, lastHealthRestart: fiveMinutesAgo },
    ]);
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(getContainerLogs).not.toHaveBeenCalled();
  });

  it("processes a container after the cooldown has elapsed", async () => {
    const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(defaultConfig); // cooldown: 10 min
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([
      { ...runningWorker, lastHealthRestart: elevenMinutesAgo },
    ]);
    vi.mocked(getContainerLogs).mockResolvedValue("normal log output");
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(getContainerLogs).toHaveBeenCalled();
  });

  it("does not restart when no pattern is present in logs", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(defaultConfig);
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([runningWorker]);
    vi.mocked(getContainerLogs).mockResolvedValue("Worker finished job 123 successfully");
    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();
    expect(restartContainer).not.toHaveBeenCalled();
    expect(mockPrisma.activityLog.create).not.toHaveBeenCalled();
  });

  it("restarts when a configured pattern is detected in logs", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(defaultConfig);
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([runningWorker]);
    vi.mocked(getContainerLogs).mockResolvedValue(
      "timeout exceeded when trying to connect (execution 6912767)"
    );
    vi.mocked(restartContainer).mockResolvedValue(undefined);
    mockPrisma.service.update.mockResolvedValue({});
    mockPrisma.activityLog.create.mockResolvedValue({});

    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();

    expect(restartContainer).toHaveBeenCalledWith(1, "abc123");
    expect(mockPrisma.service.update).toHaveBeenCalledWith({
      where: { id: "svc1" },
      data: { lastHealthRestart: expect.any(Date) },
    });
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "health_restart", serviceId: "svc1" }),
      })
    );
  });

  it("restarts when a custom log pattern is detected", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue({
      ...defaultConfig,
      logPatterns: "out of memory\nkilled process",
    });
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([runningWorker]);
    vi.mocked(getContainerLogs).mockResolvedValue("OOM killer: killed process 1234");
    vi.mocked(restartContainer).mockResolvedValue(undefined);
    mockPrisma.service.update.mockResolvedValue({});
    mockPrisma.activityLog.create.mockResolvedValue({});

    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();

    expect(restartContainer).toHaveBeenCalled();
  });

  it("matches prefixes case-insensitively", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue({ ...defaultConfig, prefixes: "N8N-Worker" });
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([runningWorker]); // "n8n-worker-1"
    vi.mocked(getContainerLogs).mockResolvedValue("normal logs");

    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();

    expect(getContainerLogs).toHaveBeenCalled();
  });

  it("logs error per container and continues processing remaining containers", async () => {
    mockPrisma.healthMonitor.findUnique.mockResolvedValue(defaultConfig);
    mockPrisma.settings.findUnique.mockResolvedValue(defaultSettings);
    mockPrisma.service.findMany.mockResolvedValue([
      runningWorker,
      { ...runningWorker, id: "svc2", containerId: "def456", containerName: "n8n-worker-2" },
    ]);
    vi.mocked(getContainerLogs)
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce("no issues here");
    mockPrisma.activityLog.create.mockResolvedValue({});

    const { runHealthMonitor } = await import("@/lib/healthMonitor");
    await runHealthMonitor();

    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "error", serviceId: "svc1" }),
      })
    );
    expect(restartContainer).not.toHaveBeenCalled();
    expect(getContainerLogs).toHaveBeenCalledTimes(2);
  });
});
