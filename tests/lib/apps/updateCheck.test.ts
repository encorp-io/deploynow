import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  application: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  deployment: { findUnique: vi.fn() },
  settings: { findUnique: vi.fn(async () => null) },
}));
const docker = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getImage: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(() => docker), refreshEndpoint: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/registryAuth", () => ({ registryAuthFor: vi.fn(async () => undefined), appPullContext: vi.fn(() => ({})) }));

import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import {
  checkAppUpdates,
  describeUpdates,
  newerTagsFor,
  newerVersionTags,
  parseCommitTag,
  parseVersionTag,
  updateCheckDue,
  withTag,
  type TagFinder,
} from "@/lib/apps/updateCheck";
import { composeImages } from "@/lib/apps/autoUpdate";

beforeEach(() => vi.clearAllMocks());

describe("version tags", () => {
  it("parses versions with a prefix and a suffix", () => {
    expect(parseVersionTag("v1.2.3-alpine")).toEqual({ prefix: "v", nums: [1, 2, 3], suffix: "-alpine" });
    expect(parseVersionTag("4.55")).toEqual({ prefix: "", nums: [4, 55], suffix: "" });
    expect(parseVersionTag("latest")).toBeNull();
    expect(parseVersionTag("sha-82e99af")).toBeNull();
  });

  it("finds the newest tag of the same shape", () => {
    const tags = ["4.54", "4.55", "4.56", "4.57", "4.58-rc1", "5.0", "5.1", "latest", "4.6"];
    expect(newerVersionTags("4.55", tags)).toEqual({ minor: "4.57", major: "5.1" });
    expect(newerVersionTags("5.1", tags)).toEqual({});
  });

  it("keeps the suffix and compares numerically", () => {
    const tags = ["16-alpine", "17-alpine", "18-alpine", "18", "18-bookworm", "17.2-alpine", "9-alpine"];
    expect(newerVersionTags("17-alpine", tags)).toEqual({ major: "18-alpine" });
    expect(newerVersionTags("v1.9.0", ["v1.10.0", "1.11.0", "v2.0.0"])).toEqual({ minor: "v1.10.0", major: "v2.0.0" });
  });
});

describe("commit tags", () => {
  it("recognises commit builds but not dates", () => {
    expect(parseCommitTag("sha-82e99af")).toEqual({ prefix: "sha-", hex: "82e99af" });
    expect(parseCommitTag("82e99af1")).toEqual({ prefix: "", hex: "82e99af1" });
    expect(parseCommitTag("20241105")).toBeNull();
    expect(parseCommitTag("main")).toBeNull();
  });

  it("swaps the tag of an image", () => {
    expect(withTag("ghcr.io/encorp-io/delory:sha-82e99af", "main")).toBe("ghcr.io/encorp-io/delory:main");
    expect(withTag("registry.lan:5000/app", "1.2")).toBe("registry.lan:5000/app:1.2");
  });
});

const local = { currentDigest: "sha256:old", repoDigests: "ghcr.io/encorp-io/delory@sha256:oldidx", arch: "amd64", created: "2026-11-27T10:00:00Z" };
const finder = (tags: string[], info: Awaited<ReturnType<TagFinder["info"]>>): TagFinder => ({ tags: vi.fn(async () => tags), info: vi.fn(async () => info) });

describe("newerTagsFor", () => {
  it("names the newer build a moving tag points to by its commit tag", async () => {
    const f = finder(["sha-82e99af", "sha-1a2b3c4", "main"], { config: "sha256:new", manifest: "sha256:newidx", created: "2026-11-27T20:00:00Z", revision: "1a2b3c4d5e6f" });
    expect(await newerTagsFor("ghcr.io/encorp-io/delory:sha-82e99af", local, undefined, f)).toEqual([
      { image: "ghcr.io/encorp-io/delory:sha-82e99af", from: "sha-82e99af", to: "sha-1a2b3c4", kind: "build", via: "main" },
    ]);
    expect(f.info).toHaveBeenCalledWith("ghcr.io/encorp-io/delory:main", { arch: "amd64", auth: undefined });
  });

  it("suggests the moving tag when there is no matching commit tag", async () => {
    const f = finder(["sha-82e99af", "latest"], { config: "sha256:new", manifest: "sha256:newidx", created: "2026-11-27T20:00:00Z", revision: "" });
    expect((await newerTagsFor("ghcr.io/encorp-io/delory:sha-82e99af", local, undefined, f))[0]).toMatchObject({ to: "latest", via: "latest" });
  });

  it("is quiet when the moving tag runs already, or points to an older build", async () => {
    const same = finder(["main"], { config: "sha256:x", manifest: "sha256:oldidx", created: "2026-11-27T20:00:00Z", revision: "" });
    expect(await newerTagsFor("ghcr.io/encorp-io/delory:sha-82e99af", local, undefined, same)).toEqual([]);
    const older = finder(["main"], { config: "sha256:new", manifest: "sha256:newidx", created: "2026-11-26T20:00:00Z", revision: "" });
    expect(await newerTagsFor("ghcr.io/encorp-io/delory:sha-82e99af", local, undefined, older)).toEqual([]);
  });

  it("lists newer versions and doesn't look at floating tags", async () => {
    const f = finder(["4.55", "4.56", "5.0"], null);
    expect(await newerTagsFor("chrislusf/seaweedfs:4.55", local, undefined, f)).toEqual([
      { image: "chrislusf/seaweedfs:4.55", from: "4.55", to: "4.56", kind: "minor" },
      { image: "chrislusf/seaweedfs:4.55", from: "4.55", to: "5.0", kind: "major" },
    ]);
    const g = finder(["latest"], null);
    expect(await newerTagsFor("nginx:latest", local, undefined, g)).toEqual([]);
    expect(g.tags).not.toHaveBeenCalled();
  });
});

describe("composeImages", () => {
  it("remembers the variable a whole image comes from", () => {
    const yaml = "services:\n  app:\n    image: ${APP_IMAGE:-ghcr.io/a/b:sha-1234567}\n  db:\n    image: postgres:${PG:-17}-alpine\n";
    expect(composeImages(yaml, {})).toEqual([
      { service: "app", image: "ghcr.io/a/b:sha-1234567", variable: "APP_IMAGE" },
      { service: "db", image: "postgres:17-alpine" },
    ]);
  });
});

describe("checkAppUpdates", () => {
  const COMPOSE = "services:\n  app:\n    image: ${DELORY_IMAGE:-ghcr.io/encorp-io/delory:sha-82e99af}\n  s3:\n    image: chrislusf/seaweedfs:4.55\n";
  const app = {
    id: "a1",
    name: "delory",
    slug: "delory",
    sourceType: "compose",
    status: "running",
    currentDeploymentId: "d1",
    autoUpdate: false,
    env: "[]",
    updateInfo: "",
    endpointId: "ep1",
    endpoint: { id: "ep1", name: "local" },
    environment: { name: "production", projectId: "p1", project: { name: "delory.ai" } },
  };

  beforeEach(() => {
    mockPrisma.application.findUnique.mockResolvedValue(app);
    mockPrisma.deployment.findUnique.mockResolvedValue({ id: "d1", renderedCompose: COMPOSE, envSnapshot: "", commitSha: "", imageDigest: "" });
    docker.listContainers.mockResolvedValue([
      { Id: "c1", ImageID: "sha256:app", Labels: { "com.docker.compose.service": "app" } },
      { Id: "c2", ImageID: "sha256:s3", Labels: { "com.docker.compose.service": "s3" } },
    ]);
    docker.getImage.mockImplementation(() => ({ inspect: async () => ({ Architecture: "amd64", RepoDigests: [], Created: "2026-11-27T10:00:00Z" }) }));
  });

  it("finds newer tags for a compose app with auto-update off, and stores them", async () => {
    const tagFinder: TagFinder = {
      tags: async (image) => (image.includes("delory") ? ["sha-82e99af", "sha-1a2b3c4", "main"] : ["4.55", "4.56"]),
      info: async () => ({ config: "sha256:newapp", manifest: "sha256:newidx", created: "2026-11-27T20:00:00Z", revision: "1a2b3c4ffff" }),
    };
    // Same tags, same digests: no new image for the tags it runs
    const digestFinder = { branchHead: async () => "", digests: async (image: string) => ({ config: image.includes("delory") ? "sha256:app" : "sha256:s3", manifest: "" }) };
    const r = await checkAppUpdates("a1", { finder: digestFinder, tagFinder });
    expect(r.info.changes).toEqual([]);
    expect(r.info.tags).toEqual([
      { service: "app", image: "ghcr.io/encorp-io/delory:sha-82e99af", from: "sha-82e99af", to: "sha-1a2b3c4", kind: "build", via: "main", variable: "DELORY_IMAGE" },
      { service: "s3", image: "chrislusf/seaweedfs:4.55", from: "4.55", to: "4.56", kind: "minor" },
    ]);
    expect(r.summary).toBe("app: sha-82e99af → newer build sha-1a2b3c4 (on :main); s3: 4.55 → 4.56");
    const data = mockPrisma.application.update.mock.calls[0][0].data;
    expect(JSON.parse(data.updateInfo).tags).toHaveLength(2);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "app.update_available" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "app.update_available" }));
  });

  it("reports a new digest for the same tag and doesn't notify twice", async () => {
    const tagFinder: TagFinder = { tags: async () => [], info: async () => null };
    const digestFinder = { branchHead: async () => "", digests: async (image: string) => ({ config: image.includes("delory") ? "sha256:fresh" : "sha256:s3", manifest: "" }) };
    const first = await checkAppUpdates("a1", { finder: digestFinder, tagFinder });
    expect(first.info.changes).toHaveLength(1);
    expect(describeUpdates(first.info)).toBe("app (ghcr.io/encorp-io/delory:sha-82e99af): new image for the same tag");
    mockPrisma.application.findUnique.mockResolvedValue({ ...app, updateInfo: mockPrisma.application.update.mock.calls[0][0].data.updateInfo });
    vi.mocked(notify).mockClear();
    await checkAppUpdates("a1", { finder: digestFinder, tagFinder });
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps the last result when a check only fails", async () => {
    const stored = JSON.stringify({ changes: [], tags: [{ service: "s3", image: "x:1.0", from: "1.0", to: "1.1", kind: "minor" }] });
    mockPrisma.application.findUnique.mockResolvedValue({ ...app, updateInfo: stored });
    const failing = { branchHead: async () => "", digests: async () => Promise.reject(new Error("registry down")) };
    const r = await checkAppUpdates("a1", { finder: failing, tagFinder: { tags: async () => Promise.reject(new Error("registry down")), info: async () => null } });
    expect(r.error).toBe("registry down");
    expect(r.info.tags).toHaveLength(1);
    expect(mockPrisma.application.update.mock.calls[0][0].data).toEqual({ updateCheckedAt: expect.any(Date), updateError: "registry down" });
  });

  it("is due once an hour", () => {
    const now = new Date("2026-11-27T21:00:00Z");
    expect(updateCheckDue({ updateCheckedAt: null }, now)).toBe(true);
    expect(updateCheckDue({ updateCheckedAt: new Date("2026-11-27T20:30:00Z") }, now)).toBe(false);
    expect(updateCheckDue({ updateCheckedAt: new Date("2026-11-27T20:00:00Z") }, now)).toBe(true);
  });
});
