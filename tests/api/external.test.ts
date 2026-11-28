/**
 * Unmanaged containers: listing per endpoint, stack actions and turning a
 * compose stack into an app, with the endpoint and project permissions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const EP = "c" + "e".repeat(24);
const PROJECT = "c" + "p".repeat(24);
const ENV = "c" + "v".repeat(24);
const hex = (c: string) => c.repeat(64);

const calls = vi.hoisted(() => ({ restart: [] as string[], created: [] as Record<string, unknown>[] }));
const mockPrisma = vi.hoisted(() => ({
  endpoint: { findUnique: vi.fn(), findMany: vi.fn() },
  application: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  environment: { findUnique: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/secretsCrypto", () => ({ encryptSecret: (v: string) => `enc:${v}`, decryptSecret: (v: string) => v.replace(/^enc:/, "") }));

const list = [
  { Id: hex("a"), Names: ["/blog-web-1"], Image: "nginx:1", Created: 1, Ports: [{ PrivatePort: 80, PublicPort: 8080, Type: "tcp" }], State: "running", Status: "Up", Labels: { "com.docker.compose.project": "blog", "com.docker.compose.service": "web" } },
  { Id: hex("b"), Names: ["/redis"], Image: "redis:7", Created: 1, Ports: [], State: "exited", Status: "Exited", Labels: {} },
  { Id: hex("c"), Names: ["/deploynow"], Image: "ghcr.io/encorp-io/deploynow:1.1.0", Created: 1, Ports: [], State: "running", Status: "Up", Labels: { "com.docker.compose.project": "deploynow" } },
];
const inspectOf = (id: string) => {
  const c = list.find((x) => x.Id === id)!;
  return {
    Id: c.Id,
    Name: c.Names[0],
    Image: "sha256:img",
    State: { Running: c.State === "running" },
    Config: { Image: c.Image, Env: ["PATH=/bin", "ADMIN_PASS=topsecret", "MODE=prod"], Cmd: ["nginx"], Labels: { ...c.Labels, "com.docker.compose.container-number": "1" } },
    HostConfig: { NetworkMode: "blog_default", RestartPolicy: { Name: "always" }, PortBindings: { "80/tcp": [{ HostPort: "8080" }] } },
    NetworkSettings: { Networks: { blog_default: {} } },
    Mounts: [],
  };
};
vi.mock("@/lib/endpoints", async (orig) => ({
  ...(await orig<typeof import("@/lib/endpoints")>()),
  dockerFor: () => ({
    listContainers: async (opts?: { filters?: { label?: string[] } }) => {
      const want = opts?.filters?.label?.[0]?.split("=")[1];
      return want ? list.filter((c) => (c.Labels as Record<string, string>)["com.docker.compose.project"] === want) : list;
    },
    getContainer: (id: string) => ({
      inspect: async () => inspectOf(id),
      restart: async () => void calls.restart.push(id),
      start: async () => undefined,
      stop: async () => undefined,
    }),
    getImage: () => ({ inspect: async () => ({ Config: { Env: ["PATH=/bin"], Cmd: ["nginx"] } }) }),
  }),
}));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { GET as EXTERNAL } from "@/app/api/external/route";
import { GET as STACK, POST as STACK_ACTION } from "@/app/api/endpoints/[id]/stacks/[name]/route";
import { GET as PREVIEW, POST as ADOPT } from "@/app/api/endpoints/[id]/stacks/[name]/adopt/route";

const p = (name: string) => ({ params: Promise.resolve({ id: EP, name }) });
const req = (method = "GET", body?: unknown) => new Request("http://x/", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  calls.restart = [];
  calls.created = [];
  const ep = { id: EP, name: "old-server", type: "socket", host: "/var/run/docker.sock", status: "online", lastError: "", proxyMode: "none", proxyNetwork: "deploynow" };
  mockPrisma.endpoint.findUnique.mockResolvedValue(ep);
  mockPrisma.endpoint.findMany.mockResolvedValue([ep]);
  mockPrisma.application.findMany.mockResolvedValue([]);
  mockPrisma.application.findUnique.mockResolvedValue(null);
  mockPrisma.application.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    calls.created.push(data);
    return { id: "c" + "n".repeat(24), name: data.name };
  });
  mockPrisma.environment.findUnique.mockResolvedValue({ id: ENV, name: "production", projectId: PROJECT, project: { name: "Blog" } });
});

describe("GET /api/external", () => {
  it("lists compose stacks and standalone containers, never DeployNow itself", async () => {
    signInAs("viewer");
    const body = await (await EXTERNAL()).json();
    const e = body.endpoints[0];
    expect(e.stacks.map((s: { name: string }) => s.name)).toEqual(["blog"]);
    expect(e.standalone.map((c: { name: string }) => c.name)).toEqual(["redis"]);
    expect(e.allowed).toMatchObject({ control: false, console: false, adopt: false });
  });

  it("leaves out endpoints the caller can't see", async () => {
    signInAs("viewer", { role: "viewer" });
    mockPrisma.endpoint.findMany.mockResolvedValue([]);
    expect((await (await EXTERNAL()).json()).endpoints).toEqual([]);
  });
});

describe("stack actions", () => {
  it("lets operators restart a stack, not viewers", async () => {
    signInAs("viewer");
    expect((await STACK_ACTION(req("POST", { action: "restart" }), p("blog"))).status).toBe(403);
    signInAs("operator");
    const res = await STACK_ACTION(req("POST", { action: "restart" }), p("blog"));
    expect(res.status).toBe(200);
    expect(calls.restart).toEqual([hex("a")]);
  });

  it("can't reach DeployNow's own stack", async () => {
    signInAs("owner");
    expect((await STACK(req(), p("deploynow"))).status).toBe(404);
    expect((await STACK_ACTION(req("POST", { action: "stop" }), p("deploynow"))).status).toBe(404);
  });

  it("rejects odd stack names", async () => {
    signInAs("owner");
    expect((await STACK(req(), p("../x"))).status).toBe(400);
  });
});

describe("adopting a stack", () => {
  it("needs admin on the endpoint (it reads env values)", async () => {
    signInAs("operator");
    expect((await PREVIEW(req(), p("blog"))).status).toBe(403);
  });

  it("previews the file with variable names only", async () => {
    signInAs("admin");
    const res = await PREVIEW(req(), p("blog"));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("topsecret");
    const body = JSON.parse(raw);
    expect(body.slug).toBe("blog");
    expect(body.env).toEqual([{ key: "ADMIN_PASS", kind: "secret" }, { key: "MODE", kind: "plain" }]);
    expect(body.yaml).toContain("${ADMIN_PASS}");
  });

  it("creates a compose app with the values read from the containers, secrets encrypted", async () => {
    signInAs("admin");
    const res = await ADOPT(req("POST", { environmentId: ENV, name: "Blog" }), p("blog"));
    expect(res.status).toBe(201);
    const data = calls.created[0];
    expect(data).toMatchObject({ slug: "blog", sourceType: "compose", endpointId: EP, environmentId: ENV, name: "Blog" });
    const env = JSON.parse(String(data.env));
    expect(env).toEqual([{ key: "ADMIN_PASS", kind: "secret", value: "enc:topsecret" }, { key: "MODE", kind: "plain", value: "prod" }]);
  });

  it("needs app.manage on the target project", async () => {
    signInAs("operator", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: EP }] });
    expect((await ADOPT(req("POST", { environmentId: ENV }), p("blog"))).status).toBe(403);
    signInAs("operator", { bindings: [{ role: "admin", scopeType: "endpoint", scopeId: EP }, { role: "admin", scopeType: "project", scopeId: PROJECT }] });
    expect((await ADOPT(req("POST", { environmentId: ENV }), p("blog"))).status).toBe(201);
  });

  it("refuses a stack name that's already an app", async () => {
    signInAs("admin");
    mockPrisma.application.findUnique.mockResolvedValue({ id: "x" });
    expect((await ADOPT(req("POST", { environmentId: ENV }), p("blog"))).status).toBe(409);
  });
});
