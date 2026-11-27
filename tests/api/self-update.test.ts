import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ s: { latestRelease: "2.1.0", selfUpdateAuto: false, selfUpdateHour: -1 } as Record<string, unknown> }));
const self = vi.hoisted(() => ({
  startSelfUpdate: vi.fn(async () => ({ state: "starting" })),
  selfUpdateInfo: vi.fn(async () => ({ supported: true, reason: "", image: "ghcr.io/encorp-io/deploynow:2.0.0", pinned: true, auto: false, hour: -1, status: null })),
  isSelfContainer: vi.fn((id: string) => id === "selfcontainer"),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn(async () => store.s),
      upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => (store.s = { ...store.s, ...update })),
    },
    service: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, containerId: where.id === "c" + "s".repeat(24) ? "selfcontainer" : "other", endpointId: null })) },
    auditEvent: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/version", () => ({ VERSION: "2.0.0" }));
vi.mock("@/lib/selfUpdate", async () => {
  const real = await vi.importActual<typeof import("@/lib/selfUpdate")>("@/lib/selfUpdate");
  return { ...real, ...self };
});
vi.mock("@/lib/polling", () => ({ performUpdate: vi.fn(async () => {}) }));

import { signInAs } from "../helpers/apiAuthMock";
import { GET, POST } from "@/app/api/updates/route";
import { POST as updateService } from "@/app/api/services/update/route";

const post = (body: unknown) => new Request("https://x/api/updates", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  store.s = { latestRelease: "2.1.0", selfUpdateAuto: false, selfUpdateHour: -1 };
});

describe("/api/updates self-update", () => {
  it("shows self-update to admins", async () => {
    signInAs("admin");
    const d = await (await GET()).json();
    expect(d.selfUpdate).toMatchObject({ supported: true, pinned: true, envDisabled: false });
    signInAs("operator");
    expect(await (await GET()).json()).toEqual({ current: "2.0.0" });
  });

  it("starts an update for admins only", async () => {
    signInAs("operator");
    expect((await POST(post({ install: true }))).status).toBe(403);
    signInAs("admin");
    expect((await POST(post({ install: true }))).status).toBe(200);
    expect(self.startSelfUpdate).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ email: "admin@test.local" }) }));
  });

  it("maps updater errors to statuses", async () => {
    const { SelfUpdateError } = await vi.importActual<typeof import("@/lib/selfUpdate")>("@/lib/selfUpdate");
    signInAs("owner");
    self.startSelfUpdate.mockRejectedValueOnce(new SelfUpdateError("An update is already running.", "busy"));
    const r = await POST(post({ install: true }));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/already running/);
  });

  it("saves auto-update and its hour", async () => {
    signInAs("admin");
    expect((await POST(post({ auto: true, hour: 3 }))).status).toBe(200);
    expect(store.s).toMatchObject({ selfUpdateAuto: true, selfUpdateHour: 3 });
    expect((await POST(post({ hour: 24 }))).status).toBe(400);
  });

  it("saves the update channel", async () => {
    signInAs("admin");
    expect((await POST(post({ channel: "edge" }))).status).toBe(200);
    expect(store.s.selfUpdateChannel).toBe("edge");
    expect((await POST(post({ channel: "nightly" }))).status).toBe(400);
    signInAs("operator");
    expect((await POST(post({ channel: "stable" }))).status).toBe(403);
  });
});

describe("Services → Update on DeployNow's own container", () => {
  it("goes through the updater instead of recreating in place", async () => {
    signInAs("admin");
    const r = await updateService(new Request("https://x", { method: "POST", body: JSON.stringify({ serviceId: "c" + "s".repeat(24) }) }));
    expect(await r.json()).toEqual({ success: true, selfUpdate: true });
    expect(self.startSelfUpdate).toHaveBeenCalled();
    const { performUpdate } = await import("@/lib/polling");
    expect(performUpdate).not.toHaveBeenCalled();
  });

  it("needs admin for that", async () => {
    signInAs("operator");
    const r = await updateService(new Request("https://x", { method: "POST", body: JSON.stringify({ serviceId: "c" + "s".repeat(24) }) }));
    expect(r.status).toBe(403);
  });
});
