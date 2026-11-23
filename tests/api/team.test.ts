import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  user: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn(), delete: vi.fn(), create: vi.fn() },
  teamInvite: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
  endpoint: { findMany: vi.fn(), findUnique: vi.fn() },
  roleBinding: { upsert: vi.fn(), deleteMany: vi.fn() },
  recoveryCode: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/sessions", () => ({ revokeAllSessions: vi.fn() }));
vi.mock("@/lib/password", async (orig) => ({
  ...(await orig<typeof import("@/lib/password")>()),
  hashPassword: vi.fn(async () => "scrypt$hash"),
}));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { revokeAllSessions } from "@/lib/sessions";
import { audit } from "@/lib/audit";
import { GET, POST, PUT } from "@/app/api/team/route";

const TARGET = "c" + "t".repeat(24);
const EP = "c" + "e".repeat(24);
const req = (method: string, body: unknown) => new Request("http://x/api/team", { method, body: JSON.stringify(body) });
const post = (body: unknown) => POST(req("POST", body));
const target = (role: string, extra = {}) => mockPrisma.user.findUnique.mockResolvedValue({ id: TARGET, email: "t@x.io", role, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  mockPrisma.$transaction.mockResolvedValue([]);
});

describe("GET /api/team", () => {
  it("returns users with normalised roles and a 2FA flag", async () => {
    signInAs("viewer");
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u1", role: "member", totpEnabledAt: new Date(), roleBindings: [] }]);
    mockPrisma.teamInvite.findMany.mockResolvedValue([]);
    mockPrisma.endpoint.findMany.mockResolvedValue([]);
    const data = await (await GET()).json();
    expect(data.users[0]).toMatchObject({ role: "operator", totpEnabled: true });
    expect(data.users[0]).not.toHaveProperty("totpEnabledAt");
    expect(data.me.role).toBe("viewer");
  });
});

describe("POST /api/team", () => {
  it("is admin only", async () => {
    signInAs("operator");
    expect((await post({ action: "invite", email: "a@b.co", role: "viewer" })).status).toBe(403);
  });

  it("creates an invite", async () => {
    signInAs("admin");
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await post({ action: "invite", email: " New@B.co ", role: "operator" });
    expect(res.status).toBe(200);
    expect((await res.json()).token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockPrisma.teamInvite.create.mock.calls[0][0].data).toMatchObject({ email: "new@b.co", role: "operator" });
  });

  it("does not let an admin invite an owner", async () => {
    signInAs("admin");
    expect((await post({ action: "invite", email: "a@b.co", role: "owner" })).status).toBe(400);
  });

  it("rejects a bad email and an existing account", async () => {
    signInAs("admin");
    expect((await post({ action: "invite", email: "nope", role: "viewer" })).status).toBe(400);
    mockPrisma.user.findUnique.mockResolvedValue({ id: "x" });
    expect((await post({ action: "invite", email: "a@b.co", role: "viewer" })).status).toBe(409);
  });

  it("refuses to act on yourself or a bad id", async () => {
    const me = signInAs("admin");
    expect((await post({ action: "disable", userId: "bad" })).status).toBe(400);
    expect((await post({ action: "disable", userId: me.id })).status).toBe(400);
  });

  it("changes a role", async () => {
    signInAs("admin");
    target("viewer");
    expect((await post({ action: "updateRole", userId: TARGET, role: "operator" })).status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: TARGET }, data: { role: "operator" } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.role_change" }));
  });

  it("keeps admins away from owners", async () => {
    signInAs("admin");
    target("owner");
    expect((await post({ action: "updateRole", userId: TARGET, role: "viewer" })).status).toBe(403);
  });

  it("keeps admins away from other admins", async () => {
    signInAs("admin");
    target("admin");
    expect((await post({ action: "disable", userId: TARGET })).status).toBe(403);
    expect((await post({ action: "updateRole", userId: TARGET, role: "viewer" })).status).toBe(403);
    signInAs("owner");
    expect((await post({ action: "disable", userId: TARGET })).status).toBe(200);
  });

  it("keeps at least one owner", async () => {
    signInAs("owner");
    target("owner");
    mockPrisma.user.count.mockResolvedValue(1);
    expect((await post({ action: "updateRole", userId: TARGET, role: "admin" })).status).toBe(400);
    expect((await post({ action: "disable", userId: TARGET })).status).toBe(400);
    expect((await post({ action: "remove", userId: TARGET })).status).toBe(400);
    mockPrisma.user.count.mockResolvedValue(2);
    expect((await post({ action: "updateRole", userId: TARGET, role: "admin" })).status).toBe(200);
  });

  it("disabling signs the person out everywhere", async () => {
    signInAs("admin");
    target("operator");
    expect((await post({ action: "disable", userId: TARGET })).status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith(TARGET);
    vi.mocked(revokeAllSessions).mockClear();
    expect((await post({ action: "enable", userId: TARGET })).status).toBe(200);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it("removes a person", async () => {
    signInAs("admin");
    target("viewer");
    expect((await post({ action: "remove", userId: TARGET })).status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it("resetting 2FA needs a recent code from an admin with 2FA", async () => {
    signInAs("admin", { totpEnabled: true, stepUpAt: null });
    target("operator");
    const res = await post({ action: "reset2fa", userId: TARGET });
    expect(res.status).toBe(403);
    expect((await res.json()).stepUpRequired).toBe(true);

    signInAs("admin", { totpEnabled: true, stepUpAt: new Date() });
    expect((await post({ action: "reset2fa", userId: TARGET })).status).toBe(200);
    expect(revokeAllSessions).toHaveBeenCalledWith(TARGET);
  });

  it("grants a role on one endpoint", async () => {
    signInAs("admin");
    target("viewer");
    mockPrisma.endpoint.findUnique.mockResolvedValue({ id: EP });
    expect((await post({ action: "grant", userId: TARGET, endpointId: EP, role: "owner" })).status).toBe(400);
    expect((await post({ action: "grant", userId: TARGET, endpointId: EP, role: "operator" })).status).toBe(200);
    expect(mockPrisma.roleBinding.upsert.mock.calls[0][0].create).toEqual({ userId: TARGET, scopeType: "endpoint", scopeId: EP, role: "operator" });
    mockPrisma.endpoint.findUnique.mockResolvedValue(null);
    expect((await post({ action: "grant", userId: TARGET, endpointId: EP, role: "operator" })).status).toBe(404);
  });

  it("revokes a grant only for that person", async () => {
    signInAs("admin");
    target("viewer");
    mockPrisma.roleBinding.deleteMany.mockResolvedValue({ count: 1 });
    const data = await (await post({ action: "revokeGrant", userId: TARGET, bindingId: "b1" })).json();
    expect(data.success).toBe(true);
    expect(mockPrisma.roleBinding.deleteMany).toHaveBeenCalledWith({ where: { id: "b1", userId: TARGET } });
  });

  it("rejects an unknown action", async () => {
    signInAs("admin");
    target("viewer");
    expect((await post({ action: "explode", userId: TARGET })).status).toBe(400);
  });
});

describe("PUT /api/team (accept invite)", () => {
  const token = "a".repeat(64);
  const body = { token, name: "New Person", password: "a-long-password-123" };

  it("validates the token, name and password", async () => {
    expect((await PUT(req("PUT", { ...body, token: "x" }))).status).toBe(400);
    expect((await PUT(req("PUT", { ...body, name: "x" }))).status).toBe(400);
    expect((await PUT(req("PUT", { ...body, password: "short" }))).status).toBe(400);
  });

  it("rejects expired or used invites", async () => {
    mockPrisma.teamInvite.findUnique.mockResolvedValue({ id: "i", used: false, expiresAt: new Date(0), email: "n@x.io" });
    expect((await PUT(req("PUT", body))).status).toBe(400);
    mockPrisma.teamInvite.findUnique.mockResolvedValue({ id: "i", used: true, expiresAt: new Date(Date.now() + 1e6), email: "n@x.io" });
    expect((await PUT(req("PUT", body))).status).toBe(400);
  });

  it("creates the account once", async () => {
    mockPrisma.teamInvite.findUnique.mockResolvedValue({ id: "i", used: false, expiresAt: new Date(Date.now() + 1e6), email: "n@x.io", role: "member" });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.teamInvite.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    mockPrisma.user.create.mockImplementation(async ({ data }: { data: Record<string, string> }) => ({ id: "new", ...data }));

    expect((await PUT(req("PUT", body))).status).toBe(200);
    expect(mockPrisma.user.create.mock.calls[0][0].data).toMatchObject({ email: "n@x.io", password: "scrypt$hash", role: "operator" });
    // A second use of the same token loses the claim race
    expect((await PUT(req("PUT", body))).status).toBe(400);
    expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
  });
});
