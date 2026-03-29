import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock portainer
vi.mock("@/lib/portainer", () => ({
  getContainers: vi.fn(),
  getConfiguredEndpointId: vi.fn().mockResolvedValue(3),
  getImageInspect: vi.fn(),
  parseImageRef: vi.fn((image: string) => {
    const parts = image.split("/");
    const last = parts[parts.length - 1];
    const [repo, tag = "latest"] = last.includes(":") ? last.split(":") : [last, "latest"];
    const registry = parts.length >= 2 && parts[0].includes(".") ? parts[0] : "docker.io";
    const repository = registry !== "docker.io" ? parts.slice(1).join("/").split(":")[0] : image.split(":")[0];
    return { registry, repository, tag, full: image };
  }),
  isFloatingTag: vi.fn((tag: string) => ["latest", "main", "dev"].includes(tag)),
  recreateContainer: vi.fn(),
}));

// Mock ghcr
vi.mock("@/lib/ghcr", () => ({
  getRemoteDigest: vi.fn(),
}));

// Mock prisma
const mockPrisma = {
  settings: { findUnique: vi.fn() },
  service: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  activityLog: { create: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { getContainers, getImageInspect, recreateContainer } from "@/lib/portainer";
import { getRemoteDigest } from "@/lib/ghcr";

describe("syncServicesFromPortainer", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when settings are missing", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    const { syncServicesFromPortainer } = await import("@/lib/polling");
    await syncServicesFromPortainer();
    expect(getContainers).not.toHaveBeenCalled();
  });

  it("does nothing when portainerUrl is empty", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ portainerUrl: "", portainerApiKey: "key" });
    const { syncServicesFromPortainer } = await import("@/lib/polling");
    await syncServicesFromPortainer();
    expect(getContainers).not.toHaveBeenCalled();
  });

  it("upserts services from containers", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({
      portainerUrl: "https://test:9443",
      portainerApiKey: "key",
      portainerEndpointId: 3,
    });
    vi.mocked(getContainers).mockResolvedValue([
      { Id: "abc123", Names: ["/my-app"], Image: "ghcr.io/org/app:latest", ImageID: "sha256:aaa", State: "running", Status: "", Labels: {} },
    ]);
    vi.mocked(getImageInspect).mockResolvedValue({ Architecture: "amd64" });

    const { syncServicesFromPortainer } = await import("@/lib/polling");
    await syncServicesFromPortainer();

    expect(mockPrisma.service.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { containerId: "abc123" },
        update: expect.objectContaining({
          containerName: "my-app",
          currentDigest: "sha256:aaa",
          arch: "amd64",
        }),
      })
    );
  });

  it("removes services for containers that no longer exist", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({
      portainerUrl: "https://test:9443",
      portainerApiKey: "key",
      portainerEndpointId: 3,
    });
    vi.mocked(getContainers).mockResolvedValue([]); // no containers

    const { syncServicesFromPortainer } = await import("@/lib/polling");
    await syncServicesFromPortainer();

    expect(mockPrisma.service.deleteMany).toHaveBeenCalledWith({
      where: { containerId: { notIn: [] }, portainerEndpointId: 3 },
    });
  });

  it("falls back to amd64 when image inspect fails", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({
      portainerUrl: "https://test:9443",
      portainerApiKey: "key",
      portainerEndpointId: 3,
    });
    vi.mocked(getContainers).mockResolvedValue([
      { Id: "xyz", Names: ["/app"], Image: "nginx:latest", ImageID: "sha256:bbb", State: "running", Status: "", Labels: {} },
    ]);
    vi.mocked(getImageInspect).mockRejectedValue(new Error("not found"));

    const { syncServicesFromPortainer } = await import("@/lib/polling");
    await syncServicesFromPortainer();

    expect(mockPrisma.service.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ arch: "amd64" }),
      })
    );
  });
});

describe("checkForUpdates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks lastChecked even when remote digest is null", async () => {
    mockPrisma.service.findMany.mockResolvedValue([
      { id: "s1", image: "ghcr.io/org/app:latest", currentDigest: "sha256:old", arch: "amd64" },
    ]);
    mockPrisma.settings.findUnique.mockResolvedValue({ autoUpdateLatest: false });
    vi.mocked(getRemoteDigest).mockResolvedValue(null);

    const { checkForUpdates } = await import("@/lib/polling");
    await checkForUpdates();

    expect(mockPrisma.service.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastChecked: expect.any(Date) }),
      })
    );
  });

  it("detects update when digests differ", async () => {
    mockPrisma.service.findMany.mockResolvedValue([
      { id: "s1", image: "ghcr.io/org/app:latest", currentDigest: "sha256:old", arch: "amd64", isFloatingTag: false, containerName: "app" },
    ]);
    mockPrisma.settings.findUnique.mockResolvedValue({ autoUpdateLatest: false });
    vi.mocked(getRemoteDigest).mockResolvedValue("sha256:new");

    const { checkForUpdates } = await import("@/lib/polling");
    await checkForUpdates();

    expect(mockPrisma.service.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          remoteDigest: "sha256:new",
          updateAvailable: true,
        }),
      })
    );
  });

  it("does not flag update when digests match", async () => {
    mockPrisma.service.findMany.mockResolvedValue([
      { id: "s1", image: "ghcr.io/org/app:latest", currentDigest: "sha256:same", arch: "amd64" },
    ]);
    mockPrisma.settings.findUnique.mockResolvedValue({ autoUpdateLatest: false });
    vi.mocked(getRemoteDigest).mockResolvedValue("sha256:same");

    const { checkForUpdates } = await import("@/lib/polling");
    await checkForUpdates();

    expect(mockPrisma.service.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ updateAvailable: false }),
      })
    );
  });

  it("logs error and still sets lastChecked on failure", async () => {
    mockPrisma.service.findMany.mockResolvedValue([
      { id: "s1", image: "ghcr.io/org/app:latest", currentDigest: "sha256:old", arch: "amd64", containerName: "app" },
    ]);
    mockPrisma.settings.findUnique.mockResolvedValue({ autoUpdateLatest: false });
    vi.mocked(getRemoteDigest).mockRejectedValue(new Error("Network error"));
    mockPrisma.service.update.mockResolvedValue({});

    const { checkForUpdates } = await import("@/lib/polling");
    await checkForUpdates();

    // Should still update lastChecked
    expect(mockPrisma.service.update).toHaveBeenCalled();
    // Should log error
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "error" }),
      })
    );
  });
});

describe("performUpdate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws when service not found", async () => {
    mockPrisma.service.findUnique.mockResolvedValue(null);
    const { performUpdate } = await import("@/lib/polling");
    await expect(performUpdate("nonexistent")).rejects.toThrow("Service not found");
  });

  it("recreates container and updates digest", async () => {
    mockPrisma.service.findUnique.mockResolvedValue({
      id: "s1",
      containerId: "c1",
      image: "ghcr.io/org/app:latest",
      containerName: "app",
      portainerEndpointId: 3,
      arch: "amd64",
    });
    mockPrisma.service.update.mockResolvedValue({});
    vi.mocked(recreateContainer).mockResolvedValue("new-c1");
    vi.mocked(getRemoteDigest).mockResolvedValue("sha256:newdigest");

    const { performUpdate } = await import("@/lib/polling");
    await performUpdate("s1");

    expect(recreateContainer).toHaveBeenCalledWith(3, "c1", true);
    expect(mockPrisma.service.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          containerId: "new-c1",
          currentDigest: "sha256:newdigest",
          status: "running",
          updateAvailable: false,
        }),
      })
    );
    expect(mockPrisma.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "update" }),
      })
    );
  });

  it("sets status to error when recreate fails", async () => {
    mockPrisma.service.findUnique.mockResolvedValue({
      id: "s1",
      containerId: "c1",
      image: "ghcr.io/org/app:latest",
      containerName: "app",
      portainerEndpointId: 3,
      arch: "amd64",
    });
    mockPrisma.service.update.mockResolvedValue({});
    vi.mocked(recreateContainer).mockRejectedValue(new Error("Recreate failed"));

    const { performUpdate } = await import("@/lib/polling");
    await expect(performUpdate("s1")).rejects.toThrow("Recreate failed");

    // Should set status to "error"
    const errorUpdate = mockPrisma.service.update.mock.calls.find(
      (c: any) => c[0]?.data?.status === "error"
    );
    expect(errorUpdate).toBeDefined();
  });
});
