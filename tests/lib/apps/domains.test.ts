import { describe, it, expect } from "vitest";
import bcrypt from "bcryptjs";
import YAML from "yaml";
import { basicAuthLine, traefikLabels, validateRedirect } from "@/lib/apps/config";
import { renderCompose } from "@/lib/deploy/compose";

const d = { id: "dom_00000000abcd", host: "www.example.com", path: "/", containerPort: 80, https: true };
const r = "dn-shop-0000abcd";

describe("redirects", () => {
  it("validates the target", () => {
    expect(validateRedirect("")).toBe("");
    expect(validateRedirect("https://example.com/")).toBe("https://example.com");
    expect(validateRedirect("https://example.com/new/")).toBe("https://example.com/new");
    expect(() => validateRedirect("ftp://x.com")).toThrow(/https/);
    expect(() => validateRedirect("https://x.com/?a=1")).toThrow(/query/);
    expect(() => validateRedirect("https://u:p@x.com")).toThrow(/credentials/);
    expect(() => validateRedirect("not a url")).toThrow(/URL/);
  });

  it("labels a redirect that keeps the path, permanent for 301/308", () => {
    const l = traefikLabels("shop", [{ ...d, redirectTo: "https://example.com", redirectCode: 308 }], "deploynow");
    expect(l[`traefik.http.middlewares.${r}-redirect.redirectregex.regex`]).toBe("^https?://[^/]+(.*)$");
    expect(l[`traefik.http.middlewares.${r}-redirect.redirectregex.replacement`]).toBe("https://example.com${1}");
    expect(l[`traefik.http.middlewares.${r}-redirect.redirectregex.permanent`]).toBe("true");
    expect(l[`traefik.http.routers.${r}.middlewares`]).toBe(`${r}-redirect`);
    const temp = traefikLabels("shop", [{ ...d, redirectTo: "https://example.com", redirectCode: 302 }], "deploynow");
    expect(temp[`traefik.http.middlewares.${r}-redirect.redirectregex.permanent`]).toBe("false");
  });
});

describe("basic auth", () => {
  it("hashes with bcrypt in the $2y$ form Traefik reads", async () => {
    const line = await basicAuthLine("admin", "correct horse");
    const [user, hash] = line.split(":");
    expect(user).toBe("admin");
    expect(hash.startsWith("$2y$10$")).toBe(true);
    expect(await bcrypt.compare("correct horse", hash.replace(/^\$2y\$/, "$2b$"))).toBe(true);
    await expect(basicAuthLine("bad user", "correct horse")).rejects.toThrow(/user name/);
    await expect(basicAuthLine("admin", "short")).rejects.toThrow(/8 to 72/);
  });

  it("puts the users on a middleware and drops the header before the app", async () => {
    const line = await basicAuthLine("admin", "correct horse");
    const l = traefikLabels("shop", [{ ...d, basicAuth: line }], "deploynow");
    expect(l[`traefik.http.middlewares.${r}-auth.basicauth.users`]).toBe(line);
    expect(l[`traefik.http.middlewares.${r}-auth.basicauth.removeheader`]).toBe("true");
    expect(l[`traefik.http.routers.${r}.middlewares`]).toBe(`${r}-auth`);
    expect(l[`traefik.http.routers.${r}.tls.certresolver`]).toBe("letsencrypt");
  });

  it("escapes $ for compose so the hash survives interpolation", async () => {
    const line = await basicAuthLine("admin", "correct horse");
    const out = renderCompose({ appId: "a", slug: "shop", deploymentId: "dep_abcdefghij1234", proxyNetwork: "deploynow", domains: [{ ...d, service: "", basicAuth: line }], compose: "services:\n  web:\n    image: nginx\n" });
    const labels = YAML.parse(out.yaml).services.web.labels as Record<string, string>;
    const stored = labels[`traefik.http.middlewares.${r}-auth.basicauth.users`];
    expect(stored).toBe(line.replace(/\$/g, "$$$$"));
    // What compose hands Traefik after interpolation ($$ → $)
    expect(stored.replace(/\$\$/g, "$")).toBe(line);
  });
});
