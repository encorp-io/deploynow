import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  session: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));
const mockAuth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: mockAuth }));

import { createSession, hasRecentStepUp, loadActiveSession, revokeAllSessions, revokeSession, SESSION_TTL_MS, STEP_UP_TTL_MS } from "@/lib/sessions";
import { getCurrentUser, requireStepUp, requireUser } from "@/lib/apiAuth";

const future = () => new Date(Date.now() + 3600_000);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.session.update.mockResolvedValue({});
});

describe("sessions", () => {
  it("creates a session that expires after the TTL", async () => {
    mockPrisma.session.create.mockResolvedValue({ id: "s1" });
    expect(await createSession("u1", "1.2.3.4", "ua")).toBe("s1");
    const exp: Date = mockPrisma.session.create.mock.calls[0][0].data.expiresAt;
    expect(Math.abs(exp.getTime() - (Date.now() + SESSION_TTL_MS))).toBeLessThan(5000);
  });

  it("rejects revoked, expired or disabled sessions", async () => {
    expect(await loadActiveSession(undefined)).toBeNull();
    const base = { id: "s", revokedAt: null, expiresAt: future(), lastSeenAt: new Date(), user: { disabledAt: null } };
    for (const bad of [{ revokedAt: new Date() }, { expiresAt: new Date(Date.now() - 1) }, { user: { disabledAt: new Date() } }, { user: null }]) {
      mockPrisma.session.findUnique.mockResolvedValue({ ...base, ...bad });
      expect(await loadActiveSession("s")).toBeNull();
    }
    mockPrisma.session.findUnique.mockResolvedValue(base);
    expect(await loadActiveSession("s")).not.toBeNull();
    expect(mockPrisma.session.update).not.toHaveBeenCalled();
  });

  it("touches lastSeenAt at most once a minute", async () => {
    mockPrisma.session.findUnique.mockResolvedValue({ id: "s", revokedAt: null, expiresAt: future(), lastSeenAt: new Date(Date.now() - 120_000), user: { disabledAt: null } });
    await loadActiveSession("s");
    expect(mockPrisma.session.update).toHaveBeenCalledTimes(1);
  });

  it("revokes one session for its owner, or all but the current one", async () => {
    mockPrisma.session.updateMany.mockResolvedValue({ count: 1 });
    expect(await revokeSession("s", "u")).toBe(true);
    expect(mockPrisma.session.updateMany.mock.calls[0][0].where).toEqual({ id: "s", revokedAt: null, userId: "u" });
    await revokeAllSessions("u", "keep");
    expect(mockPrisma.session.updateMany.mock.calls[1][0].where).toEqual({ userId: "u", revokedAt: null, id: { not: "keep" } });
  });

  it("step-up lasts ten minutes", () => {
    const now = Date.now();
    expect(hasRecentStepUp(null)).toBe(false);
    expect(hasRecentStepUp(new Date(now - STEP_UP_TTL_MS + 1000), now)).toBe(true);
    expect(hasRecentStepUp(new Date(now - STEP_UP_TTL_MS - 1000), now)).toBe(false);
  });
});

describe("apiAuth", () => {
  const dbUser = { id: "u", email: "u@x", name: "U", role: "member", disabledAt: null, totpEnabledAt: new Date(), roleBindings: [{ role: "admin", scopeType: "endpoint", scopeId: "ep" }] };

  it("returns null without a session id", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u" } });
    expect(await getCurrentUser()).toBeNull();
  });

  it("re-checks the database on every request", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u", sid: "s" } });
    mockPrisma.user.findUnique.mockResolvedValue(dbUser);
    mockPrisma.session.findUnique.mockResolvedValue({ id: "s", revokedAt: null, stepUpAt: null });
    expect(await getCurrentUser()).toMatchObject({ role: "operator", totpEnabled: true, bindings: [{ role: "admin", scopeId: "ep" }] });

    mockPrisma.session.findUnique.mockResolvedValue({ id: "s", revokedAt: new Date() });
    expect(await getCurrentUser()).toBeNull();
    mockPrisma.session.findUnique.mockResolvedValue({ id: "s", revokedAt: null });
    mockPrisma.user.findUnique.mockResolvedValue({ ...dbUser, disabledAt: new Date() });
    expect(await getCurrentUser()).toBeNull();
  });

  it("gates on permission and endpoint scope", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u", sid: "s" } });
    mockPrisma.user.findUnique.mockResolvedValue(dbUser);
    mockPrisma.session.findUnique.mockResolvedValue({ id: "s", revokedAt: null, stepUpAt: null });
    expect((await requireUser("container.remove", { endpointId: "ep" })).ok).toBe(true);
    const denied = await requireUser("container.remove", { endpointId: "other" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.response.status).toBe(403);
    mockAuth.mockResolvedValue(null);
    const anon = await requireUser();
    if (!anon.ok) expect(anon.response.status).toBe(401);
  });

  it("asks users with 2FA for a fresh code before sensitive actions", () => {
    const user = { id: "u", email: "", name: "", role: "admin" as const, sid: "s", bindings: [], totpEnabled: true, stepUpAt: null };
    expect(requireStepUp(user)?.status).toBe(403);
    expect(requireStepUp({ ...user, stepUpAt: new Date() })).toBeNull();
    expect(requireStepUp({ ...user, totpEnabled: false })).toBeNull();
  });
});
