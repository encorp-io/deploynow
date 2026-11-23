import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  settings: { findUnique: vi.fn() },
  endpoint: { findMany: vi.fn() },
  service: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
}));
const docker = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getImage: vi.fn(() => ({ inspect: vi.fn(async () => ({ Architecture: "arm64", RepoDigests: ["ghcr.io/acme/web@sha256:idx"] })) })),
  getContainer: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/ghcr", () => ({ getRemoteDigests: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/registryAuth", () => ({ registryAuthFor: vi.fn(async () => undefined) }));
vi.mock("@/lib/docker/recreate", () => ({ recreateContainer: vi.fn() }));
vi.mock("@/lib/endpoints", () => ({
  dockerFor: vi.fn(() => docker),
  refreshEndpoint: vi.fn(async (ep: { status?: string }) => ({ ...ep, status: ep.status ?? "online" })),
}));

import { getRemoteDigests } from "@/lib/ghcr";
import { audit } from "@/lib/audit";
import { recreateContainer } from "@/lib/docker/recreate";
import { syncServices, checkForUpdates, performUpdate, isProtectedContainer, isCurrent } from "@/lib/polling";

const EP = { id: "ep1", name: "local" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isProtectedContainer", () => {
  it("protects Portainer, the deployer and labelled containers", () => {
    expect(isProtectedContainer("portainer/portainer-ce:latest", "abc")).toBe(true);
    expect(isProtectedContainer("ghcr.io/encorp-io/deployer-for-portainer:latest", "abc")).toBe(true);
    expect(isProtectedContainer("nginx:latest", "abc", { "io.deploynow.self": "true" })).toBe(true);
    expect(isProtectedContainer("nginx:latest", "abc")).toBe(false);
  });
});

describe("isCurrent", () => {
  const remote = { config: "sha256:cfg", manifest: "sha256:idx" };
  it("matches the classic image store (ImageID = config digest)", () => {
    expect(isCurrent({ currentDigest: "sha256:cfg" }, remote)).toBe(true);
  });
  it("matches the containerd image store (ImageID = index digest)", () => {
    expect(isCurrent({ currentDigest: "sha256:idx" }, remote)).toBe(true);
  });
  it("matches through RepoDigests", () => {
    expect(isCurrent({ currentDigest: "sha256:local", repoDigests: "ghcr.io/a/b@sha256:old,ghcr.io/a/b@sha256:idx" }, remote)).toBe(true);
  });
  it("reports a new image", () => {
    expect(isCurrent({ currentDigest: "sha256:local", repoDigests: "ghcr.io/a/b@sha256:old" }, remote)).toBe(false);
    expect(isCurrent({ currentDigest: "sha256:local" }, { config: "sha256:cfg", manifest: "" })).toBe(false);
  });
  it("treats an unknown local digest as current", () => {
    expect(isCurrent({ currentDigest: "" }, remote)).toBe(true);
  });
});

describe("syncServices", () => {
  it("skips offline endpoints", async () => {
    mockPrisma.endpoint.findMany.mockResolvedValue([{ ...EP, status: "offline" }]);
    await syncServices();
    expect(docker.listContainers).not.toHaveBeenCalled();
  });

  it("upserts tagged containers and drops ones that are gone", async () => {
    mockPrisma.endpoint.findMany.mockResolvedValue([EP]);
    docker.listContainers.mockResolvedValue([
      { Id: "c1", Names: ["/web"], Image: "ghcr.io/acme/web:latest", ImageID: "sha256:aaa", State: "running" },
      { Id: "c2", Names: ["/raw"], Image: "sha256:deadbeef", ImageID: "sha256:bbb", State: "running" },
      { Id: "c3", Names: ["/pinned"], Image: "ghcr.io/acme/web@sha256:" + "a".repeat(64), ImageID: "sha256:ccc", State: "running" },
    ]);
    await syncServices();
    expect(mockPrisma.service.upsert).toHaveBeenCalledTimes(1);
    const { where, create } = mockPrisma.service.upsert.mock.calls[0][0];
    expect(where).toEqual({ containerId: "c1" });
    expect(create).toMatchObject({ containerName: "web", registry: "ghcr.io", tag: "latest", isFloatingTag: true, arch: "arm64", endpointId: "ep1", currentDigest: "sha256:aaa", repoDigests: "ghcr.io/acme/web@sha256:idx" });
    expect(mockPrisma.service.deleteMany).toHaveBeenCalledWith({ where: { endpointId: "ep1", containerId: { notIn: ["c1", "c2", "c3"] } } });
  });

  it("keeps going when one endpoint fails", async () => {
    mockPrisma.endpoint.findMany.mockResolvedValue([EP, { id: "ep2", name: "b" }]);
    docker.listContainers.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([]);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await syncServices();
    expect(docker.listContainers).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});

describe("checkForUpdates", () => {
  const svc = { id: "s1", containerId: "c1", containerName: "web", image: "ghcr.io/acme/web:latest", arch: "amd64", currentDigest: "sha256:old", remoteDigest: "", updateAvailable: false, isFloatingTag: true, endpointId: "ep1" };

  it("only touches lastChecked when the registry has no digest", async () => {
    mockPrisma.service.findMany.mockResolvedValue([svc]);
    vi.mocked(getRemoteDigests).mockResolvedValue(null);
    await checkForUpdates();
    expect(mockPrisma.service.update.mock.calls[0][0].data).toEqual({ lastChecked: expect.any(Date) });
  });

  it("records a new update once", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ autoUpdateLatest: false });
    vi.mocked(getRemoteDigests).mockResolvedValue({ config: "sha256:new", manifest: "sha256:newindex" });
    mockPrisma.service.findMany.mockResolvedValue([svc]);
    await checkForUpdates();
    expect(mockPrisma.service.update.mock.calls[0][0].data).toMatchObject({ remoteDigest: "sha256:new", updateAvailable: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "service.update_available" }));

    vi.mocked(audit).mockClear();
    mockPrisma.service.findMany.mockResolvedValue([{ ...svc, updateAvailable: true, remoteDigest: "sha256:new" }]);
    await checkForUpdates();
    expect(audit).not.toHaveBeenCalled();
  });

  it("auto-updates floating tags when enabled", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue({ autoUpdateLatest: true });
    vi.mocked(getRemoteDigests).mockResolvedValue({ config: "sha256:new", manifest: "sha256:newindex" });
    mockPrisma.service.findMany.mockResolvedValue([svc]);
    mockPrisma.service.findUnique.mockResolvedValue({ ...svc, endpoint: EP });
    vi.mocked(recreateContainer).mockResolvedValue("c9");
    docker.getContainer.mockReturnValue({ inspect: async () => ({ Image: "sha256:new", State: { Running: true, Status: "running" } }) });
    await checkForUpdates();
    expect(recreateContainer).toHaveBeenCalledWith(docker, "c1", { pull: true, authconfig: undefined });
  });

  it("audits a failed check", async () => {
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    mockPrisma.service.findMany.mockResolvedValue([svc]);
    mockPrisma.service.update.mockResolvedValue({});
    vi.mocked(getRemoteDigests).mockRejectedValue(new Error("registry down"));
    await checkForUpdates();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "service.check", outcome: "failure" }));
  });
});

describe("performUpdate", () => {
  const svc = { id: "s1", containerId: "c1", containerName: "web", image: "nginx:latest", remoteDigest: "sha256:new", endpointId: "ep1", endpoint: EP };

  it("throws for a missing service or endpoint", async () => {
    mockPrisma.service.findUnique.mockResolvedValue(null);
    await expect(performUpdate("s1")).rejects.toThrow("Service not found");
    mockPrisma.service.findUnique.mockResolvedValue({ ...svc, endpoint: null });
    await expect(performUpdate("s1")).rejects.toThrow("no endpoint");
  });

  it("recreates the container and stores the new id", async () => {
    mockPrisma.service.findUnique.mockResolvedValue(svc);
    vi.mocked(recreateContainer).mockResolvedValue("c2");
    docker.getContainer.mockReturnValue({ inspect: async () => ({ Image: "sha256:new", State: { Running: true, Status: "running" } }) });
    await performUpdate("s1", { id: "u", email: "u@x" }, "1.1.1.1");
    const last = mockPrisma.service.update.mock.calls.at(-1)![0].data;
    expect(last).toMatchObject({ containerId: "c2", currentDigest: "sha256:new", updateAvailable: false, status: "running" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "service.update", ip: "1.1.1.1" }));
  });

  it("marks the service as errored and audits a failure", async () => {
    mockPrisma.service.findUnique.mockResolvedValue(svc);
    vi.mocked(recreateContainer).mockRejectedValue(new Error("pull denied"));
    await expect(performUpdate("s1")).rejects.toThrow("pull denied");
    expect(mockPrisma.service.update).toHaveBeenLastCalledWith({ where: { id: "s1" }, data: { status: "error" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
  });
});
