import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  settings: { findUnique: vi.fn(), upsert: vi.fn() },
  domain: { findFirst: vi.fn() },
  passkey: { count: vi.fn() },
}));
const lib = vi.hoisted(() => ({
  resolveDomain: vi.fn(),
  findLocalTarget: vi.fn(),
  ensurePlatformRoute: vi.fn(),
  probeDomain: vi.fn(),
  passkeysOffDomain: vi.fn(),
  saveActiveDomain: vi.fn(),
  platformRouteStatus: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/platformDomain", async (orig) => ({ ...(await orig<typeof import("@/lib/platformDomain")>()), ...lib }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { audit } from "@/lib/audit";
import { DELETE, GET, POST } from "@/app/api/settings/domain/route";

const post = (body: unknown) => POST(new Request("https://10.0.0.5:9444/api/settings/domain", { method: "POST", body: JSON.stringify(body) }));
const good = { reachable: true, certificateValid: true, message: "ok" };

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  mockPrisma.settings.findUnique.mockResolvedValue({ platformDomain: "" });
  mockPrisma.domain.findFirst.mockResolvedValue(null);
  lib.resolveDomain.mockResolvedValue(["203.0.113.7"]);
  lib.findLocalTarget.mockResolvedValue({});
  lib.ensurePlatformRoute.mockResolvedValue({ endpointName: "local", network: "deploynow" });
  lib.probeDomain.mockResolvedValue(good);
  lib.passkeysOffDomain.mockResolvedValue(0);
  lib.platformRouteStatus.mockResolvedValue({ present: false, running: false, domains: [], endpointName: "local", proxyMode: "managed", error: "" });
  mockPrisma.passkey.count.mockResolvedValue(0);
});

describe("/api/settings/domain", () => {
  it("is admin only", async () => {
    signInAs("operator");
    expect((await post({ action: "check", domain: "deploy.example.com" })).status).toBe(403);
    expect((await GET(new Request("https://x/api/settings/domain"))).status).toBe(403);
  });

  it("shows the current state", async () => {
    signInAs("admin");
    const data = await (await GET(new Request("https://10.0.0.5:9444/api/settings/domain"))).json();
    expect(data).toMatchObject({ domain: "", envOrigin: "https://localhost:9444", currentOrigin: "https://10.0.0.5:9444", fallbackPort: 9444 });
  });

  it("checks without switching", async () => {
    signInAs("admin");
    const res = await post({ action: "check", domain: "Deploy.Example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ domain: "deploy.example.com", addresses: ["203.0.113.7"], reachable: true });
    expect(lib.ensurePlatformRoute).toHaveBeenCalledWith(["", "deploy.example.com"], {});
    expect(lib.saveActiveDomain).not.toHaveBeenCalled();
  });

  it("stops at DNS and leaves the route alone", async () => {
    signInAs("admin");
    const { DomainError } = await import("@/lib/platformDomain");
    lib.resolveDomain.mockRejectedValue(new DomainError("deploy.example.com has no DNS record yet."));
    const res = await post({ action: "activate", domain: "deploy.example.com" });
    expect(res.status).toBe(422);
    expect((await res.json()).stage).toBe("dns");
    expect(lib.ensurePlatformRoute).not.toHaveBeenCalled();
    expect(lib.saveActiveDomain).not.toHaveBeenCalled();
  });

  it("puts the old route back when routing fails", async () => {
    signInAs("admin");
    mockPrisma.settings.findUnique.mockResolvedValue({ platformDomain: "old.example.com" });
    lib.ensurePlatformRoute.mockRejectedValueOnce(new Error("Set up the edge proxy first"));
    const res = await post({ action: "check", domain: "new.example.com" });
    expect(res.status).toBe(422);
    expect(lib.ensurePlatformRoute).toHaveBeenLastCalledWith(["old.example.com"]);
  });

  it("won't switch to a domain that didn't answer, unless forced", async () => {
    signInAs("admin");
    lib.probeDomain.mockResolvedValue({ reachable: false, certificateValid: false, message: "didn't answer" });
    const res = await post({ action: "activate", domain: "deploy.example.com" });
    expect(res.status).toBe(422);
    expect((await res.json()).canForce).toBe(true);
    expect(lib.saveActiveDomain).not.toHaveBeenCalled();
    expect((await post({ action: "activate", domain: "deploy.example.com", force: true })).status).toBe(200);
    expect(lib.saveActiveDomain).toHaveBeenCalledWith("deploy.example.com");
  });

  it("asks before leaving passkeys behind", async () => {
    signInAs("admin");
    lib.passkeysOffDomain.mockResolvedValue(2);
    const res = await post({ action: "activate", domain: "deploy.example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ needsConfirm: true, passkeysOffDomain: 2 });
    expect(lib.saveActiveDomain).not.toHaveBeenCalled();
    const ok = await post({ action: "activate", domain: "deploy.example.com", confirmPasskeys: true });
    expect(await ok.json()).toMatchObject({ activated: true, url: "https://deploy.example.com" });
    expect(lib.ensurePlatformRoute).toHaveBeenLastCalledWith(["deploy.example.com"]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "settings.domain" }));
  });

  it("refuses a domain an app already uses, and bad input", async () => {
    signInAs("admin");
    mockPrisma.domain.findFirst.mockResolvedValue({ id: "d1" });
    expect((await post({ action: "check", domain: "app.example.com" })).status).toBe(409);
    expect((await post({ action: "check", domain: "1.2.3.4" })).status).toBe(400);
  });

  it("removes the domain", async () => {
    signInAs("admin");
    mockPrisma.settings.findUnique.mockResolvedValue({ platformDomain: "deploy.example.com" });
    const res = await DELETE(new Request("https://x/api/settings/domain", { method: "DELETE" }));
    expect(await res.json()).toMatchObject({ success: true, warning: "" });
    expect(lib.saveActiveDomain).toHaveBeenCalledWith("");
    expect(lib.ensurePlatformRoute).toHaveBeenCalledWith([]);
  });
});
