import { describe, it, expect, vi, beforeEach } from "vitest";

// We test normalizeArch by testing getRemoteDigest behavior since normalizeArch is private.
// But we can also test it indirectly. Let's mock fetch and prisma to test getRemoteDigest flow.

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    settings: {
      findUnique: vi.fn().mockResolvedValue({
        githubToken: "",
        githubUser: "",
      }),
    },
  },
}));

// Mock secretsCrypto
vi.mock("@/lib/secretsCrypto", () => ({
  decryptSecret: vi.fn((v: string) => v),
}));

describe("ghcr", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn());
  });

  describe("getRemoteDigest — Docker Hub", () => {
    it("fetches Docker Hub digest for non-ghcr registry", async () => {
      const mockFetch = vi.fn()
        // First call: auth token
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "test-token" }),
        })
        // Second call: manifest (single arch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            mediaType: "application/vnd.docker.distribution.manifest.v2+json",
            config: { digest: "sha256:abc123" },
          }),
          headers: new Map([["docker-content-digest", null]]),
        });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("docker.io", "library/redis", "7-alpine", "amd64");
      expect(digest).toBe("sha256:abc123");
    });

    it("returns null for Docker Hub 404", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "test-token" }),
        })
        .mockResolvedValueOnce({ ok: false, status: 404 });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("docker.io", "library/redis", "nonexistent", "amd64");
      expect(digest).toBeNull();
    });

    it("returns null when token fetch fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false }));

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("docker.io", "library/nginx", "latest", "amd64");
      expect(digest).toBeNull();
    });
  });

  describe("getRemoteDigest — GHCR", () => {
    it("resolves multi-arch manifest to correct platform config digest", async () => {
      const mockFetch = vi.fn()
        // Token exchange
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "ghcr-token" }),
        })
        // Manifest list
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            mediaType: "application/vnd.oci.image.index.v1+json",
            manifests: [
              { digest: "sha256:amd64-manifest", platform: { architecture: "amd64", os: "linux" } },
              { digest: "sha256:arm64-manifest", platform: { architecture: "arm64", os: "linux" } },
            ],
          }),
        })
        // Platform-specific manifest
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            config: { digest: "sha256:amd64-config-digest" },
          }),
        });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("ghcr.io", "org/repo", "latest", "amd64");
      expect(digest).toBe("sha256:amd64-config-digest");
    });

    it("selects arm64 platform when arch is arm64", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "ghcr-token" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            mediaType: "application/vnd.oci.image.index.v1+json",
            manifests: [
              { digest: "sha256:amd64-m", platform: { architecture: "amd64", os: "linux" } },
              { digest: "sha256:arm64-m", platform: { architecture: "arm64", os: "linux" } },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            config: { digest: "sha256:arm64-config" },
          }),
        });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("ghcr.io", "org/repo", "latest", "arm64");
      expect(digest).toBe("sha256:arm64-config");

      // Verify the arm64 manifest was fetched, not amd64
      const manifestCall = mockFetch.mock.calls[2];
      expect(manifestCall[0]).toContain("sha256:arm64-m");
    });

    it("handles single-platform manifest (no manifest list)", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "ghcr-token" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            mediaType: "application/vnd.docker.distribution.manifest.v2+json",
            config: { digest: "sha256:single-config" },
          }),
        });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("ghcr.io", "org/repo", "v1.0.0", "amd64");
      expect(digest).toBe("sha256:single-config");
      // Should NOT make a third fetch (no manifest list resolution)
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns null for GHCR 404", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "ghcr-token" }),
        })
        .mockResolvedValueOnce({ ok: false, status: 404 });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("ghcr.io", "org/repo", "missing", "amd64");
      expect(digest).toBeNull();
    });

    it("throws on non-404 GHCR error", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "ghcr-token" }),
        })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      await expect(
        getRemoteDigest("ghcr.io", "org/repo", "latest", "amd64")
      ).rejects.toThrow("GHCR manifest request failed (status 500)");
    });
  });

  describe("getRemoteDigest — arch normalization", () => {
    it("normalizes x64 to amd64", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "t" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            mediaType: "application/vnd.oci.image.index.v1+json",
            manifests: [
              { digest: "sha256:amd", platform: { architecture: "amd64", os: "linux" } },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ config: { digest: "sha256:cfg" } }),
        });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      // Pass x64 — should resolve to amd64 platform
      const digest = await getRemoteDigest("ghcr.io", "org/repo", "latest", "x64");
      expect(digest).toBe("sha256:cfg");
    });

    it("defaults to amd64 when arch is undefined", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: "t" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            mediaType: "application/vnd.oci.image.index.v1+json",
            manifests: [
              { digest: "sha256:amd", platform: { architecture: "amd64", os: "linux" } },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ config: { digest: "sha256:default-cfg" } }),
        });

      vi.stubGlobal("fetch", mockFetch);

      const { getRemoteDigest } = await import("@/lib/ghcr");
      const digest = await getRemoteDigest("ghcr.io", "org/repo", "latest");
      expect(digest).toBe("sha256:default-cfg");
    });
  });
});
