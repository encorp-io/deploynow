import { describe, it, expect } from "vitest";
import { parseImageRef, isFloatingTag } from "@/lib/imageRef";

describe("parseImageRef", () => {
  it("parses ghcr.io image with tag", () => {
    const result = parseImageRef("ghcr.io/encorp-io/my-app:latest");
    expect(result).toEqual({
      registry: "ghcr.io",
      repository: "encorp-io/my-app",
      tag: "latest",
      full: "ghcr.io/encorp-io/my-app:latest",
    });
  });

  it("parses ghcr.io image with semver tag", () => {
    const result = parseImageRef("ghcr.io/encorp-io/n8n:2.12.2");
    expect(result).toEqual({
      registry: "ghcr.io",
      repository: "encorp-io/n8n",
      tag: "2.12.2",
      full: "ghcr.io/encorp-io/n8n:2.12.2",
    });
  });

  it("defaults tag to latest when not specified", () => {
    const result = parseImageRef("ghcr.io/org/repo");
    expect(result.tag).toBe("latest");
    expect(result.full).toBe("ghcr.io/org/repo:latest");
  });

  it("parses Docker Hub official image", () => {
    const result = parseImageRef("redis:7-alpine");
    expect(result).toEqual({
      registry: "docker.io",
      repository: "redis",
      tag: "7-alpine",
      full: "docker.io/redis:7-alpine",
    });
  });

  it("parses Docker Hub namespaced image", () => {
    const result = parseImageRef("jc21/nginx-proxy-manager:latest");
    expect(result).toEqual({
      registry: "docker.io",
      repository: "jc21/nginx-proxy-manager",
      tag: "latest",
      full: "docker.io/jc21/nginx-proxy-manager:latest",
    });
  });

  it("parses docker.io explicit prefix", () => {
    const result = parseImageRef("docker.io/library/nginx:1.25");
    expect(result).toEqual({
      registry: "docker.io",
      repository: "library/nginx",
      tag: "1.25",
      full: "docker.io/library/nginx:1.25",
    });
  });

  it("parses custom registry", () => {
    const result = parseImageRef("registry.example.com:5000/team/app:v1");
    expect(result).toEqual({
      registry: "registry.example.com:5000",
      repository: "team/app",
      tag: "v1",
      full: "registry.example.com:5000/team/app:v1",
    });
  });

  it("handles bare image name", () => {
    const result = parseImageRef("nginx");
    expect(result).toEqual({
      registry: "docker.io",
      repository: "nginx",
      tag: "latest",
      full: "docker.io/nginx:latest",
    });
  });

  it("handles deeply nested repository", () => {
    const result = parseImageRef("ghcr.io/org/team/sub/app:main");
    expect(result).toEqual({
      registry: "ghcr.io",
      repository: "org/team/sub/app",
      tag: "main",
      full: "ghcr.io/org/team/sub/app:main",
    });
  });
});

describe("isFloatingTag", () => {
  it.each([
    "latest",
    "main",
    "master",
    "dev",
    "develop",
    "staging",
    "nightly",
    "edge",
  ])('returns true for "%s"', (tag) => {
    expect(isFloatingTag(tag)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isFloatingTag("Latest")).toBe(true);
    expect(isFloatingTag("MAIN")).toBe(true);
    expect(isFloatingTag("DEV")).toBe(true);
  });

  it.each([
    "1.0.0",
    "v2.12.2",
    "7-alpine",
    "sha-abc1234",
    "release-2024",
    "stable",
  ])('returns false for "%s"', (tag) => {
    expect(isFloatingTag(tag)).toBe(false);
  });
});
