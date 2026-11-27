import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const guardedGet = vi.fn();
vi.mock("@/lib/netGuard", async (orig) => ({ ...(await orig<typeof import("@/lib/netGuard")>()), guardedGet: (...a: unknown[]) => guardedGet(...a) }));

import { BlockedAddressError } from "@/lib/netGuard";
import { encryptSecret } from "@/lib/secretsCrypto";
import { testRegistry } from "@/lib/registryAuth";

const reg = (host: string) => ({ id: "r1", host, username: "bot", password: encryptSecret("tok") }) as unknown as Registry;
const res = (status: number, headers: Record<string, string> = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });
const challenge = (realm: string) => res(401, { "www-authenticate": `Bearer realm="${realm}",service="registry"` });

beforeEach(() => guardedGet.mockReset());

describe("testRegistry", () => {
  it("signs in through the token realm", async () => {
    guardedGet.mockResolvedValueOnce(challenge("https://auth.example.com/token")).mockResolvedValueOnce(res(200));
    expect(await testRegistry(reg("registry.example.com"))).toEqual({ ok: true, message: "Signed in" });
    expect(String(guardedGet.mock.calls[1][0])).toBe("https://auth.example.com/token?service=registry");
    expect(guardedGet.mock.calls[0][1]).toMatchObject({ allowPrivate: false });
  });

  it("won't follow a realm that isn't https", async () => {
    guardedGet.mockResolvedValueOnce(challenge("http://169.254.169.254/latest/meta-data/"));
    const r = await testRegistry(reg("evil.example.com"));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/must use https/);
    expect(guardedGet).toHaveBeenCalledTimes(1);
  });

  it("explains a refused internal address without details", async () => {
    guardedGet.mockRejectedValueOnce(new BlockedAddressError("10.0.0.5 isn't an allowed address"));
    const r = await testRegistry(reg("internal.example.com"));
    expect(r).toEqual({ ok: false, message: "Registries on private or internal addresses can only be tested by an admin" });
  });

  it("passes allowPrivate for admins", async () => {
    guardedGet.mockResolvedValueOnce(res(200));
    await testRegistry(reg("192.168.1.5:5000"), { allowPrivate: true });
    expect(guardedGet.mock.calls[0][1]).toMatchObject({ allowPrivate: true });
  });

  it("keeps network errors and odd statuses generic", async () => {
    guardedGet.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED 203.0.113.7:443"), { code: "ECONNREFUSED" }));
    expect((await testRegistry(reg("registry.example.com"))).message).toBe("Could not reach the registry");
    guardedGet.mockResolvedValueOnce(res(404));
    expect((await testRegistry(reg("example.com"))).message).toMatch(/doesn't look like a container registry/);
    guardedGet.mockResolvedValueOnce(challenge("https://auth.example.com/token")).mockResolvedValueOnce(res(500));
    expect((await testRegistry(reg("registry.example.com"))).message).toBe("The registry's token service didn't accept the request");
  });

  it("reports refused credentials", async () => {
    guardedGet.mockResolvedValueOnce(challenge("https://auth.example.com/token")).mockResolvedValueOnce(res(401));
    expect(await testRegistry(reg("registry.example.com"))).toEqual({ ok: false, message: "The registry refused the credentials" });
  });
});
