/**
 * Secrets inside containers: env values, consoles, logs and control of
 * DeployNow's own, updater, helper, proxy and app containers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const EP = "c" + "e".repeat(24);
const PROJECT = "c" + "p".repeat(24);
const APP = "c" + "a".repeat(24);

type Fake = { Id: string; Name: string; Config: { Image: string; Labels: Record<string, string>; Env: string[]; Tty: boolean; Cmd: string[] } };
const containers = vi.hoisted(() => new Map<string, unknown>());
const calls = vi.hoisted(() => ({ logs: 0, stop: 0, remove: 0 }));

const mockPrisma = vi.hoisted(() => ({
  endpoint: { findUnique: vi.fn() },
  application: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpoints", async (orig) => ({
  ...(await orig<typeof import("@/lib/endpoints")>()),
  dockerFor: () => ({
    getContainer: (id: string) => ({
      inspect: async () => {
        const c = containers.get(id) as Fake | undefined;
        if (!c) throw Object.assign(new Error("no such container"), { statusCode: 404 });
        return {
          ...c,
          Image: "sha256:" + "0".repeat(64),
          Created: new Date().toISOString(),
          State: { Status: "running", Running: true, StartedAt: "", FinishedAt: "", ExitCode: 0 },
          RestartCount: 0,
          HostConfig: { RestartPolicy: { Name: "no" } },
          NetworkSettings: { Ports: {}, Networks: {} },
          Mounts: [],
        };
      },
      logs: async () => {
        calls.logs++;
        return Buffer.from("line\n");
      },
      stop: async () => void calls.stop++,
      remove: async () => void calls.remove++,
    }),
  }),
}));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { containerKind, protectionAllows } from "@/lib/containerProtection";
import { GET, POST, DELETE } from "@/app/api/endpoints/[id]/containers/[cid]/route";
import { GET as LOGS } from "@/app/api/endpoints/[id]/containers/[cid]/logs/route";
import { POST as EXEC } from "@/app/api/endpoints/[id]/containers/[cid]/exec/route";

const hex = (c: string) => c.repeat(64);
function add(id: string, image: string, labels: Record<string, string> = {}, env: string[] = ["SECRET=s3cret", "PLAIN=1"]) {
  containers.set(id, { Id: hex(id), Name: `/${id}`, Config: { Image: image, Labels: labels, Env: env, Tty: false, Cmd: [] } });
}

const p = (cid: string) => ({ params: Promise.resolve({ id: EP, cid }) });
const req = (method = "GET", body?: unknown) => new Request("http://x/", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  calls.logs = calls.stop = calls.remove = 0;
  containers.clear();
  mockPrisma.endpoint.findUnique.mockResolvedValue({ id: EP, name: "local", type: "socket", host: "/var/run/docker.sock" });
  mockPrisma.application.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === APP ? { environment: { projectId: PROJECT } } : null));
  add("a", "ghcr.io/encorp-io/deploynow:1.0.0", {}, ["AUTH_SECRET=forge-me", "ADMIN_PASSWORD=hunter2hunter2"]);
  add("b", "alpine:3.20", { "io.deploynow.updater": "true", "deploynow.role": "updater" }, ["AUTH_SECRET=forge-me"]);
  add("c", "restic/restic:0.17", { "deploynow.helper": "true" }, ["RESTIC_PASSWORD=pw", "AWS_SECRET_ACCESS_KEY=k"]);
  add("d", "traefik:v3", { "deploynow.role": "proxy" });
  add("e", "nginx:1", { "deploynow.app": APP, "deploynow.project": PROJECT }, ["DB_PASSWORD=app-secret"]);
  add("f", "redis:7");
});

const envOf = async (cid: string) => (await (await GET(req(), p(cid))).json()) as { env: { key: string; value: string | null }[]; envHidden: boolean; kind: string; allowed: Record<string, boolean> };

describe("containerKind", () => {
  it("recognises DeployNow, the updater, helpers, the proxy and apps", () => {
    const k = (image: string, labels: Record<string, string> = {}) => containerKind({ Id: "x", Config: { Image: image, Labels: labels } });
    expect(k("ghcr.io/encorp-io/deploynow:latest")).toBe("deploynow");
    expect(k("encorp-io/deploynow@sha256:abc")).toBe("deploynow");
    expect(k("ghcr.io/encorp-io/deployer-for-portainer:2")).toBe("deploynow");
    expect(k("anything", { "io.deploynow.self": "true" })).toBe("deploynow");
    expect(k("anything", { "io.deploynow.updater": "true" })).toBe("deploynow");
    expect(k("restic/restic", { "deploynow.helper": "true" })).toBe("helper");
    expect(k("traefik:v3", { "deploynow.role": "proxy" })).toBe("platform");
    expect(k("nginx", { "deploynow.app": APP })).toBe("app");
    expect(k("acme/deploynow-clone:1")).toBe("other");
    expect(k("redis:7")).toBe("other");
  });

  it("uses the endpoint role, including per-endpoint bindings", () => {
    const opWithBinding = { role: "operator", bindings: [{ role: "admin", scopeType: "endpoint", scopeId: EP }] };
    expect(protectionAllows(opWithBinding, EP, "deploynow", "logs")).toBe(true);
    expect(protectionAllows(opWithBinding, "c" + "z".repeat(24), "deploynow", "logs")).toBe(false);
    expect(protectionAllows({ role: "owner" }, EP, "deploynow", "exec")).toBe(false);
    expect(protectionAllows({ role: "owner" }, EP, "helper", "env")).toBe(false);
    expect(protectionAllows({ role: "operator" }, EP, "other", "exec")).toBe(true); // rbac.ts decides for other containers
  });
});

describe("environment values", () => {
  it("never shows DeployNow's, the updater's or a helper's env, even to the owner", async () => {
    signInAs("owner");
    for (const cid of ["a", "b", "c"]) {
      const d = await envOf(cid);
      expect(d.envHidden).toBe(true);
      expect(d.env.every((e) => e.value === null)).toBe(true);
      expect(d.env.length).toBeGreaterThan(0); // names stay visible
      expect(d.allowed.console).toBe(false);
    }
    const raw = JSON.stringify(await envOf("a"));
    expect(raw).not.toContain("forge-me");
    expect(raw).not.toContain("hunter2");
  });

  it("shows other containers' env to admins only", async () => {
    signInAs("operator");
    expect((await envOf("f")).env.find((e) => e.key === "SECRET")!.value).toBeNull();
    signInAs("admin");
    expect((await envOf("f")).env.find((e) => e.key === "SECRET")!.value).toBe("s3cret");
  });

  it("shows an app container's env only to people who may read that app's secrets", async () => {
    // Admin on the endpoint, operator on the project: the values are the app's decrypted secrets
    signInAs("operator", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: EP }] });
    expect((await envOf("e")).env[0].value).toBeNull();
    signInAs("operator", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: EP }, { role: "admin", scopeType: "project", scopeId: PROJECT }] });
    expect((await envOf("e")).env[0].value).toBe("app-secret");
    signInAs("admin");
    expect((await envOf("e")).env[0].value).toBe("app-secret");
  });

  it("keeps the values hidden when the app label points nowhere", async () => {
    add("g", "nginx:1", { "deploynow.app": "c" + "q".repeat(24) }, ["X=leak"]);
    signInAs("admin");
    expect((await envOf("g")).env[0].value).toBeNull();
    signInAs("owner");
    expect((await envOf("g")).env[0].value).toBe("leak");
  });
});

describe("consoles", () => {
  it("refuses a console in DeployNow, the updater and helpers for everyone", async () => {
    signInAs("owner");
    for (const cid of ["a", "b", "c"]) {
      const res = await EXEC(req("POST", { shell: "/bin/sh" }), p(cid));
      expect(res.status).toBe(403);
      expect((await res.json()).protected).toBe(true);
    }
  });

  it("is admin only for other containers", async () => {
    signInAs("operator");
    expect((await EXEC(req("POST", { shell: "/bin/sh" }), p("f"))).status).toBe(403);
    signInAs("admin");
    const res = await EXEC(req("POST", { shell: "/bin/sh" }), p("f"));
    expect(res.status).toBe(200);
    expect((await res.json()).ticket).toBeTruthy();
  });
});

describe("consoles in app containers", () => {
  it("need access to the app's secrets", async () => {
    // Admin on the endpoint, operator on the project: env shows nothing, so the console must not either
    signInAs("operator", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: EP }] });
    const res = await EXEC(req("POST", { shell: "/bin/sh" }), p("e"));
    expect(res.status).toBe(403);
    expect((await envOf("e")).allowed.console).toBe(false);
    signInAs("operator", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: EP }, { role: "admin", scopeType: "project", scopeId: PROJECT }] });
    expect((await EXEC(req("POST", { shell: "/bin/sh" }), p("e"))).status).toBe(200);
    expect((await envOf("e")).allowed.console).toBe(true);
  });
});

describe("logs, control and removal", () => {
  it("lets only admins read DeployNow's and helpers' logs", async () => {
    signInAs("operator");
    expect((await LOGS(req(), p("a"))).status).toBe(403);
    expect((await LOGS(req(), p("c"))).status).toBe(403);
    expect(calls.logs).toBe(0);
    expect((await LOGS(req(), p("f"))).status).toBe(200);
    signInAs("admin");
    expect((await LOGS(req(), p("a"))).status).toBe(200);
  });

  it("lets only owners stop or remove DeployNow, the updater and helpers", async () => {
    signInAs("admin");
    expect((await POST(req("POST", { action: "stop" }), p("a"))).status).toBe(403);
    expect((await DELETE(req("DELETE"), p("c"))).status).toBe(403);
    expect(calls.stop + calls.remove).toBe(0);
    expect((await POST(req("POST", { action: "stop" }), p("d"))).status).toBe(200);
    signInAs("operator");
    expect((await POST(req("POST", { action: "stop" }), p("d"))).status).toBe(403); // proxy: admin
    expect((await POST(req("POST", { action: "stop" }), p("f"))).status).toBe(200);
    signInAs("owner");
    expect((await POST(req("POST", { action: "stop" }), p("a"))).status).toBe(200);
    expect((await DELETE(req("DELETE"), p("b"))).status).toBe(200);
  });

  it("reports what the person may do", async () => {
    signInAs("operator");
    expect((await envOf("a")).allowed).toEqual({ logs: false, console: false, control: false, remove: false });
    expect((await envOf("f")).allowed).toEqual({ logs: true, console: false, control: true, remove: false });
  });
});
