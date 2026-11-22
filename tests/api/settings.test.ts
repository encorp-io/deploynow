import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({ settings: { findUnique: vi.fn(), upsert: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/secretsCrypto", () => ({
  encryptSecret: vi.fn((v: string) => `encrypted:${v}`),
  decryptSecret: vi.fn((v: string) => v.replace("encrypted:", "")),
}));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { audit } from "@/lib/audit";
import { GET, PUT } from "@/app/api/settings/route";

const put = (body: unknown) => PUT(new Request("http://x/api/settings", { method: "PUT", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

describe("GET /api/settings", () => {
  it("returns 401 when signed out", async () => {
    expect((await GET()).status).toBe(401);
  });

  it("masks the GitHub token", async () => {
    signInAs("viewer");
    mockPrisma.settings.findUnique.mockResolvedValue({ githubUser: "me", githubToken: "encrypted:ghp", pollingInterval: 120, autoUpdateLatest: true, require2faForAdmins: true });
    const data = await (await GET()).json();
    expect(data).toMatchObject({ githubUser: "me", githubToken: "••••••••", pollingInterval: 120, autoUpdateLatest: true, require2faForAdmins: true });
    expect(data.vault).toMatchObject({ addr: "", auth: "token", token: "" });
  });

  it("returns defaults when nothing is saved", async () => {
    signInAs("viewer");
    mockPrisma.settings.findUnique.mockResolvedValue(null);
    const data = await (await GET()).json();
    expect(data.pollingInterval).toBe(60);
    expect(data.githubToken).toBe("");
    expect(data.require2faForAdmins).toBe(true);
  });
});

describe("PUT /api/settings", () => {
  it("is admin only", async () => {
    signInAs("operator");
    expect((await put({ pollingInterval: 60 })).status).toBe(403);
  });

  it("saves, encrypts the token and audits", async () => {
    signInAs("admin");
    const res = await put({ githubUser: " me ", githubToken: "ghp_x", pollingInterval: 90, autoUpdateLatest: 1 });
    expect(res.status).toBe(200);
    const call = mockPrisma.settings.upsert.mock.calls[0][0];
    expect(call.update).toEqual({ githubUser: "me", githubToken: "encrypted:ghp_x", pollingInterval: 90, autoUpdateLatest: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "settings.update" }));
  });

  it("keeps the stored token when the mask is sent back", async () => {
    signInAs("admin");
    await put({ githubToken: "••••••••" });
    expect(mockPrisma.settings.upsert.mock.calls[0][0].update).not.toHaveProperty("githubToken");
  });

  it("rejects an out-of-range polling interval", async () => {
    signInAs("admin");
    expect((await put({ pollingInterval: 5 })).status).toBe(400);
    expect((await put({ pollingInterval: 1.5 })).status).toBe(400);
  });

  it("rejects an over-long token", async () => {
    signInAs("admin");
    expect((await put({ githubToken: "x".repeat(600) })).status).toBe(400);
  });

  it("lets only an owner turn off required 2FA", async () => {
    signInAs("admin");
    expect((await put({ require2faForAdmins: false })).status).toBe(403);
    expect((await put({ require2faForAdmins: true })).status).toBe(200);
    signInAs("owner");
    expect((await put({ require2faForAdmins: false })).status).toBe(200);
  });
});
