import { describe, it, expect, vi } from "vitest";
import type Docker from "dockerode";
import { checkExternalProxy, ensureNetwork, installProxy, PROXY_CONTAINER, proxyArgs, proxyStatus, removeProxy } from "@/lib/deploy/proxy";

const notFound = () => Object.assign(new Error("no such"), { statusCode: 404 });

function fakeDocker(opts: { network?: boolean; container?: Record<string, unknown> | null; startError?: string; traefikOnNet?: boolean } = {}) {
  const created: Record<string, unknown>[] = [];
  const removed: string[] = [];
  const start = vi.fn(async () => {
    if (opts.startError) throw new Error(opts.startError);
  });
  const docker = {
    getNetwork: vi.fn(() => ({ inspect: vi.fn(async () => { if (!opts.network) throw notFound(); return { Containers: { a: { Name: "x" } } }; }) })),
    createNetwork: vi.fn(async (o: Record<string, unknown>) => created.push({ network: o })),
    getImage: vi.fn(() => ({ inspect: vi.fn(async () => ({})) })),
    getContainer: vi.fn((name: string) => ({
      inspect: vi.fn(async () => { if (!opts.container) throw notFound(); return opts.container; }),
      remove: vi.fn(async () => { if (!opts.container) throw notFound(); removed.push(name); }),
    })),
    createContainer: vi.fn(async (o: Record<string, unknown>) => {
      created.push(o);
      return { start, remove: vi.fn(async () => removed.push("new")) };
    }),
    listContainers: vi.fn(async () => (opts.traefikOnNet ? [{ Image: "traefik:v3.1", Names: ["/dokploy-traefik"] }] : [{ Image: "nginx", Names: ["/web"] }])),
  };
  return { docker: docker as unknown as Docker, raw: docker, created, removed };
}

describe("proxyArgs", () => {
  it("configures the Docker provider and Let's Encrypt", () => {
    const a = proxyArgs("ops@example.com", "deploynow");
    expect(a).toContain("--providers.docker.exposedbydefault=false");
    expect(a).toContain("--providers.docker.network=deploynow");
    expect(a).toContain("--certificatesresolvers.letsencrypt.acme.email=ops@example.com");
    // Trusts Cloudflare's X-Forwarded-Proto so Flexible SSL doesn't loop on the https redirect
    expect(a.find((x) => x.startsWith("--entrypoints.web.forwardedheaders.trustedips="))).toContain("173.245.48.0/20");
    expect(a.find((x) => x.startsWith("--entrypoints.websecure.forwardedheaders.trustedips="))).toContain("2606:4700::/32");
  });
});

describe("ensureNetwork", () => {
  it("creates a missing network once", async () => {
    const f = fakeDocker();
    await ensureNetwork(f.docker, "deploynow");
    expect(f.raw.createNetwork).toHaveBeenCalledWith(expect.objectContaining({ Name: "deploynow", Driver: "bridge" }));
    const g = fakeDocker({ network: true });
    await ensureNetwork(g.docker, "deploynow");
    expect(g.raw.createNetwork).not.toHaveBeenCalled();
  });
});

describe("installProxy", () => {
  it("needs an email", async () => {
    await expect(installProxy(fakeDocker().docker, { email: "nope", network: "n" })).rejects.toThrow(/email/);
  });

  it("creates Traefik on ports 80 and 443", async () => {
    const f = fakeDocker({ network: true });
    await installProxy(f.docker, { email: "ops@example.com", network: "deploynow" });
    const c = f.created[0] as { name: string; HostConfig: { PortBindings: unknown; NetworkMode: string } };
    expect(c.name).toBe(PROXY_CONTAINER);
    expect(c.HostConfig.NetworkMode).toBe("deploynow");
    expect(c.HostConfig.PortBindings).toEqual({ "80/tcp": [{ HostPort: "80" }], "443/tcp": [{ HostPort: "443" }] });
  });

  it("explains busy ports", async () => {
    const f = fakeDocker({ network: true, startError: "Bind for 0.0.0.0:80 failed: port is already allocated" });
    await expect(installProxy(f.docker, { email: "ops@example.com", network: "deploynow" })).rejects.toThrow(/existing Traefik/);
    expect(f.removed).toContain("new");
  });
});

describe("proxyStatus and removeProxy", () => {
  it("reports a missing, running or exited proxy", async () => {
    expect(await proxyStatus(fakeDocker().docker)).toEqual({ running: false, image: "", startedAt: null, error: "" });
    const running = { State: { Running: true, StartedAt: "t", Error: "", ExitCode: 0 }, Config: { Image: "traefik:v3.6" } };
    expect(await proxyStatus(fakeDocker({ container: running }).docker)).toMatchObject({ running: true, error: "" });
    const exited = { State: { Running: false, StartedAt: "t", Error: "", ExitCode: 1 }, Config: { Image: "traefik:v3.6" } };
    expect((await proxyStatus(fakeDocker({ container: exited }).docker)).error).toBe("Exited with code 1");
  });

  it("ignores an already removed proxy", async () => {
    await expect(removeProxy(fakeDocker().docker)).resolves.toBeUndefined();
  });
});

describe("checkExternalProxy", () => {
  it("finds Traefik on the network", async () => {
    expect(await checkExternalProxy(fakeDocker({ network: true, traefikOnNet: true }).docker, "dokploy-network")).toEqual({ ok: true, message: "Found dokploy-traefik (traefik:v3.1) on dokploy-network" });
    expect((await checkExternalProxy(fakeDocker({ network: true }).docker, "n")).ok).toBe(false);
    expect((await checkExternalProxy(fakeDocker().docker, "n")).message).toMatch(/doesn't exist/);
  });
});

describe("Cloudflare DNS challenge", () => {
  it("switches the resolver to DNS-01 and passes the token as an env var", async () => {
    const a = proxyArgs("ops@example.com", "deploynow", "cloudflare");
    expect(a).toContain("--certificatesresolvers.letsencrypt.acme.dnschallenge.provider=cloudflare");
    expect(a.some((x) => x.includes("httpchallenge"))).toBe(false);
    const f = fakeDocker({ network: true });
    await expect(installProxy(f.docker, { email: "ops@example.com", network: "deploynow", challenge: "cloudflare", dnsToken: "short" })).rejects.toThrow(/Cloudflare API token/);
    await installProxy(f.docker, { email: "ops@example.com", network: "deploynow", challenge: "cloudflare", dnsToken: "cf_token_abcdefghijklmnopqrstuvwxyz" });
    const c = f.created.find((x) => "Image" in x) as { Env: string[]; Cmd: string[] };
    expect(c.Env).toEqual(["CF_DNS_API_TOKEN=cf_token_abcdefghijklmnopqrstuvwxyz"]);
  });
});
