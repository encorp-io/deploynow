import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({ auditEvent: { findMany: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/polling", () => ({ syncServices: vi.fn(), checkForUpdates: vi.fn() }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { syncServices, checkForUpdates } from "@/lib/polling";
import { GET, POST } from "@/app/api/polling/route";

const post = (body: unknown) => POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

describe("/api/polling", () => {
  it("POST is admin only", async () => {
    signInAs("operator");
    expect((await post({ action: "check" })).status).toBe(403);
  });

  it("check syncs then checks for updates", async () => {
    signInAs("admin");
    expect((await post({ action: "check" })).status).toBe(200);
    expect(syncServices).toHaveBeenCalled();
    expect(checkForUpdates).toHaveBeenCalled();
  });

  it("init only syncs", async () => {
    signInAs("owner");
    expect((await post({ action: "init" })).status).toBe(200);
    expect(checkForUpdates).not.toHaveBeenCalled();
  });

  it("rejects an unknown action", async () => {
    signInAs("admin");
    expect((await post({ action: "x" })).status).toBe(400);
  });

  it("GET returns recent service events to any signed-in user", async () => {
    expect((await GET()).status).toBe(401);
    signInAs("viewer");
    mockPrisma.auditEvent.findMany.mockResolvedValue([{ id: "1" }]);
    expect(await (await GET()).json()).toEqual([{ id: "1" }]);
    expect(mockPrisma.auditEvent.findMany.mock.calls[0][0].where).toEqual({ action: { startsWith: "service." } });
  });
});
