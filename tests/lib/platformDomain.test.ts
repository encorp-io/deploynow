import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { publicBaseUrl, publicOrigin, requestOrigin, setPlatformDomain, platformDomain, envOrigin } from "@/lib/publicOrigin";
import { DomainError, platformRouteLabels, probeDomain, probeSignature, validatePlatformDomain, PROBE_PATH } from "@/lib/platformDomain";
import { GET as probeGET } from "@/app/api/platform-domain/probe/route";

const ENV = "https://localhost:9444"; // tests/setup.ts

afterEach(() => {
  setPlatformDomain("");
  process.env.NEXTAUTH_URL = ENV;
  delete process.env.IGNORE_PLATFORM_DOMAIN;
});

describe("public base URL", () => {
  const req = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3001/x", { headers });

  it("uses AUTH_URL / NEXTAUTH_URL when no domain is set", () => {
    expect(envOrigin()).toBe(ENV);
    expect(publicBaseUrl()).toBe(ENV);
    expect(publicOrigin(req({ host: "1.2.3.4:9444" }))).toBe(ENV);
  });

  it("prefers the Settings domain, and unpins NextAuth while it's active", () => {
    setPlatformDomain("deploy.example.com");
    expect(platformDomain()).toBe("deploy.example.com");
    expect(publicBaseUrl()).toBe("https://deploy.example.com");
    expect(publicOrigin(req())).toBe("https://deploy.example.com");
    // Sign-in follows the request's own host, so port 9444 keeps working
    expect(process.env.AUTH_URL).toBeUndefined();
    expect(process.env.NEXTAUTH_URL).toBeUndefined();
    setPlatformDomain("");
    expect(process.env.AUTH_URL).toBe(ENV);
    expect(publicBaseUrl()).toBe(ENV);
  });

  it("keeps the fallback for module copies loaded while a domain is active", async () => {
    setPlatformDomain("deploy.example.com");
    vi.resetModules();
    const fresh = await import("@/lib/publicOrigin");
    fresh.setPlatformDomain("");
    expect(fresh.publicBaseUrl()).toBe(ENV);
    expect(process.env.AUTH_URL).toBe(ENV);
  });

  it("ignores the stored domain with IGNORE_PLATFORM_DOMAIN", () => {
    process.env.IGNORE_PLATFORM_DOMAIN = "true";
    setPlatformDomain("deploy.example.com");
    expect(publicBaseUrl()).toBe(ENV);
    expect(process.env.AUTH_URL).toBe(ENV);
  });

  it("reads the browser's origin from the forwarded headers", () => {
    expect(requestOrigin(req({ host: "127.0.0.1:3001", "x-forwarded-proto": "https", "x-forwarded-host": "deploy.example.com" }))).toBe("https://deploy.example.com");
    expect(requestOrigin(req({ host: "10.0.0.5:9444", "x-forwarded-proto": "https" }))).toBe("https://10.0.0.5:9444");
    expect(requestOrigin(new Request("https://localhost:9444/api"))).toBe("https://localhost:9444");
  });
});

describe("validatePlatformDomain", () => {
  it("accepts a host name and forgives a pasted URL", () => {
    expect(validatePlatformDomain(" Deploy.Example.com ")).toBe("deploy.example.com");
    expect(validatePlatformDomain("https://deploy.example.com/login")).toBe("deploy.example.com");
  });

  it.each(["", "localhost", "1.2.3.4", "*.example.com", "bad_host.com", "a b.com"])("refuses %j", (v) => {
    expect(() => validatePlatformDomain(v)).toThrow(DomainError);
  });
});

describe("platformRouteLabels", () => {
  it("routes HTTPS with Let's Encrypt and redirects HTTP", () => {
    const l = platformRouteLabels(["deploy.example.com"], "deploynow");
    expect(l["traefik.enable"]).toBe("true");
    expect(l["traefik.docker.network"]).toBe("deploynow");
    expect(l["traefik.http.routers.deploynow-ui.rule"]).toBe("Host(`deploy.example.com`)");
    expect(l["traefik.http.routers.deploynow-ui.tls.certresolver"]).toBe("letsencrypt");
    expect(l["traefik.http.services.deploynow-ui.loadbalancer.server.port"]).toBe("9080");
    expect(l["traefik.http.middlewares.deploynow-ui-https.redirectscheme.scheme"]).toBe("https");
  });

  it("keeps the active domain routed while another is checked", () => {
    expect(platformRouteLabels(["old.example.com", "new.example.com"], "n")["traefik.http.routers.deploynow-ui.rule"]).toBe("Host(`old.example.com`) || Host(`new.example.com`)");
  });
});

describe("probe", () => {
  it("the endpoint signs the nonce", async () => {
    const n = "abcdefghijklmnop1234";
    const res = await probeGET(new Request(`https://x${PROBE_PATH}?n=${n}`));
    expect(await res.json()).toEqual({ sig: probeSignature(n) });
    expect((await probeGET(new Request(`https://x${PROBE_PATH}?n=short`))).status).toBe(400);
  });

  const answer = (url: string) => {
    const n = new URL(url).searchParams.get("n")!;
    return { status: 200, body: JSON.stringify({ sig: probeSignature(n) }) };
  };

  it("passes when this instance answers with a valid certificate", async () => {
    const r = await probeDomain("deploy.example.com", 0, async (url) => answer(url));
    expect(r).toMatchObject({ reachable: true, certificateValid: true });
  });

  it("reports a certificate that isn't valid yet", async () => {
    const r = await probeDomain("deploy.example.com", 0, async (url, verify) => (verify ? { error: "self signed", code: "DEPTH_ZERO_SELF_SIGNED_CERT" } : answer(url)));
    expect(r).toMatchObject({ reachable: true, certificateValid: false });
    expect(r.message).toMatch(/certificate isn't valid yet/);
  });

  it("refuses an answer from another server", async () => {
    const r = await probeDomain("deploy.example.com", 0, async () => ({ status: 200, body: JSON.stringify({ sig: "nope" }) }));
    expect(r).toMatchObject({ reachable: false, certificateValid: false });
    expect(r.message).toMatch(/not from this DeployNow/);
  });

  it("reports an unreachable domain", async () => {
    const r = await probeDomain("deploy.example.com", 0, async () => ({ error: "connect ECONNREFUSED", code: "ECONNREFUSED" }));
    expect(r.reachable).toBe(false);
    expect(r.message).toMatch(/ECONNREFUSED/);
  });
});

describe("platformRouteLabels proxy secret", () => {
  const secret = "a".repeat(64);
  it("adds the secret header on the HTTPS router so nginx trusts Traefik's forwarded headers", () => {
    const l = platformRouteLabels(["deploy.example.com"], "deploynow", 9080, secret);
    expect(l["traefik.http.routers.deploynow-ui.middlewares"]).toBe("deploynow-ui-trust");
    expect(l["traefik.http.middlewares.deploynow-ui-trust.headers.customrequestheaders.X-DeployNow-Proxy-Auth"]).toBe(secret);
    expect(l["traefik.http.routers.deploynow-ui-http.middlewares"]).toBe("deploynow-ui-https");
  });

  it("leaves it out without a usable secret", () => {
    for (const s of ["", "short", "not hex at all but long enough to pass the length check!!"]) {
      expect(platformRouteLabels(["d.example.com"], "n", 9080, s)["traefik.http.routers.deploynow-ui.middlewares"]).toBeUndefined();
    }
  });
});
