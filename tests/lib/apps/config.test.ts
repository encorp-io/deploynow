import { describe, it, expect } from "vitest";
import { parsePorts, parseVolumes, slugify, splitCommand, traefikLabels, validateAppInput, validateHost, validateNetworkName, validatePath } from "@/lib/apps/config";

describe("slugify", () => {
  it("makes Docker-safe names", () => {
    expect(slugify("My App!")).toBe("my-app");
    expect(slugify("  --x--  ")).toBe("x");
  });
});

describe("ports and volumes", () => {
  it("parses ports", () => {
    expect(parsePorts([{ container: 80, host: "8080" }, { container: "53", protocol: "udp" }])).toEqual([
      { container: 80, host: 8080, protocol: "tcp" },
      { container: 53, host: null, protocol: "udp" },
    ]);
    expect(parsePorts("not json")).toEqual([]);
    expect(() => parsePorts([{ container: 70000 }])).toThrow(/between/);
  });

  it("parses volumes", () => {
    expect(parseVolumes('[{"name":"Data","path":"/data"}]')).toEqual([{ name: "data", path: "/data" }]);
    expect(() => parseVolumes([{ name: "a", path: "data" }])).toThrow(/mount path/);
    expect(() => parseVolumes([{ name: "a", path: "/" }])).toThrow(/mount path/);
    expect(() => parseVolumes([{ name: "a", path: "/x/../y" }])).toThrow(/mount path/);
    expect(() => parseVolumes([{ name: "a b", path: "/x" }])).toThrow(/volume name/);
    expect(() => parseVolumes([{ name: "a", path: "/x" }, { name: "b", path: "/x" }])).toThrow(/Two volumes/);
  });
});

describe("validators", () => {
  it("checks hosts, paths and networks", () => {
    expect(validateHost("App.Example.com.")).toBe("app.example.com");
    expect(() => validateHost("bad host")).toThrow();
    expect(() => validateHost("`x`")).toThrow();
    expect(validatePath("")).toBe("/");
    expect(validatePath("/api")).toBe("/api");
    expect(() => validatePath("api`")).toThrow();
    expect(validateNetworkName("dokploy-network")).toBe("dokploy-network");
    expect(() => validateNetworkName("bad name")).toThrow();
  });
});

describe("splitCommand", () => {
  it("honours quotes and escapes", () => {
    expect(splitCommand(`node server.js --name "a b" 'c d' e\\ f ""`)).toEqual(["node", "server.js", "--name", "a b", "c d", "e f", ""]);
    expect(splitCommand(`sh -c "echo \\"hi\\""`)).toEqual(["sh", "-c", 'echo "hi"']);
    expect(() => splitCommand(`echo "x`)).toThrow(/Unclosed/);
  });
});

describe("validateAppInput", () => {
  it("validates an image app", () => {
    const a = validateAppInput({ name: "Web", image: "ghcr.io/org/web:1", ports: [{ container: 80 }], env: [{ key: "A", value: "1" }] });
    expect(a.slug).toBe("web");
    expect(a.sourceType).toBe("image");
    expect(JSON.parse(a.env)).toEqual([{ key: "A", kind: "plain", value: "1" }]);
    expect(() => validateAppInput({ name: "Web", image: "-bad" })).toThrow(/image/);
    expect(() => validateAppInput({ name: "Web", image: "x", updatePolicy: "on-push" })).toThrow(/digest/);
  });

  it("keeps stored values on update", () => {
    const existing = { name: "Web", slug: "web", sourceType: "image", image: "nginx", env: '[{"key":"S","kind":"secret","value":"cipher"}]' };
    const a = validateAppInput({ command: "nginx -g 'daemon off;'" }, existing);
    expect(a.image).toBe("nginx");
    expect(a.env).toBe(existing.env);
  });

  it("validates Git apps", () => {
    const a = validateAppInput({ name: "Api", sourceType: "git-dockerfile", gitRepo: "https://github.com/org/api.git", buildContext: "./app/", updatePolicy: "on-push" });
    expect(a.gitRepo).toBe("https://github.com/org/api.git");
    expect(a.buildContext).toBe("app");
    expect(() => validateAppInput({ name: "Api", sourceType: "git-dockerfile", gitRepo: "http://x/y" })).toThrow(/https/);
    expect(() => validateAppInput({ name: "Api", sourceType: "git-compose", gitRepo: "https://github.com/o/r", gitBranch: "-x" })).toThrow(/branch/);
    expect(() => validateAppInput({ name: "Api", sourceType: "git-compose", gitRepo: "https://github.com/o/r", composePath: "../x" })).toThrow(/Invalid path/);
    expect(() => validateAppInput({ name: "Api", sourceType: "git-compose", gitRepo: "https://github.com/o/r", updatePolicy: "auto-digest" })).toThrow(/push/);
    expect(() => validateAppInput({ name: "Api", sourceType: "git-compose", gitRepo: "https://github.com/o/r", ports: [{ container: 80 }] })).toThrow(/compose file/);
  });

  it("validates inline compose", () => {
    expect(validateAppInput({ name: "C", sourceType: "compose", composeInline: "services: {}" }).composeInline).toBe("services: {}");
    expect(() => validateAppInput({ name: "C", sourceType: "compose" })).toThrow(/Paste/);
    expect(() => validateAppInput({ name: "C", sourceType: "compose", composeInline: "x", updatePolicy: "on-push" })).toThrow(/by hand/);
  });

  it("rejects bad basics", () => {
    expect(() => validateAppInput({ name: "" })).toThrow(/name/);
    expect(() => validateAppInput({ name: "x", slug: "Bad_Slug" })).toThrow(/Docker name/);
    expect(() => validateAppInput({ name: "x", sourceType: "ftp" })).toThrow(/source/);
    expect(() => validateAppInput({ name: "x", image: "a", restartPolicy: "sometimes" })).toThrow(/restart/);
    expect(() => validateAppInput({ name: "x", image: "a", command: '"open' })).toThrow(/quote/);
  });
});

describe("traefikLabels", () => {
  const d = { id: "dom_1234567890", host: "a.example.com", path: "/", containerPort: 3000, https: true };
  it("adds an https router and a redirect", () => {
    const l = traefikLabels("web", [d], "deploynow");
    const r = "dn-web-34567890";
    expect(l["traefik.enable"]).toBe("true");
    expect(l["traefik.docker.network"]).toBe("deploynow");
    expect(l[`traefik.http.routers.${r}.rule`]).toBe("Host(`a.example.com`)");
    expect(l[`traefik.http.routers.${r}.tls.certresolver`]).toBe("letsencrypt");
    expect(l[`traefik.http.routers.${r}-http.middlewares`]).toBe(`${r}-https`);
    expect(l[`traefik.http.services.${r}.loadbalancer.server.port`]).toBe("3000");
  });
  it("supports plain http and path prefixes", () => {
    const l = traefikLabels("web", [{ ...d, https: false, path: "/api" }], "n");
    expect(l["traefik.http.routers.dn-web-34567890.rule"]).toBe("Host(`a.example.com`) && PathPrefix(`/api`)");
    expect(l["traefik.http.routers.dn-web-34567890.entrypoints"]).toBe("web");
    expect(traefikLabels("web", [], "n")).toEqual({});
  });
});
