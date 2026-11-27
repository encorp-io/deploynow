import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
  recoveryCode: { count: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  session: { findMany: vi.fn() },
  settings: { findUnique: vi.fn() },
  passkey: { count: vi.fn(async () => 0) },
  $transaction: vi.fn(async () => []),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/secretsCrypto", () => ({ encryptSecret: (v: string) => `enc:${v}`, decryptSecret: (v: string) => v.replace(/^enc:/, "") }));
vi.mock("@/lib/sessions", async (orig) => ({
  ...(await orig<typeof import("@/lib/sessions")>()),
  markStepUp: vi.fn(),
  revokeAllSessions: vi.fn(async () => 2),
  revokeSession: vi.fn(async () => true),
}));
vi.mock("@/lib/twoFactor", async (orig) => ({ ...(await orig<typeof import("@/lib/twoFactor")>()), verifySecondFactor: vi.fn() }));
vi.mock("@/lib/rateLimit", () => ({ isRateLimited: vi.fn(async () => false), recordFailure: vi.fn(), recordSuccess: vi.fn() }));
vi.mock("@/lib/password", async (orig) => ({
  ...(await orig<typeof import("@/lib/password")>()),
  hashPassword: vi.fn(async () => "scrypt$new"),
  verifyPassword: vi.fn(async (p: string) => p === "the-right-password"),
}));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { markStepUp, revokeAllSessions, revokeSession } from "@/lib/sessions";
import { verifySecondFactor } from "@/lib/twoFactor";
import { isRateLimited, recordFailure } from "@/lib/rateLimit";
import { currentStep, totpAt } from "@/lib/totp";
import { GET as ACCOUNT, PATCH as RENAME } from "@/app/api/account/route";
import { POST as TWOFA } from "@/app/api/account/2fa/route";
import { POST as STEPUP } from "@/app/api/account/step-up/route";
import { POST as PASSWORD } from "@/app/api/account/password/route";
import { GET as SESSIONS, DELETE as REVOKE } from "@/app/api/account/sessions/route";
import { POST as RECOVERY } from "@/app/api/account/recovery-codes/route";

const json = (method: string, body: unknown, url = "http://x") => new Request(url, { method, body: JSON.stringify(body) });
const row = (extra = {}) => mockPrisma.user.findUnique.mockResolvedValue({ id: "cuser0000000000000000000001", password: "hash", totpEnabledAt: null, totpPending: "", totpSecret: "", totpLastStep: 0, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

describe("account", () => {
  it("everything needs a session", async () => {
    expect((await ACCOUNT()).status).toBe(401);
    expect((await TWOFA(json("POST", { action: "setup" }))).status).toBe(401);
    expect((await STEPUP(json("POST", {}))).status).toBe(401);
    expect((await SESSIONS()).status).toBe(401);
  });

  it("reports when an admin must set up 2FA", async () => {
    signInAs("admin");
    mockPrisma.recoveryCode.count.mockResolvedValue(0);
    // Optional by default
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    expect(await (await ACCOUNT()).json()).toMatchObject({ mfaSetupRequired: false, twoFactorRequiredForRole: false });
    // Required once an owner turns it on
    mockPrisma.settings.findUnique.mockResolvedValue({ require2faForAdmins: true });
    expect(await (await ACCOUNT()).json()).toMatchObject({ mfaSetupRequired: true, twoFactorRequiredForRole: true });
    signInAs("operator");
    expect((await (await ACCOUNT()).json()).mfaSetupRequired).toBe(false);
  });

  it("validates the display name", async () => {
    signInAs("viewer");
    expect((await RENAME(json("PATCH", { name: "x" }))).status).toBe(400);
    expect((await RENAME(json("PATCH", { name: "Ada Lovelace" }))).status).toBe(200);
  });
});

describe("2FA setup", () => {
  it("issues a pending secret, then enables it with a valid code", async () => {
    signInAs("admin");
    row();
    const setup = await (await TWOFA(json("POST", { action: "setup" }))).json();
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    expect(mockPrisma.user.update.mock.calls[0][0].data.totpPending).toBe(`enc:${setup.secret}`);

    row({ totpPending: `enc:${setup.secret}` });
    expect((await TWOFA(json("POST", { action: "enable", code: "000000" === totpAt(setup.secret, currentStep()) ? "111111" : "000000" }))).status).toBe(400);
    const res = await TWOFA(json("POST", { action: "enable", code: totpAt(setup.secret, currentStep()) }));
    expect(res.status).toBe(200);
    expect((await res.json()).recoveryCodes).toHaveLength(10);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
    expect(markStepUp).toHaveBeenCalled();
  });

  it("won't set up twice", async () => {
    signInAs("admin");
    row({ totpEnabledAt: new Date() });
    expect((await TWOFA(json("POST", { action: "setup" }))).status).toBe(409);
  });

  it("disabling needs the password and a code, and is blocked for required roles", async () => {
    row({ totpEnabledAt: new Date() });
    mockPrisma.settings.findUnique.mockResolvedValue({ require2faForAdmins: true });
    signInAs("admin");
    expect((await TWOFA(json("POST", { action: "disable", password: "the-right-password", code: "1" }))).status).toBe(403);

    signInAs("operator");
    expect((await TWOFA(json("POST", { action: "disable", password: "wrong", code: "1" }))).status).toBe(400);
    vi.mocked(verifySecondFactor).mockResolvedValue({ ok: false });
    expect((await TWOFA(json("POST", { action: "disable", password: "the-right-password", code: "1" }))).status).toBe(400);
    vi.mocked(verifySecondFactor).mockResolvedValue({ ok: true, method: "totp" });
    expect((await TWOFA(json("POST", { action: "disable", password: "the-right-password", code: "1" }))).status).toBe(200);
  });
});

describe("step-up", () => {
  it("is rate limited and records failures", async () => {
    signInAs("admin");
    vi.mocked(isRateLimited).mockResolvedValueOnce(true);
    expect((await STEPUP(json("POST", { code: "1" }))).status).toBe(429);

    row({ totpEnabledAt: new Date() });
    vi.mocked(verifySecondFactor).mockResolvedValue({ ok: false });
    expect((await STEPUP(json("POST", { code: "1" }))).status).toBe(400);
    expect(recordFailure).toHaveBeenCalledWith("stepup:cuser0000000000000000000001");

    vi.mocked(verifySecondFactor).mockResolvedValue({ ok: true, method: "totp" });
    expect((await STEPUP(json("POST", { code: "1" }))).status).toBe(200);
    expect(markStepUp).toHaveBeenCalledWith("csess0000000000000000000001");
  });
});

describe("password and sessions", () => {
  it("changes the password and signs out other sessions", async () => {
    signInAs("viewer");
    row();
    expect((await PASSWORD(json("POST", { currentPassword: "the-right-password", newPassword: "short" }))).status).toBe(400);
    expect((await PASSWORD(json("POST", { currentPassword: "wrong", newPassword: "a-new-long-password" }))).status).toBe(400);
    const res = await PASSWORD(json("POST", { currentPassword: "the-right-password", newPassword: "a-new-long-password" }));
    expect(await res.json()).toEqual({ success: true, revokedSessions: 2 });
    expect(revokeAllSessions).toHaveBeenCalledWith("cuser0000000000000000000001", "csess0000000000000000000001");
  });

  it("lists sessions and marks the current one", async () => {
    signInAs("viewer");
    mockPrisma.session.findMany.mockResolvedValue([{ id: "csess0000000000000000000001" }, { id: "other" }]);
    expect((await (await SESSIONS()).json()).map((s: { current: boolean }) => s.current)).toEqual([true, false]);
  });

  it("revokes only your own sessions", async () => {
    signInAs("viewer");
    expect((await REVOKE(new Request("http://x?id=bad", { method: "DELETE" }))).status).toBe(400);
    const id = "c" + "q".repeat(24);
    await REVOKE(new Request(`http://x?id=${id}`, { method: "DELETE" }));
    expect(revokeSession).toHaveBeenCalledWith(id, "cuser0000000000000000000001");
    expect(await (await REVOKE(new Request("http://x?others=1", { method: "DELETE" }))).json()).toEqual({ revoked: 2 });
  });

  it("regenerates recovery codes only with an app code", async () => {
    signInAs("viewer");
    row({ totpEnabledAt: new Date() });
    vi.mocked(verifySecondFactor).mockResolvedValue({ ok: true, method: "recovery" });
    expect((await RECOVERY(json("POST", { code: "x" }))).status).toBe(400);
    vi.mocked(verifySecondFactor).mockResolvedValue({ ok: true, method: "totp" });
    expect((await (await RECOVERY(json("POST", { code: "x" }))).json()).recoveryCodes).toHaveLength(10);
  });
});
