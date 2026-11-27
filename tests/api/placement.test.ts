/**
 * Security: a project admin can only put apps (and builds, and environment
 * defaults) on endpoints they may run containers on, and can't route
 * DeployNow's own domain or another project's host to their app.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-api-placement-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(async () => { throw new Error("no docker in tests"); }) }));
vi.mock("@/lib/deploy/runner", () => ({ teardownApplication: vi.fn(async () => {}), runDeployment: vi.fn() }));
vi.mock("@/lib/jobs", () => ({ enqueueDeploy: vi.fn(async () => ({ id: "cdep00000000000000000000001" })), DeployBusyError: class extends Error {} }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import { setPlatformDomain } from "@/lib/publicOrigin";
import type { Binding } from "@/lib/rbac";
import * as projects from "@/app/api/projects/route";
import * as projectEnvs from "@/app/api/projects/[id]/environments/route";
import * as environment from "@/app/api/environments/[id]/route";
import * as apps from "@/app/api/apps/route";
import * as appRoute from "@/app/api/apps/[id]/route";
import * as domains from "@/app/api/apps/[id]/domains/route";
import * as templates from "@/app/api/templates/route";

const req = (method: string, body?: unknown) =>
  new Request("http://dn.local/x", { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

let localId = "";
let edgeId = "";
let builderId = "";
let regId = "";

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  localId = (await prisma.endpoint.create({ data: { name: "local", type: "socket", host: "/var/run/docker.sock" } })).id;
  edgeId = (await prisma.endpoint.create({ data: { name: "edge", type: "socket", host: "/x.sock", proxyMode: "managed" } })).id;
  builderId = (await prisma.endpoint.create({ data: { name: "builder", type: "socket", host: "/b.sock" } })).id;
  regId = (await prisma.registry.create({ data: { name: "ghcr", host: "ghcr.io", namespace: "ghcr.io/acme", username: "u", password: "" } })).id;
}, 60_000);

afterAll(async () => {
  setPlatformDomain("");
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  signOut();
  setPlatformDomain("");
});

async function newProject(name: string) {
  signInAs("admin");
  const r = await json(await projects.POST(req("POST", { name })));
  expect(r.status).toBe(201);
  return { id: r.body.id as string, envId: r.body.environments[0].id as string };
}

/** A viewer who is admin of one project, plus whatever endpoint bindings. */
function projectAdmin(projectId: string, endpoints: string[] = []) {
  const bindings: Binding[] = [{ role: "admin", scopeType: "project", scopeId: projectId }, ...endpoints.map((id) => ({ role: "operator", scopeType: "endpoint", scopeId: id }))];
  return signInAs("viewer", { id: "cuser0000000000000000000009", bindings });
}

describe("app placement", () => {
  it("refuses an app on an endpoint the project admin has no rights on", async () => {
    const pr = await newProject("Place1");
    projectAdmin(pr.id);
    const r = await apps.POST(req("POST", { environmentId: pr.envId, name: "evil", image: "alpine", endpointId: localId }));
    expect(r.status).toBe(403);
    expect(await prisma.application.count({ where: { name: "evil" } })).toBe(0);

    projectAdmin(pr.id, [edgeId]);
    expect((await apps.POST(req("POST", { environmentId: pr.envId, name: "fine", image: "alpine", endpointId: edgeId }))).status).toBe(201);
    expect((await apps.POST(req("POST", { environmentId: pr.envId, name: "evil2", image: "alpine", endpointId: localId }))).status).toBe(403);
  });

  it("doesn't let an environment default stand in for the right", async () => {
    const pr = await newProject("Place2");
    signInAs("admin");
    expect((await environment.PATCH(req("PATCH", { endpointId: localId }), p({ id: pr.envId }))).status).toBe(200);
    projectAdmin(pr.id);
    expect((await apps.POST(req("POST", { environmentId: pr.envId, name: "via-default", image: "alpine" }))).status).toBe(403);
    // Keeping the default someone else set is fine; changing it to a server they can't use isn't
    expect((await environment.PATCH(req("PATCH", { endpointId: localId }), p({ id: pr.envId }))).status).toBe(200);
    projectAdmin(pr.id, [edgeId]);
    expect((await environment.PATCH(req("PATCH", { endpointId: builderId }), p({ id: pr.envId }))).status).toBe(403);
    expect((await environment.PATCH(req("PATCH", { endpointId: edgeId }), p({ id: pr.envId }))).status).toBe(200);
    expect((await projectEnvs.POST(req("POST", { name: "staging", endpointId: localId }), p({ id: pr.id }))).status).toBe(403);
    expect((await projectEnvs.POST(req("POST", { name: "staging", endpointId: edgeId }), p({ id: pr.id }))).status).toBe(201);
  });

  it("checks the template endpoint too", async () => {
    const pr = await newProject("Place3");
    projectAdmin(pr.id);
    const r = await templates.POST(req("POST", { templateId: "uptime-kuma", environmentId: pr.envId, endpointId: localId, deploy: false }));
    expect(r.status).toBe(403);
  });

  it("needs rights on a separate build server", async () => {
    const pr = await newProject("Place4");
    projectAdmin(pr.id, [edgeId]);
    const git = { environmentId: pr.envId, endpointId: edgeId, sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/web", gitBranch: "main", registryId: regId };
    expect((await apps.POST(req("POST", { ...git, name: "b1", buildEndpointId: builderId }))).status).toBe(400);
    const id = (await json(await apps.POST(req("POST", { ...git, name: "b2" })))).body.id;
    expect((await appRoute.PATCH(req("PATCH", { buildEndpointId: builderId }), p({ id }))).status).toBe(400);
    projectAdmin(pr.id, [edgeId, builderId]);
    expect((await appRoute.PATCH(req("PATCH", { buildEndpointId: builderId }), p({ id }))).status).toBe(200);
  });

  it("lets instance-wide admins place anywhere", async () => {
    const pr = await newProject("Place5");
    signInAs("admin");
    expect((await apps.POST(req("POST", { environmentId: pr.envId, name: "adm", image: "alpine", endpointId: localId }))).status).toBe(201);
  });
});

describe("domain claims", () => {
  it("refuses DeployNow's own domain on any path", async () => {
    const pr = await newProject("Dom1");
    signInAs("admin");
    const id = (await json(await apps.POST(req("POST", { environmentId: pr.envId, name: "web", image: "nginx", endpointId: edgeId })))).body.id;
    setPlatformDomain("deploy.example.com");
    for (const path of ["/", "/login", "/api/auth"]) {
      const r = await json(await domains.POST(req("POST", { host: "Deploy.Example.com", path, containerPort: 80 }), p({ id })));
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/DeployNow's own address/);
    }
    // Also when the domain is stored but the cache was cleared (IGNORE_PLATFORM_DOMAIN)
    setPlatformDomain("");
    await prisma.settings.upsert({ where: { id: "singleton" }, create: { id: "singleton", platformDomain: "ui.example.com" }, update: { platformDomain: "ui.example.com" } });
    expect((await domains.POST(req("POST", { host: "ui.example.com", path: "/login", containerPort: 80 }), p({ id }))).status).toBe(409);
    await prisma.settings.update({ where: { id: "singleton" }, data: { platformDomain: "" } });
    expect((await domains.POST(req("POST", { host: "ok.example.com", containerPort: 80 }), p({ id }))).status).toBe(201);
  });

  it("refuses a host another project uses, on any path, but allows the same project", async () => {
    const a = await newProject("DomA");
    const b = await newProject("DomB");
    signInAs("admin");
    const appA = (await json(await apps.POST(req("POST", { environmentId: a.envId, name: "a", image: "nginx", endpointId: edgeId })))).body.id;
    const appA2 = (await json(await apps.POST(req("POST", { environmentId: a.envId, name: "a2", image: "nginx", endpointId: edgeId })))).body.id;
    const appB = (await json(await apps.POST(req("POST", { environmentId: b.envId, name: "b", image: "nginx", endpointId: edgeId })))).body.id;
    expect((await domains.POST(req("POST", { host: "shop.example.com", containerPort: 80 }), p({ id: appA }))).status).toBe(201);
    const r = await json(await domains.POST(req("POST", { host: "shop.example.com", path: "/admin", containerPort: 80 }), p({ id: appB })));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/another project/);
    expect((await domains.POST(req("POST", { host: "shop.example.com", path: "/api", containerPort: 80 }), p({ id: appA2 }))).status).toBe(201);
  });

  it("checks template domains", async () => {
    const pr = await newProject("DomT");
    signInAs("admin");
    setPlatformDomain("deploy.example.com");
    const r = await templates.POST(req("POST", { templateId: "uptime-kuma", environmentId: pr.envId, endpointId: edgeId, domain: "deploy.example.com", deploy: false }));
    expect(r.status).toBe(409);
  });

  it("refuses a preview domain that lands on DeployNow or another project's previews", async () => {
    const a = await newProject("PrevA");
    const b = await newProject("PrevB");
    signInAs("admin");
    const git = { endpointId: edgeId, sourceType: "git-dockerfile", gitRepo: "https://github.com/acme/web", gitBranch: "main" };
    const appA = (await json(await apps.POST(req("POST", { ...git, environmentId: a.envId, name: "pa" })))).body.id;
    const appB = (await json(await apps.POST(req("POST", { ...git, environmentId: b.envId, name: "pb" })))).body.id;
    setPlatformDomain("pr-1.preview.example.com");
    expect((await appRoute.PATCH(req("PATCH", { previewsEnabled: true, previewDomain: "preview.example.com" }), p({ id: appA }))).status).toBe(400);
    setPlatformDomain("deploy.example.com");
    expect((await appRoute.PATCH(req("PATCH", { previewsEnabled: true, previewDomain: "deploy.example.com" }), p({ id: appA }))).status).toBe(400);
    expect((await appRoute.PATCH(req("PATCH", { previewsEnabled: true, previewDomain: "preview.example.com" }), p({ id: appA }))).status).toBe(200);
    expect((await appRoute.PATCH(req("PATCH", { previewsEnabled: true, previewDomain: "preview.example.com" }), p({ id: appB }))).status).toBe(400);
    // Saving the app again with its own preview domain still works
    expect((await appRoute.PATCH(req("PATCH", { previewsEnabled: true, previewDomain: "preview.example.com" }), p({ id: appA }))).status).toBe(200);
  });
});
