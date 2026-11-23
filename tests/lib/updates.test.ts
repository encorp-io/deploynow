import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ s: null as Record<string, unknown> | null }));
const mockPrisma = vi.hoisted(() => ({
  settings: {
    findUnique: vi.fn(async () => store.s),
    upsert: vi.fn(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => (store.s = store.s ? { ...store.s, ...update } : { ...create })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (store.s = { ...store.s, ...data })),
  },
}));
const notify = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/lib/version", () => ({ VERSION: "2.0.0" }));

import { checkForUpdate, compareVersions, pickLatest, updateStatus } from "@/lib/updates";

beforeEach(() => {
  vi.clearAllMocks();
  store.s = null;
});

describe("compareVersions", () => {
  it("orders versions", () => {
    expect(compareVersions("2.1.0", "2.0.9")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-rc.10", "2.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("edge-abc1234", "2.0.0")).toBe(0);
  });
});

describe("pickLatest", () => {
  const releases = [
    { tag_name: "v2.0.0", html_url: "https://github.com/encorp-io/deploynow/releases/tag/v2.0.0", body: "first" },
    { tag_name: "v2.2.0-rc.1", prerelease: true, html_url: "https://github.com/x" },
    { tag_name: "v2.1.0", html_url: "https://evil.example/x", body: "second" },
    { tag_name: "v3.0.0", draft: true },
    { tag_name: "nightly" },
  ];
  it("takes the newest stable release and drops non-GitHub links", () => {
    expect(pickLatest(releases, "2.0.0")).toEqual({ version: "2.1.0", url: "", notes: "second" });
  });
  it("counts pre-releases when running one", () => {
    expect(pickLatest(releases, "2.1.0-rc.1")?.version).toBe("2.2.0-rc.1");
  });
  it("returns null with nothing usable", () => {
    expect(pickLatest([{ tag_name: "nightly" }])).toBeNull();
  });
});

describe("checkForUpdate", () => {
  const fake = (list: unknown, ok = true) =>
    vi.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => list }) as unknown as Response);

  it("saves the newest release and notifies once per version", async () => {
    const f = fake([{ tag_name: "v2.1.0", html_url: "https://github.com/encorp-io/deploynow/releases/tag/v2.1.0", body: "notes" }]);
    const s = await checkForUpdate(f as unknown as typeof fetch);
    expect(s).toMatchObject({ current: "2.0.0", latest: "2.1.0", available: true, notes: "notes" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ event: "update.available", title: "DeployNow 2.1.0 is available" });
    await checkForUpdate(f as unknown as typeof fetch);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify when up to date", async () => {
    const s = await checkForUpdate(fake([{ tag_name: "v2.0.0" }]) as unknown as typeof fetch);
    expect(s.available).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("throws on API errors", async () => {
    await expect(checkForUpdate(fake({}, false) as unknown as typeof fetch)).rejects.toThrow(/403/);
  });

  it("reports the check as enabled by default", async () => {
    expect((await updateStatus()).enabled).toBe(true);
  });
});
