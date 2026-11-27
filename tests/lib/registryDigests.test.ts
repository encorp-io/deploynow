import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const guardedGet = vi.fn();
vi.mock("@/lib/netGuard", async (orig) => ({ ...(await orig<typeof import("@/lib/netGuard")>()), guardedGet: (...a: unknown[]) => guardedGet(...a) }));

import { registryDigests } from "@/lib/registryDigests";

const res = (status: number, headers: Record<string, string> = {}, body: unknown = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  text: async () => JSON.stringify(body),
  json: async () => body,
});
const manifest = res(200, { "docker-content-digest": "sha256:m" }, { config: { digest: "sha256:c" } });

beforeEach(() => guardedGet.mockReset());

describe("registryDigests through netGuard", () => {
  it("refuses metadata for everyone but allows private registries", async () => {
    guardedGet.mockResolvedValueOnce(manifest);
    expect(await registryDigests("registry.lan:5000/team/app:1")).toEqual({ config: "sha256:c", manifest: "sha256:m" });
    expect(guardedGet.mock.calls[0][1]).toMatchObject({ allowPrivate: true, maxBodyBytes: expect.any(Number) });
  });

  it("follows a redirect by hand and drops credentials on another host", async () => {
    guardedGet
      .mockResolvedValueOnce(res(401, { "www-authenticate": 'Bearer realm="https://auth.example.com/token",service="r"' }))
      .mockResolvedValueOnce(res(200, {}, { token: "t" }))
      .mockResolvedValueOnce(res(307, { location: "https://cdn.example.net/m" }))
      .mockResolvedValueOnce(manifest);
    expect(await registryDigests("quay.example.com/a/b:1", { auth: { username: "u", password: "p" } })).toEqual({ config: "sha256:c", manifest: "sha256:m" });
    const [url, opts] = guardedGet.mock.calls[3];
    expect(String(url)).toBe("https://cdn.example.net/m");
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it("won't follow a redirect to plain http", async () => {
    guardedGet.mockResolvedValueOnce(res(302, { location: "http://169.254.169.254/" }));
    await expect(registryDigests("quay.example.com/a/b:1")).rejects.toThrow(/non-https/);
    expect(guardedGet).toHaveBeenCalledTimes(1);
  });

  it("stops after a few redirects", async () => {
    guardedGet.mockResolvedValue(res(302, { location: "https://quay.example.com/loop" }));
    await expect(registryDigests("quay.example.com/a/b:1")).rejects.toThrow(/Too many redirects/);
  });
});
