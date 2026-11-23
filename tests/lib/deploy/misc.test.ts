import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { verifySignature } from "@/lib/deploy/webhook";
import { gitEnv, validateRepoPath, validateRepoUrl, BRANCH_RE } from "@/lib/deploy/git";
import { buildCreateOptions, containerName, volumeName } from "@/lib/deploy/container";

describe("verifySignature", () => {
  const body = Buffer.from('{"ref":"refs/heads/main"}');
  const sig = "sha256=" + crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
  it("accepts GitHub's signature", () => expect(verifySignature("s3cret", body, sig)).toBe(true));
  it("rejects everything else", () => {
    expect(verifySignature("other", body, sig)).toBe(false);
    expect(verifySignature("s3cret", body, null)).toBe(false);
    expect(verifySignature("", body, sig)).toBe(false);
    expect(verifySignature("s3cret", body, "sha256=00")).toBe(false);
    expect(verifySignature("s3cret", body, "sha1=" + sig.slice(7))).toBe(false);
  });
});

describe("git helpers", () => {
  it("validates repository URLs", () => {
    expect(validateRepoUrl(" https://github.com/org/app/?x=1#y ")).toBe("https://github.com/org/app");
    expect(() => validateRepoUrl("git@github.com:org/app")).toThrow();
    expect(() => validateRepoUrl("http://github.com/org/app")).toThrow(/https/);
    expect(() => validateRepoUrl("https://me:pw@github.com/org/app")).toThrow(/credentials/);
    expect(() => validateRepoUrl("https://github.com/org/a%20b")).toThrow(/path/);
  });
  it("keeps paths inside the repository", () => {
    expect(validateRepoPath("", ".")).toBe(".");
    expect(validateRepoPath("./docker/", ".")).toBe("docker");
    expect(() => validateRepoPath("/etc", ".")).toThrow();
    expect(() => validateRepoPath("a/../../b", ".")).toThrow();
  });
  it("puts the token in git's env, not the URL", () => {
    expect(gitEnv("https://github.com/o/r").GIT_CONFIG_COUNT).toBe("0");
    const env = gitEnv("https://github.com/o/r", "ghp_x");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.split(" ").pop()!, "base64").toString()).toBe("x-access-token:ghp_x");
  });
  it("sends the GitHub token only to GitHub", () => {
    expect(gitEnv("https://evil.example.com/o/r", "ghp_x").GIT_CONFIG_COUNT).toBe("0");
    expect(gitEnv("https://github.com.evil.example/o/r", "ghp_x").GIT_CONFIG_COUNT).toBe("0");
    process.env.GITHUB_HOSTS = "git.corp.example";
    try {
      expect(gitEnv("https://git.corp.example/o/r", "ghp_x").GIT_CONFIG_COUNT).toBe("1");
    } finally {
      delete process.env.GITHUB_HOSTS;
    }
  });
  it("checks branch names", () => {
    expect(BRANCH_RE.test("feature/x-1")).toBe(true);
    expect(BRANCH_RE.test("-x")).toBe(false);
    expect(BRANCH_RE.test("a..b")).toBe(false);
  });
});

describe("buildCreateOptions", () => {
  it("maps ports, volumes, restart policy and network", () => {
    const o = buildCreateOptions({
      appId: "a1", slug: "web", deploymentId: "dep_123456789", image: "nginx", env: ["A=1"], labels: { x: "y" }, cmd: ["nginx"],
      ports: [{ container: 80, host: 8080, protocol: "tcp" }, { container: 81, host: null, protocol: "udp" }],
      volumes: [{ name: "data", path: "/data" }], restartPolicy: "on-failure", appNetwork: "dn-p-e", proxyNetwork: null,
    });
    expect(o.name).toBe(containerName("web", "dep_123456789"));
    expect(o.Labels).toMatchObject({ x: "y", "deploynow.app": "a1", "deploynow.deployment": "dep_123456789" });
    expect(o.ExposedPorts).toEqual({ "80/tcp": {}, "81/udp": {} });
    expect(o.HostConfig?.PortBindings).toEqual({ "80/tcp": [{ HostPort: "8080" }] });
    expect(o.HostConfig?.Mounts).toEqual([{ Type: "volume", Source: volumeName("web", "data"), Target: "/data" }]);
    expect(o.HostConfig?.RestartPolicy).toEqual({ Name: "on-failure", MaximumRetryCount: 5 });
    expect(o.NetworkingConfig?.EndpointsConfig?.["dn-p-e"].Aliases).toEqual(["web"]);
  });
  it("leaves empty sections out", () => {
    const o = buildCreateOptions({ appId: "a", slug: "s", deploymentId: "d", image: "i", env: [], labels: {}, ports: [], volumes: [], restartPolicy: "no", appNetwork: "n", proxyNetwork: null });
    expect(o.Cmd).toBeUndefined();
    expect(o.ExposedPorts).toBeUndefined();
    expect(o.HostConfig?.RestartPolicy).toEqual({ Name: "" });
  });
});
