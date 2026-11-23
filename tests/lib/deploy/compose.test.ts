import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { renderCompose, stripBuild } from "@/lib/deploy/compose";

const base = { appId: "app1", slug: "shop", deploymentId: "dep_abcdefghij1234", domains: [], proxyNetwork: null };
const dom = { id: "dom_00000000abcd", host: "shop.example.com", path: "/", containerPort: 80, https: true, service: "" };

describe("renderCompose", () => {
  it("labels services and tags built images", () => {
    const r = renderCompose({ ...base, compose: "name: x\nservices:\n  web:\n    build: .\n    labels: [\"a=b\"]\n  db:\n    image: postgres\n    labels: { c: d }\n" });
    const doc = YAML.parse(r.yaml);
    expect(r.services).toEqual(["web", "db"]);
    expect(r.builtServices).toEqual(["web"]);
    expect(doc.name).toBeUndefined();
    expect(doc.services.web.image).toBe("dn/shop-web:ghij1234".replace("ghij1234", base.deploymentId.slice(-10)));
    expect(doc.services.web.labels).toMatchObject({ a: "b", "deploynow.app": "app1", "deploynow.service": "web" });
    expect(doc.services.db.labels).toMatchObject({ c: "d", "deploynow.deployment": base.deploymentId });
  });

  it("routes a domain to the only service", () => {
    const r = renderCompose({ ...base, proxyNetwork: "deploynow", domains: [dom], compose: "services:\n  web:\n    image: nginx\n" });
    const doc = YAML.parse(r.yaml);
    expect(doc.services.web.networks).toEqual(["default", "deploynow"]);
    expect(doc.networks.deploynow).toEqual({ external: true, name: "deploynow" });
    expect(doc.services.web.labels["traefik.enable"]).toBe("true");
  });

  it("adds the proxy network to listed networks", () => {
    const list = YAML.parse(renderCompose({ ...base, proxyNetwork: "p", domains: [{ ...dom, service: "web" }], compose: "services:\n  web:\n    image: a\n    networks: [back]\n  db:\n    image: b\n" }).yaml);
    expect(list.services.web.networks).toEqual(["back", "p"]);
    const map = YAML.parse(renderCompose({ ...base, proxyNetwork: "p", domains: [dom], compose: "services:\n  web:\n    image: a\n    networks: { back: {} }\nnetworks: { back: {} }\n" }).yaml);
    expect(Object.keys(map.services.web.networks)).toEqual(["back", "p"]);
    expect(map.networks.back).toEqual({});
  });

  it("explains bad files and domain mistakes", () => {
    expect(() => renderCompose({ ...base, compose: "services: [" })).toThrow(/valid YAML/);
    expect(() => renderCompose({ ...base, compose: "version: '3'" })).toThrow(/no services/);
    expect(() => renderCompose({ ...base, compose: "services:\n  web: 3\n" })).toThrow(/not a map/);
    expect(() => renderCompose({ ...base, compose: "services:\n  web:\n    labels: 3\n" })).toThrow(/list or a map/);
    const two = "services:\n  a:\n    image: x\n  b:\n    image: y\n";
    expect(() => renderCompose({ ...base, proxyNetwork: "p", domains: [dom], compose: two })).toThrow(/several services/);
    expect(() => renderCompose({ ...base, proxyNetwork: "p", domains: [{ ...dom, service: "c" }], compose: two })).toThrow(/isn't in the compose/);
    expect(() => renderCompose({ ...base, domains: [dom], compose: "services:\n  a:\n    image: x\n" })).toThrow(/edge proxy/);
    expect(() => renderCompose({ ...base, proxyNetwork: "p", domains: [dom], compose: "services:\n  a:\n    image: x\n    network_mode: host\n" })).toThrow(/network_mode/);
  });
});

describe("stripBuild", () => {
  it("drops build sections for a rollback", () => {
    const r = renderCompose({ ...base, compose: "services:\n  web:\n    build: .\n" });
    const doc = YAML.parse(stripBuild(r.yaml));
    expect(doc.services.web.build).toBeUndefined();
    expect(doc.services.web.image).toMatch(/^dn\/shop-web:/);
  });
});
