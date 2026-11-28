import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { settings: { findUnique: async () => null } } }));
const guardedGet = vi.fn();
vi.mock("@/lib/netGuard", async (orig) => ({ ...(await orig<typeof import("@/lib/netGuard")>()), guardedGet: (...a: unknown[]) => guardedGet(...a) }));

import { registryDigests, registryTags, remoteImageInfo } from "@/lib/registryDigests";

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

describe("registryTags", () => {
  it("follows the Link header and uses library/ for Docker Hub official images", async () => {
    guardedGet
      .mockResolvedValueOnce(res(200, { link: '</v2/library/postgres/tags/list?n=1000&last=17>; rel="next"' }, { tags: ["16", "17"] }))
      .mockResolvedValueOnce(res(200, {}, { tags: ["18"] }));
    expect(await registryTags("postgres:17-alpine")).toEqual(["16", "17", "18"]);
    expect(String(guardedGet.mock.calls[0][0])).toBe("https://registry-1.docker.io/v2/library/postgres/tags/list?n=1000");
    expect(String(guardedGet.mock.calls[1][0])).toBe("https://registry-1.docker.io/v2/library/postgres/tags/list?n=1000&last=17");
  });

  it("doesn't follow a Link to another repository", async () => {
    guardedGet.mockResolvedValueOnce(res(200, { link: '</v2/other/repo/tags/list?last=x>; rel="next"' }, { tags: ["1"] }));
    expect(await registryTags("quay.example.com/a/b:1")).toEqual(["1"]);
    expect(guardedGet).toHaveBeenCalledTimes(1);
  });
});

describe("remoteImageInfo", () => {
  it("reads the build date and source commit from the image config", async () => {
    guardedGet
      .mockResolvedValueOnce(manifest)
      .mockResolvedValueOnce(res(200, {}, { created: "2026-11-27T20:00:00Z", config: { Labels: { "org.opencontainers.image.revision": "abc1234def" } } }));
    expect(await remoteImageInfo("quay.example.com/a/b:main")).toEqual({ config: "sha256:c", manifest: "sha256:m", created: "2026-11-27T20:00:00Z", revision: "abc1234def" });
    expect(String(guardedGet.mock.calls[1][0])).toBe("https://quay.example.com/v2/a/b/blobs/sha256:c");
  });
});
