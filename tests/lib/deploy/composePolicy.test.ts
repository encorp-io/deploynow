import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";
import { checkComposeFiles, checkComposeRuntime, ComposePolicyError } from "@/lib/deploy/composePolicy";
import { renderCompose, rollbackSource } from "@/lib/deploy/compose";
import { assertNoEscapingLinks } from "@/lib/deploy/git";
import { cliSafeEnv } from "@/lib/deploy/runner";
import { validateAppInput } from "@/lib/apps/config";
import { TEMPLATES } from "@/lib/templates";

const opts = { slug: "shop", proxyNetwork: "dn-proxy" };
const svc = (s: string) => YAML.parse(`services:\n  web:\n    image: nginx\n${s.replace(/^/gm, "    ")}\n`);
const runtime = (doc: unknown) => () => checkComposeRuntime(doc, opts);

afterEach(() => {
  delete process.env.DEPLOYNOW_COMPOSE_POLICY;
});

describe("checkComposeRuntime", () => {
  it("allows ordinary stacks and every template", () => {
    expect(runtime(YAML.parse("services:\n  web:\n    image: nginx\n    volumes: [data:/data, /tmp/anon]\n    cap_add: [NET_BIND_SERVICE]\n    security_opt: [no-new-privileges:true]\n    network_mode: service:db\n  db:\n    image: postgres\n    volumes:\n      - type: volume\n        source: db\n        target: /var/lib/postgresql/data\n      - type: tmpfs\n        target: /run\nvolumes:\n  data: {}\n  db: { name: shop_db }\n"))).not.toThrow();
    for (const t of TEMPLATES) expect(runtime(YAML.parse(t.compose)), t.id).not.toThrow();
  });

  it.each([
    ["privileged: true", /privileged/],
    ['privileged: "yes"', /privileged/],
    ["cap_add: [SYS_ADMIN]", /SYS_ADMIN/],
    ["cap_add: [ALL]", /ALL/],
    ["devices: [/dev/sda:/dev/sda]", /devices/],
    ["pid: host", /pid: host/],
    ["ipc: host", /ipc: host/],
    ["userns_mode: host", /userns_mode/],
    ["network_mode: host", /network_mode: host/],
    ["network_mode: container:deploynow", /network_mode/],
    ["security_opt: [seccomp=unconfined]", /security_opt/],
    ["security_opt: [apparmor:unconfined]", /security_opt/],
    ["cgroup_parent: /", /cgroup_parent/],
    ["volumes: [/:/host]", /host path \//],
    ["volumes: [/var/run/docker.sock:/var/run/docker.sock]", /docker.sock/],
    ["volumes: [./data:/data]", /host path \.\/data/],
    ["volumes: [~/x:/x]", /host path/],
    ['volumes: ["${SRC}:/x"]', /host path/],
    ["volumes: [{type: bind, source: /etc, target: /e}]", /host path \/etc/],
    ["volumes_from: [container:deploynow]", /volumes from/],
    ['labels: ["traefik.http.routers.x.rule=Host(`dn.example.com`)"]', /Traefik label/],
    ["labels: {traefik.enable: 'true'}", /Traefik label/],
  ])("refuses %s", (yaml, msg) => {
    expect(runtime(svc(yaml))).toThrow(ComposePolicyError);
    expect(runtime(svc(yaml))).toThrow(msg);
  });

  it("refuses other apps' volumes and networks and bind-backed volumes", () => {
    const top = (y: string) => runtime(YAML.parse(`services:\n  web:\n    image: nginx\n${y}`));
    expect(top("volumes:\n  d: { external: true, name: deploynow_deployer_data }\n")).toThrow(/external/);
    expect(top("volumes:\n  d: { name: dn-other-data }\n")).toThrow(/must start with shop/);
    expect(top("volumes:\n  d: { driver: local, driver_opts: { type: none, o: bind, device: / } }\n")).toThrow(/driver_opts/);
    expect(top("networks:\n  n: { external: true, name: dn-other-prod }\n")).toThrow(/external/);
    expect(top("networks:\n  n: { name: host }\n")).toThrow(/must start with shop/);
    expect(top("networks:\n  n: { driver: macvlan }\n")).toThrow(/macvlan/);
    // The edge proxy network DeployNow attaches is fine
    expect(top("networks:\n  dn-proxy: { external: true, name: dn-proxy }\n")).not.toThrow();
  });

  it("checks docker compose config output, after interpolation", () => {
    const resolved = {
      name: "shop",
      services: {
        web: {
          image: "alpine",
          privileged: true,
          volumes: [{ type: "volume", source: "data", target: "/data", volume: {} }],
        },
      },
      volumes: { data: { name: "shop_data" } },
      networks: { default: { name: "shop_default", ipam: {} } },
    };
    expect(runtime(resolved)).toThrow(/privileged/);
    resolved.services.web.privileged = false;
    expect(runtime(resolved)).not.toThrow();
    (resolved.services.web.volumes as unknown[]).push({ type: "bind", source: "/", target: "/host", bind: {} });
    expect(runtime(resolved)).toThrow(/host path \//);
  });

  it("lets DeployNow's own Traefik labels through", () => {
    const doc = { services: { web: { image: "a", labels: { "traefik.enable": "true", "traefik.http.routers.evil.rule": "Host(`x`)" } } } };
    const own = new Set(["traefik.enable"]);
    expect(() => checkComposeRuntime(doc, { ...opts, ownLabels: () => own })).toThrow(/routers.evil/);
    delete (doc.services.web.labels as Record<string, string>)["traefik.http.routers.evil.rule"];
    expect(() => checkComposeRuntime(doc, { ...opts, ownLabels: () => own })).not.toThrow();
  });

  it("DEPLOYNOW_COMPOSE_POLICY=trusted lifts the runtime rules", () => {
    expect(runtime(svc("privileged: true"))).toThrow();
    process.env.DEPLOYNOW_COMPOSE_POLICY = "trusted";
    expect(runtime(svc("privileged: true\nvolumes: [/:/host]"))).not.toThrow();
  });
});

describe("checkComposeFiles", () => {
  let dir = "";
  const make = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-policy-"));
    fs.mkdirSync(path.join(dir, "app"));
    fs.writeFileSync(path.join(dir, "app", "ok.env"), "A=1\n");
    return dir;
  };
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const files = (y: string, root = make(), base = root) => () => checkComposeFiles(YAML.parse(y), root, base);

  it("allows files inside the app's directory", () => {
    const root = make();
    expect(files("services:\n  web:\n    build: { context: ., dockerfile: app/Dockerfile, additional_contexts: { img: 'docker-image://alpine' } }\n    env_file: [app/ok.env, { path: .env, required: false }]\nsecrets:\n  s: { file: app/ok.env }\n", root)).not.toThrow();
    expect(files("services:\n  web:\n    build: https://github.com/org/repo.git#main\n", root)).not.toThrow();
    // A compose file in a subdirectory may use files elsewhere in the repository
    expect(files("services:\n  web:\n    env_file: ../app/ok.env\n", root, path.join(root, "app"))).not.toThrow();
  });

  it.each([
    ["services:\n  web:\n    env_file: /proc/1/environ\n", /env_file/],
    ["services:\n  web:\n    env_file: [{ path: ../../etc/passwd }]\n", /outside/],
    ["services:\n  web:\n    build: { context: /data }\n", /build.context/],
    ["services:\n  web:\n    build: { context: ., dockerfile: /etc/shadow }\n", /build.dockerfile/],
    ["services:\n  web:\n    build: { context: ., secrets: [s] }\nsecrets:\n  s: { file: /proc/1/environ }\n", /secret "s"/],
    ["services:\n  web:\n    build: { context: ., ssh: [default] }\n", /build.ssh/],
    ["services:\n  web:\n    build: { context: ., additional_contexts: { x: /etc } }\n", /additional_contexts/],
    ["services:\n  web:\n    image: a\nconfigs:\n  c: { file: /data/deployer.db }\n", /config "c"/],
    ["services:\n  web:\n    extends: { file: /tmp/other.yml, service: x }\n", /extends.file/],
    ["include: [/tmp/other.yml]\nservices:\n  web:\n    image: a\n", /include/],
    ["services:\n  web:\n    env_file: ${HOME}/x\n", /variables/],
  ])("refuses %s", (yaml, msg) => {
    expect(files(yaml)).toThrow(msg);
  });

  it("refuses a link to outside the directory", () => {
    const root = make();
    fs.symlinkSync("/etc/passwd", path.join(root, "app", "leak.env"));
    expect(files("services:\n  web:\n    env_file: app/leak.env\n", root)).toThrow(/link to outside/);
  });
});

describe("assertNoEscapingLinks", () => {
  it("refuses a checkout with links out of the repository", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dn-repo-"));
    try {
      fs.mkdirSync(path.join(root, "sub"));
      fs.writeFileSync(path.join(root, "sub", "a.txt"), "x");
      fs.symlinkSync("sub/a.txt", path.join(root, "inside-link"));
      fs.symlinkSync("../sub", path.join(root, "sub", "loop-ok"));
      expect(() => assertNoEscapingLinks(root)).not.toThrow();
      fs.symlinkSync("/proc/1/environ", path.join(root, "sub", "docker-compose.yml"));
      expect(() => assertNoEscapingLinks(root)).toThrow(/sub\/docker-compose.yml is a link to outside/);
      fs.rmSync(path.join(root, "sub", "docker-compose.yml"));
      fs.symlinkSync("../../nowhere", path.join(root, "sub", "dangling"));
      expect(() => assertNoEscapingLinks(root)).toThrow(/dangling/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("renderCompose and the policy", () => {
  const base = { appId: "app1", slug: "shop", deploymentId: "dep_abcdefghij1234", domains: [], proxyNetwork: null };
  const dom = { id: "dom_00000000abcd", host: "shop.example.com", path: "/", containerPort: 80, https: true, service: "" };

  it("refuses host access and the user's own Traefik labels", () => {
    expect(() => renderCompose({ ...base, compose: "services:\n  web:\n    image: a\n    privileged: true\n" })).toThrow(/privileged/);
    expect(() => renderCompose({ ...base, compose: "services:\n  web:\n    image: a\n    labels: { traefik.http.routers.x.rule: 'Host(`dn.example.com`) && PathPrefix(`/login`)' }\n" })).toThrow(/Traefik label/);
  });

  it("reports the Traefik labels it added", () => {
    const r = renderCompose({ ...base, proxyNetwork: "p", domains: [dom], compose: "services:\n  web:\n    image: nginx\n" });
    expect([...(r.ownLabels.get("web") ?? [])]).toContain("traefik.enable");
    expect(() => checkComposeRuntime(YAML.parse(r.yaml), { slug: "shop", proxyNetwork: "p", ownLabels: (s) => r.ownLabels.get(s) ?? new Set() })).not.toThrow();
  });

  it("rollbacks drop the old Traefik labels and are checked again", () => {
    const r = renderCompose({ ...base, proxyNetwork: "p", domains: [dom], compose: "services:\n  web:\n    build: .\n" });
    const src = YAML.parse(rollbackSource(r.yaml));
    expect(src.services.web.build).toBeUndefined();
    expect(Object.keys(src.services.web.labels).some((k) => k.startsWith("traefik."))).toBe(false);
    const again = renderCompose({ ...base, deploymentId: "dep_zzzzzzzzzz9999", proxyNetwork: "p", domains: [dom], compose: rollbackSource(r.yaml) });
    expect(YAML.parse(again.yaml).services.web.image).toBe(YAML.parse(r.yaml).services.web.image);
    // A file from before the policy existed is refused on rollback
    const old = "services:\n  web:\n    image: a\n    privileged: true\n";
    expect(() => renderCompose({ ...base, compose: rollbackSource(old) })).toThrow(/privileged/);
  });
});

describe("saving an inline compose app", () => {
  it("explains the policy on save", () => {
    const body = { name: "Shop", sourceType: "compose", composeInline: "services:\n  web:\n    image: a\n    volumes: [/:/host]\n" };
    expect(() => validateAppInput(body)).toThrow(/host path/);
    expect(() => validateAppInput({ ...body, composeInline: "services:\n  web:\n    image: a\n    env_file: /proc/1/environ\n" })).toThrow(/env_file/);
    expect(validateAppInput({ ...body, composeInline: "services:\n  web:\n    image: a\n" }).composeInline).toContain("image: a");
  });
});

describe("cliSafeEnv", () => {
  it("keeps the app's variables away from the CLI's own settings", () => {
    expect(cliSafeEnv({ DB_PASSWORD: "x", COMPOSE_ENV_FILES: "/proc/1/environ", DOCKER_CONFIG: "/data", LD_PRELOAD: "/x.so", BUILDKIT_HOST: "tcp://x", PATH: "/tmp", Home: "/" })).toEqual({ DB_PASSWORD: "x" });
  });
});

function hasCompose(): boolean {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasCompose())("docker compose config output", () => {
  it("is caught after interpolation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-config-"));
    try {
      const file = path.join(dir, "c.yml");
      fs.writeFileSync(file, "services:\n  a:\n    image: alpine\n    privileged: ${PRIV}\n    volumes: ['${SRC}:/host']\n");
      const out = path.join(dir, "out.json");
      execFileSync("docker", ["compose", "-p", "shop", "-f", file, "config", "--format", "json", "-o", out], { env: { ...process.env, PRIV: "true", SRC: "/" }, stdio: "pipe" });
      const resolved = JSON.parse(fs.readFileSync(out, "utf8"));
      // privileged: ${PRIV} looks harmless as written; resolved, it isn't
      expect(() => checkComposeRuntime(resolved, opts)).toThrow(/privileged|host path/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
