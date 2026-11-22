import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({ service: { findMany: vi.fn(), findUnique: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/polling", () => ({ syncServices: vi.fn(), checkForUpdates: vi.fn(), performUpdate: vi.fn() }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { syncServices, performUpdate } from "@/lib/polling";
import { GET, POST } from "@/app/api/services/route";
import { POST as UPDATE } from "@/app/api/services/update/route";

const EP_A = "c" + "a".repeat(24);
const EP_B = "c" + "b".repeat(24);
const SVC = "c" + "s".repeat(24);
const services = [
  { id: "s1", containerName: "a", endpointId: EP_A },
  { id: "s2", containerName: "b", endpointId: EP_B },
];
const post = (fn: (r: Request) => Promise<Response>, body: unknown) => fn(new Request("http://x", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  mockPrisma.service.findMany.mockResolvedValue(services);
});

describe("GET /api/services", () => {
  it("returns 401 when signed out", async () => {
    expect((await GET()).status).toBe(401);
  });

  it("returns every service to an instance viewer", async () => {
    signInAs("viewer");
    expect(await (await GET()).json()).toHaveLength(2);
  });
});

describe("POST /api/services", () => {
  it("is admin only", async () => {
    signInAs("operator");
    expect((await post(POST, { action: "sync" })).status).toBe(403);
  });

  it("syncs and returns the list", async () => {
    signInAs("admin");
    const res = await post(POST, { action: "sync" });
    expect(res.status).toBe(200);
    expect(syncServices).toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    signInAs("admin");
    expect((await post(POST, { action: "nope" })).status).toBe(400);
  });
});

describe("POST /api/services/update", () => {
  it("validates the service id", async () => {
    signInAs("operator");
    expect((await post(UPDATE, {})).status).toBe(400);
    expect((await post(UPDATE, { serviceId: "../etc" })).status).toBe(400);
  });

  it("returns 404 for an unknown service", async () => {
    signInAs("operator");
    mockPrisma.service.findUnique.mockResolvedValue(null);
    expect((await post(UPDATE, { serviceId: SVC })).status).toBe(404);
  });

  it("refuses a viewer", async () => {
    signInAs("viewer");
    mockPrisma.service.findUnique.mockResolvedValue({ id: SVC, endpointId: EP_A });
    expect((await post(UPDATE, { serviceId: SVC })).status).toBe(403);
    expect(performUpdate).not.toHaveBeenCalled();
  });

  it("lets a viewer with an operator grant on that endpoint update", async () => {
    signInAs("viewer", { bindings: [{ role: "operator", scopeType: "endpoint", scopeId: EP_A }] });
    mockPrisma.service.findUnique.mockResolvedValue({ id: SVC, endpointId: EP_A });
    const res = await post(UPDATE, { serviceId: SVC });
    expect(res.status).toBe(200);
    expect(performUpdate).toHaveBeenCalledWith(SVC, expect.objectContaining({ email: "viewer@test.local" }), "1.2.3.4");
  });

  it("does not extend an endpoint grant to other endpoints", async () => {
    signInAs("viewer", { bindings: [{ role: "operator", scopeType: "endpoint", scopeId: EP_A }] });
    mockPrisma.service.findUnique.mockResolvedValue({ id: SVC, endpointId: EP_B });
    expect((await post(UPDATE, { serviceId: SVC })).status).toBe(403);
  });

  it("returns 500 when the update fails", async () => {
    signInAs("operator");
    mockPrisma.service.findUnique.mockResolvedValue({ id: SVC, endpointId: EP_A });
    vi.mocked(performUpdate).mockRejectedValue(new Error("pull failed"));
    const res = await post(UPDATE, { serviceId: SVC });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("pull failed");
  });
});
