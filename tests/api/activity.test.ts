import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  auditEvent: { findMany: vi.fn(), count: vi.fn() },
  endpoint: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { GET } from "@/app/api/activity/route";

const get = (qs = "") => GET(new Request(`http://x/api/activity${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  mockPrisma.auditEvent.findMany.mockImplementation((args: { distinct?: string[] }) =>
    Promise.resolve(args.distinct ? [{ action: "auth.login" }, { action: "service.update" }] : [{ id: "e1" }]),
  );
  mockPrisma.auditEvent.count.mockResolvedValue(120);
  mockPrisma.endpoint.findMany.mockResolvedValue([{ id: "ep", name: "local" }]);
});

describe("GET /api/activity", () => {
  it("needs audit.view (operator and up)", async () => {
    expect((await get()).status).toBe(401);
    signInAs("viewer");
    expect((await get()).status).toBe(403);
  });

  it("returns a page with filters and endpoint names", async () => {
    signInAs("operator");
    const data = await (await get("?page=2&limit=50")).json();
    expect(data).toMatchObject({ total: 120, page: 2, limit: 50, totalPages: 3, actionTypes: ["auth.login", "service.update"], endpoints: [{ id: "ep", name: "local" }] });
    const args = mockPrisma.auditEvent.findMany.mock.calls[0][0];
    expect(args.skip).toBe(50);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("applies search, action, outcome and endpoint filters", async () => {
    signInAs("admin");
    await get("?search=deploy&action=service.update&outcome=failure&endpointId=ep&sort=asc");
    const args = mockPrisma.auditEvent.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ action: "service.update", outcome: "failure", endpointId: "ep" });
    expect(args.where.OR).toHaveLength(3);
    expect(args.orderBy).toEqual({ createdAt: "asc" });
  });

  it("ignores an unknown outcome and clamps the limit", async () => {
    signInAs("admin");
    const data = await (await get("?outcome=maybe&limit=999")).json();
    expect(data.limit).toBe(100);
    expect(mockPrisma.auditEvent.findMany.mock.calls[0][0].where).not.toHaveProperty("outcome");
  });
});
