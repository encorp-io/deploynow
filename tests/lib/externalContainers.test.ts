import { describe, it, expect } from "vitest";
import YAML from "yaml";
import type Docker from "dockerode";
import { groupExternal, planAdoption, looksSecret, STANDALONE, pickGroup } from "@/lib/externalContainers";

const APP = "c" + "a".repeat(24);
const GONE = "c" + "g".repeat(24);
const hex = (c: string) => c.repeat(64);

function item(id: string, labels: Record<string, string>, extra: Partial<Docker.ContainerInfo> = {}): Docker.ContainerInfo {
  return { Id: hex(id), Names: [`/${id}`], Image: "nginx:1", ImageID: "sha256:x", Command: "", Created: 1, Ports: [], Labels: labels, State: "running", Status: "Up", HostConfig: { NetworkMode: "bridge" }, NetworkSettings: { Networks: {} }, Mounts: [], ...extra } as Docker.ContainerInfo;
}

describe("groupExternal", () => {
  const list = [
    item("a", { "com.docker.compose.project": "blog", "com.docker.compose.service": "web", "com.docker.compose.project.working_dir": "/srv/blog" }),
    item("b", { "com.docker.compose.project": "blog", "com.docker.compose.service": "db" }, { State: "exited" }),
    item("c", {}),
    item("d", { "deploynow.app": APP, "com.docker.compose.project": "shop" }),
    item("e", { "deploynow.app": GONE, "com.docker.compose.project": "old" }),
    item("f", { "deploynow.role": "proxy" }),
    item("g", { "io.deploynow.self": "true", "com.docker.compose.project": "deploynow" }),
    item("h", { "deploynow.helper": "true" }),
  ];

  it("groups compose stacks, keeps standalone containers apart and leaves DeployNow's own out", () => {
    const g = groupExternal(list, new Set([APP]));
    expect(g.stacks.map((s) => s.name)).toEqual(["blog", "old"]);
    const blog = g.stacks[0];
    expect(blog.containers.map((c) => c.service)).toEqual(["db", "web"]);
    expect(blog.running).toBe(1);
    expect(blog.workingDir).toBe("/srv/blog");
    expect(g.standalone.map((c) => c.name)).toEqual(["c"]);
    expect(g.stacks[1].containers[0].leftover).toBe(true);
    expect(pickGroup(g, STANDALONE)).toHaveLength(1);
    expect(pickGroup(g, "nope")).toBeNull();
  });

  it("marks a stack that already has an app", () => {
    const g = groupExternal(list, new Set([APP]), new Map([["blog", APP]]));
    expect(g.stacks[0].appId).toBe(APP);
  });
});

describe("looksSecret", () => {
  it("flags credential-like names and URLs with passwords", () => {
    expect(looksSecret("POSTGRES_PASSWORD", "x")).toBe(true);
    expect(looksSecret("STRIPE_API_KEY", "x")).toBe(true);
    expect(looksSecret("DATABASE_URL", "postgres://u@h/db")).toBe(true);
    expect(looksSecret("UPSTREAM", "https://user:pw@example.com")).toBe(true);
    expect(looksSecret("TZ", "Europe/Sofia")).toBe(false);
    expect(looksSecret("PORT", "8080")).toBe(false);
  });
});

function inspect(id: string, svc: string, over: Record<string, unknown> = {}): Docker.ContainerInspectInfo {
  const base = {
    Id: hex(id),
    Name: `/blog-${svc}-1`,
    Image: `sha256:${svc}`,
    Config: {
      Image: svc === "db" ? "postgres:16" : "ghcr.io/acme/blog:1",
      Env: ["PATH=/usr/bin", "TZ=Europe/Sofia"],
      Cmd: ["serve"],
      Entrypoint: null,
      Labels: { "com.docker.compose.project": "blog", "com.docker.compose.service": svc, "com.docker.compose.container-number": "1" },
      Hostname: hex(id).slice(0, 12),
    },
    HostConfig: { NetworkMode: "blog_default", RestartPolicy: { Name: "unless-stopped" }, PortBindings: {} },
    NetworkSettings: { Networks: { blog_default: {} } },
    Mounts: [],
  };
  return { ...base, ...over, Config: { ...base.Config, ...((over.Config as object) ?? {}) }, HostConfig: { ...base.HostConfig, ...((over.HostConfig as object) ?? {}) } } as unknown as Docker.ContainerInspectInfo;
}

const images = new Map<string, Docker.ImageInspectInfo>([
  ["sha256:web", { Config: { Env: ["PATH=/usr/bin"], Cmd: ["serve"], Labels: { "org.opencontainers.image.source": "x" } } } as unknown as Docker.ImageInspectInfo],
  ["sha256:db", { Config: { Env: ["PATH=/usr/bin"], Cmd: ["postgres"] } } as unknown as Docker.ImageInspectInfo],
]);

describe("planAdoption", () => {
  const web = inspect("a", "web", {
    Config: {
      Env: ["PATH=/usr/bin", "TZ=Europe/Sofia", "DATABASE_URL=postgres://blog:pw@db/blog", "PRICE=$5"],
      Labels: {
        "com.docker.compose.project": "blog",
        "com.docker.compose.service": "web",
        "com.docker.compose.container-number": "1",
        "com.docker.compose.depends_on": "db:service_healthy:false",
        "org.opencontainers.image.source": "x",
        "traefik.http.routers.blog.rule": "Host(`blog.example.com`)",
        "team": "web",
      },
    },
    HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "", HostPort: "8080" }], "53/udp": [{ HostIp: "127.0.0.1", HostPort: "5353" }] } },
  });
  const db = inspect("b", "db", {
    Config: { Env: ["PATH=/usr/bin", "POSTGRES_PASSWORD=pw", "TZ=UTC"], Cmd: ["postgres"] },
    Mounts: [{ Type: "volume", Name: "blog_pgdata", Destination: "/var/lib/postgresql/data", RW: true }, { Type: "volume", Name: hex("f"), Destination: "/tmp/anon", RW: true }],
  });

  it("rebuilds a compose file that keeps the project, volumes and ports, with env as variables", () => {
    const plan = planAdoption("blog", [web, db], images, { proxyNetwork: "deploynow" });
    expect(plan.inPlace).toBe(true);
    expect(plan.slug).toBe("blog");
    expect(plan.blocker).toBeNull();
    const doc = YAML.parse(plan.yaml);
    expect(Object.keys(doc.services).sort()).toEqual(["db", "web"]);
    const w = doc.services.web;
    expect(w.image).toBe("ghcr.io/acme/blog:1");
    expect(w.command).toBeUndefined(); // the image's default
    expect(w.container_name).toBeUndefined(); // compose's own name
    expect(w.ports).toEqual(["8080:80", "127.0.0.1:5353:53/udp"]);
    expect(w.restart).toBe("unless-stopped");
    expect(w.depends_on).toEqual({ db: { condition: "service_healthy" } });
    expect(w.labels).toEqual({ team: "web" });
    expect(w.environment.DATABASE_URL).toBe("${DATABASE_URL}");
    expect(w.environment.PATH).toBeUndefined();
    expect(doc.volumes).toEqual({ pgdata: { name: "blog_pgdata" } });
    expect(doc.services.db.volumes).toEqual(["pgdata:/var/lib/postgresql/data", "/tmp/anon"]);
    // Values never go into the file
    expect(plan.yaml).not.toContain("pw@db");
    expect(plan.yaml).not.toContain("POSTGRES_PASSWORD: pw");
    const env = Object.fromEntries(plan.env.map((e) => [e.key, e]));
    expect(env.DATABASE_URL).toEqual({ key: "DATABASE_URL", value: "postgres://blog:pw@db/blog", kind: "secret" });
    expect(env.POSTGRES_PASSWORD.kind).toBe("secret");
    expect(env.PRICE).toEqual({ key: "PRICE", value: "$5", kind: "plain" });
    // Same name, different values: the second one gets its own variable
    expect(env.TZ.value).toBe("Europe/Sofia");
    expect(env.DB_TZ.value).toBe("UTC");
    expect(doc.services.db.environment.TZ).toBe("${DB_TZ}");
    expect(plan.warnings.some((w) => w.includes("Traefik"))).toBe(true);
  });

  it("names what the compose rules would refuse", () => {
    const bind = inspect("c", "web", { Mounts: [{ Type: "bind", Source: "/srv/blog/uploads", Destination: "/uploads", RW: true }] });
    const plan = planAdoption("blog", [bind], images, { proxyNetwork: null });
    expect(plan.blocker).toMatch(/host path \/srv\/blog\/uploads/);
    const priv = planAdoption("blog", [inspect("d", "web", { HostConfig: { Privileged: true } })], images, { proxyNetwork: null });
    expect(priv.blocker).toMatch(/privileged/i);
  });

  it("renames stacks that aren't valid Docker names and says so", () => {
    const c = inspect("e", "web", { Name: "/my_blog-web-1", Config: { Labels: { "com.docker.compose.project": "my_blog", "com.docker.compose.service": "web", "com.docker.compose.container-number": "1" } } });
    const plan = planAdoption("my_blog", [c], images, { proxyNetwork: null });
    expect(plan.slug).toBe("my-blog");
    expect(plan.inPlace).toBe(false);
    expect(plan.warnings[0]).toMatch(/stop the old containers/);
  });

  it("counts replicas and keeps explicit container names", () => {
    const one = inspect("a", "web", { Name: "/blog-web-1" });
    const two = inspect("b", "web", { Name: "/blog-web-2", Config: { Labels: { "com.docker.compose.project": "blog", "com.docker.compose.service": "web", "com.docker.compose.container-number": "2" } } });
    expect(YAML.parse(planAdoption("blog", [one, two], images, { proxyNetwork: null }).yaml).services.web.scale).toBe(2);
    const named = inspect("c", "web", { Name: "/my-nginx" });
    expect(YAML.parse(planAdoption("blog", [named], images, { proxyNetwork: null }).yaml).services.web.container_name).toBe("my-nginx");
  });
});
