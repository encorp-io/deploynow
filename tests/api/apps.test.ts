/**
 * Projects, environments, apps, deployments, domains, secrets and the GitHub
 * webhook, against a real SQLite database. Docker is stubbed out.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-api-apps-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/endpoints", () => ({ dockerFor: vi.fn(async () => { throw new Error("no docker in tests"); }) }));
vi.mock("@/lib/deploy/runner", () => ({ teardownApplication: vi.fn(async () => {}), runDeployment: vi.fn() }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { audit } from "@/lib/audit";
import { teardownApplication } from "@/lib/deploy/runner";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/secretsCrypto";
import * as projects from "@/app/api/projects/route";
import * as project from "@/app/api/projects/[id]/route";
import * as projectEnvs from "@/app/api/projects/[id]/environments/route";
import * as environment from "@/app/api/environments/[id]/route";
import * as apps from "@/app/api/apps/route";
import * as appRoute from "@/app/api/apps/[id]/route";
import * as deploy from "@/app/api/apps/[id]/deploy/route";
import * as deployments from "@/app/api/apps/[id]/deployments/route";
import * as deployment from "@/app/api/apps/[id]/deployments/[depId]/route";
import * as domains from "@/app/api/apps/[id]/domains/route";
import * as envRoute from "@/app/api/apps/[id]/env/route";
import * as webhook from "@/app/api/apps/[id]/webhook/route";
import * as github from "@/app/api/webhooks/github/[appId]/route";

const req = (method: string, body?: unknown, url = "http://dn.local/x") =>
  new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

let endpointId = "";
let proxyEndpointId = "";

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  endpointId = (await prisma.endpoint.create({ data: { name: "local", type: "socket", host: "/var/run/docker.sock" } })).id;
  proxyEndpointId = (await prisma.endpoint.create({ data: { name: "edge", type: "socket", host: "/x.sock", proxyMode: "managed" } })).id;
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  signOut();
});

async function newProject(name: string) {
  signInAs("admin");
  const r = await json(await projects.POST(req("POST", { name, endpointId })));
  expect(r.status).toBe(201);
  return r.body as { id: string; environments: { id: string }[] };
}

let appSeq = 0;
async function newApp(envId: string, extra: Record<string, unknown> = {}) {
  const r = await json(await apps.POST(req("POST", { environmentId: envId, name: `web-${++appSeq}`, image: "nginx:1", ...extra })));
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe("projects", () => {
  it("creates a project with a production environment and lists it", async () => {
    const pr = await newProject("Shop");
    expect(pr.environments).toHaveLength(1);
    const list = await json(await projects.GET());
    expect(list.body.find((x: { id: string }) => x.id === pr.id).environments[0].name).toBe("production");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "project.create" }));
  });

  it("validates and refuses duplicates", async () => {
    await newProject("Dup");
    expect((await projects.POST(req("POST", { name: "Dup" }))).status).toBe(409);
    expect((await projects.POST(req("POST", { name: "" }))).status).toBe(400);
    expect((await projects.POST(req("POST", { name: "x", slug: "Bad Slug" }))).status).toBe(400);
    expect((await projects.POST(req("POST", { name: "y", endpointId: "cmissing0000000000000000x" }))).status).toBe(404);
  });

  it("needs admin to create and hides projects from unbound users", async () => {
    const pr = await newProject("Private");
    signInAs("operator");
    expect((await projects.POST(req("POST", { name: "Nope" }))).status).toBe(403);
    signInAs("operator", { role: "operator" as never });
    // operators see every project instance-wide
    expect((await project.GET(req("GET"), p({ id: pr.id }))).status).toBe(200);
  });

  it("lets a project binding raise a viewer's rights on that project only", async () => {
    const a = await newProject("Bound");
    const b = await newProject("Unbound");
    signInAs("viewer", { bindings: [{ role: "admin", scopeType: "project", scopeId: a.id }, { role: "operator", scopeType: "endpoint", scopeId: endpointId }] });
    expect((await project.PATCH(req("PATCH", { description: "mine" }), p({ id: a.id }))).status).toBe(200);
    expect((await project.PATCH(req("PATCH", { description: "theirs" }), p({ id: b.id }))).status).toBe(403);
    const envId = (await prisma.environment.findFirstOrThrow({ where: { projectId: a.id } })).id;
    const otherEnv = (await prisma.environment.findFirstOrThrow({ where: { projectId: b.id } })).id;
    expect((await apps.POST(req("POST", { environmentId: envId, name: "bound-app", image: "y" }))).status).toBe(201);
    expect((await apps.POST(req("POST", { environmentId: otherEnv, name: "other-app", image: "y" }))).status).toBe(403);
  });

  it("renames, adds and removes environments, and deletes an empty project", async () => {
    const pr = await newProject("Lifecycle");
    expect((await json(await project.PATCH(req("PATCH", { name: "Lifecycle 2", description: "d" }), p({ id: pr.id })))).body.name).toBe("Lifecycle 2");
    expect((await project.PATCH(req("PATCH", { name: "Shop" }), p({ id: pr.id }))).status).toBe(409);
    const env = await json(await projectEnvs.POST(req("POST", { name: "staging", endpointId }), p({ id: pr.id })));
    expect(env.status).toBe(201);
    expect((await projectEnvs.POST(req("POST", { name: "staging" }), p({ id: pr.id }))).status).toBe(409);
    expect((await projectEnvs.POST(req("POST", { name: "" }), p({ id: pr.id }))).status).toBe(400);
    expect((await environment.PATCH(req("PATCH", { name: "stage" }), p({ id: env.body.id }))).status).toBe(200);
    expect((await environment.DELETE(req("DELETE"), p({ id: env.body.id }))).status).toBe(200);
    expect((await environment.DELETE(req("DELETE"), p({ id: pr.environments[0].id }))).status).toBe(409);
    expect((await project.DELETE(req("DELETE"), p({ id: pr.id }))).status).toBe(200);
    expect((await project.GET(req("GET"), p({ id: pr.id }))).status).toBe(404);
  });

  it("asks for step-up before deleting a project when 2FA is on", async () => {
    const pr = await newProject("StepUp");
    signInAs("admin", { totpEnabled: true });
    const r = await json(await project.DELETE(req("DELETE"), p({ id: pr.id })));
    expect(r.status).toBe(403);
    expect(r.body.stepUpRequired).toBe(true);
  });
});

describe("apps", () => {
  it("creates an image app with a secret and never returns the secret", async () => {
    const pr = await newProject("Apps1");
    const id = await newApp(pr.environments[0].id, { env: [{ key: "A", value: "1" }, { key: "TOKEN", kind: "secret", value: "tok-123456" }] });
    const r = await json(await appRoute.GET(req("GET"), p({ id })));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("tok-123456");
    expect(r.body.env).toEqual([{ key: "A", kind: "plain", value: "1" }, { key: "TOKEN", kind: "secret", value: null, hasValue: true }]);
    expect(r.body.can).toEqual({ deploy: true, manage: true, secrets: true, logs: true, containerLogs: true, console: true });
    expect(r.body.containers).toBeNull();
    const stored = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(stored.env).not.toContain("tok-123456");
  });

  it("validates create input", async () => {
    const pr = await newProject("Apps2");
    const envId = pr.environments[0].id;
    expect((await apps.POST(req("POST", { environmentId: "bad", name: "x", image: "y" }))).status).toBe(404);
    expect((await apps.POST(req("POST", { environmentId: envId, name: "x", image: "-y" }))).status).toBe(400);
    expect((await apps.POST(req("POST", { environmentId: envId, name: "x", image: "y", endpointId: "cmissing0000000000000000x" }))).status).toBe(400);
    await newApp(envId, { name: "same" });
    const dup = await json(await apps.POST(req("POST", { environmentId: envId, name: "same", image: "y" })));
    expect(dup.status).toBe(409);
    signInAs("operator");
    expect((await apps.POST(req("POST", { environmentId: envId, name: "op", image: "y" }))).status).toBe(403);
  });

  it("updates settings, keeps secrets and guards env changes", async () => {
    const pr = await newProject("Apps3");
    const id = await newApp(pr.environments[0].id, { env: [{ key: "S", kind: "secret", value: "keep-me-1" }] });
    const r = await json(await appRoute.PATCH(req("PATCH", { image: "nginx:2", env: [{ key: "S", kind: "secret", value: null }, { key: "B", value: "2" }] }), p({ id })));
    expect(r.status).toBe(200);
    const stored = await prisma.application.findUniqueOrThrow({ where: { id } });
    expect(stored.image).toBe("nginx:2");
    const env = JSON.parse(stored.env);
    expect(decryptSecret(env[0].value)).toBe("keep-me-1");
    expect((await appRoute.PATCH(req("PATCH", { slug: "other" }), p({ id }))).status).toBe(400);
    expect((await appRoute.PATCH(req("PATCH", { image: "-x" }), p({ id }))).status).toBe(400);
    // An operator binding can't touch the app config at all
    signInAs("operator");
    expect((await appRoute.PATCH(req("PATCH", { image: "a" }), p({ id }))).status).toBe(403);
    expect((await appRoute.GET(req("GET"), p({ id: "cmissing0000000000000000x" }))).status).toBe(404);
  });

  it("reveals a secret with step-up and audits it", async () => {
    const pr = await newProject("Apps4");
    const id = await newApp(pr.environments[0].id, { env: [{ key: "S", kind: "secret", value: "shh-1234" }] });
    const r = await json(await envRoute.POST(req("POST", { key: "S" }), p({ id })));
    expect(r.body).toEqual({ key: "S", value: "shh-1234" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "secret.reveal" }));
    expect((await envRoute.POST(req("POST", { key: "NOPE" }), p({ id }))).status).toBe(404);
    signInAs("admin", { totpEnabled: true });
    expect((await envRoute.POST(req("POST", { key: "S" }), p({ id }))).status).toBe(403);
    signInAs("operator");
    expect((await envRoute.POST(req("POST", { key: "S" }), p({ id }))).status).toBe(403);
  });

  it("deletes an app and its containers", async () => {
    const pr = await newProject("Apps5");
    const id = await newApp(pr.environments[0].id);
    expect((await project.DELETE(req("DELETE"), p({ id: pr.id }))).status).toBe(409);
    vi.mocked(teardownApplication).mockRejectedValueOnce(new Error("daemon down"));
    expect((await appRoute.DELETE(req("DELETE", {}), p({ id }))).status).toBe(502);
    expect((await appRoute.DELETE(req("DELETE", {}), p({ id }))).status).toBe(200);
    expect(teardownApplication).toHaveBeenCalledTimes(2);
    expect(await prisma.application.findUnique({ where: { id } })).toBeNull();
  });

  it("keeps containers when asked and refuses while deploying", async () => {
    const pr = await newProject("Apps6");
    const id = await newApp(pr.environments[0].id);
    const dep = await prisma.deployment.create({ data: { applicationId: id, trigger: "manual", status: "running" } });
    expect((await appRoute.DELETE(req("DELETE", {}), p({ id }))).status).toBe(409);
    await prisma.deployment.update({ where: { id: dep.id }, data: { status: "failed" } });
    expect((await appRoute.DELETE(req("DELETE", { keepContainers: true }), p({ id }))).status).toBe(200);
    expect(teardownApplication).not.toHaveBeenCalled();
  });
});

describe("deployments", () => {
  it("queues one deployment at a time", async () => {
    const pr = await newProject("Dep1");
    const id = await newApp(pr.environments[0].id);
    signInAs("operator");
    const r = await json(await deploy.POST(req("POST", {}), p({ id })));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("queued");
    expect(await prisma.job.count({ where: { type: "deploy" } })).toBeGreaterThan(0);
    expect((await deploy.POST(req("POST", {}), p({ id }))).status).toBe(409);
    expect((await deploy.POST(req("POST", { commitSha: "abc1234" }), p({ id }))).status).toBe(400);
    signInAs("viewer");
    expect((await deploy.POST(req("POST", {}), p({ id }))).status).toBe(403);

    const list = await json(await deployments.GET(req("GET"), p({ id })));
    expect(list.body).toHaveLength(1);
    const one = await json(await deployment.GET(req("GET", undefined, "http://dn.local/x?offset=0"), p({ id, depId: r.body.id })));
    expect(one.body.log).toBe("");

    signInAs("operator");
    const c = await json(await deployment.POST(req("POST", { action: "cancel" }), p({ id, depId: r.body.id })));
    expect(c.body.result).toBe("cancelled");
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe("cancelled");
  });

  it("rolls back to a successful deployment only", async () => {
    const pr = await newProject("Dep2");
    const id = await newApp(pr.environments[0].id);
    signInAs("operator");
    const good = await prisma.deployment.create({ data: { applicationId: id, trigger: "manual", status: "success" } });
    const bad = await prisma.deployment.create({ data: { applicationId: id, trigger: "manual", status: "failed" } });
    expect((await deployment.POST(req("POST", { action: "rollback" }), p({ id, depId: bad.id }))).status).toBe(400);
    expect((await deployment.POST(req("POST", { action: "explode" }), p({ id, depId: good.id }))).status).toBe(400);
    const r = await json(await deployment.POST(req("POST", { action: "rollback" }), p({ id, depId: good.id })));
    expect(r.status).toBe(202);
    expect(r.body.trigger).toBe("rollback");
    expect((await deployment.POST(req("POST", { action: "redeploy" }), p({ id, depId: good.id }))).status).toBe(409);
    expect((await deployment.GET(req("GET"), p({ id, depId: "cmissing0000000000000000x" }))).status).toBe(404);
  });
});

describe("domains", () => {
  it("needs the edge proxy, then adds and removes a domain", async () => {
    const pr = await newProject("Dom1");
    const id = await newApp(pr.environments[0].id);
    expect((await domains.POST(req("POST", { host: "a.example.com", containerPort: 80 }), p({ id }))).status).toBe(409);
    const proxied = await newApp(pr.environments[0].id, { name: "edge-web", endpointId: proxyEndpointId });
    const r = await json(await domains.POST(req("POST", { host: "A.example.com", containerPort: 80 }), p({ id: proxied })));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ host: "a.example.com", path: "/", https: true, redeployNeeded: true });
    expect((await domains.POST(req("POST", { host: "a.example.com", containerPort: 80 }), p({ id: proxied }))).status).toBe(409);
    expect((await domains.POST(req("POST", { host: "bad host", containerPort: 80 }), p({ id: proxied }))).status).toBe(400);
    expect((await domains.POST(req("POST", { host: "b.example.com", containerPort: 0 }), p({ id: proxied }))).status).toBe(400);
    expect((await domains.POST(req("POST", { host: "b.example.com", containerPort: 80, service: "bad name" }), p({ id: proxied }))).status).toBe(400);
    const del = (domainId: string) => domains.DELETE(req("DELETE", undefined, `http://dn.local/x?domainId=${domainId}`), p({ id: proxied }));
    expect((await del(r.body.id)).status).toBe(200);
    expect((await del(r.body.id)).status).toBe(404);
    expect((await del("bad")).status).toBe(404);
  });
});

describe("GitHub webhook", () => {
  async function gitApp(updatePolicy = "on-push") {
    const pr = await newProject(`Hook ${Math.random().toString(36).slice(2, 8)}`);
    return newApp(pr.environments[0].id, { sourceType: "git-dockerfile", image: "", gitRepo: "https://github.com/org/app", gitBranch: "main", updatePolicy });
  }
  const send = (appId: string, secret: string, event: string, payload: unknown) => {
    const body = JSON.stringify(payload);
    const sig = "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
    return github.POST(new Request("http://dn.local/api/webhooks/github/" + appId, { method: "POST", body, headers: { "x-hub-signature-256": sig, "x-github-event": event } }), p({ appId }));
  };

  it("reveals and rotates the secret with step-up", async () => {
    const id = await gitApp();
    const r = await json(await webhook.GET(req("GET"), p({ id })));
    expect(r.body.url).toBe(`https://localhost:9444/api/webhooks/github/${id}`);
    const rotated = await json(await webhook.POST(req("POST"), p({ id })));
    expect(rotated.body.secret).not.toBe(r.body.secret);
    signInAs("admin", { totpEnabled: true });
    expect((await webhook.GET(req("GET"), p({ id }))).status).toBe(403);
  });

  it("deploys a signed push to the tracked branch", async () => {
    const id = await gitApp();
    const { secret } = (await json(await webhook.GET(req("GET"), p({ id })))).body;
    signOut();
    const sha = "a".repeat(40);
    expect((await json(await send(id, secret, "ping", {}))).body.message).toBe("pong");
    expect((await json(await send(id, secret, "issues", {}))).body.ignored).toMatch(/event/);
    expect((await json(await send(id, secret, "push", { ref: "refs/heads/dev", after: sha }))).body.ignored).toMatch(/not main/);
    expect((await json(await send(id, secret, "push", { ref: "refs/heads/main", after: "0".repeat(40) }))).body.ignored).toBe("no commit");
    const r = await json(await send(id, secret, "push", { ref: "refs/heads/main", after: sha, head_commit: { message: "Fix it\n\nbody" } }));
    expect(r.status).toBe(202);
    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: r.body.deploymentId } });
    expect(dep).toMatchObject({ trigger: "push", commitSha: sha, commitMessage: "Fix it" });
    expect((await json(await send(id, secret, "push", { ref: "refs/heads/main", after: sha }))).body.ignored).toMatch(/already queued/);
  });

  it("rejects bad signatures and unknown apps the same way", async () => {
    const id = await gitApp();
    expect((await send(id, "wrong", "push", {})).status).toBe(401);
    expect((await send("cmissing0000000000000000x", "x", "push", {})).status).toBe(401);
    expect((await send("bad", "x", "push", {})).status).toBe(401);
  });

  it("ignores pushes when auto-deploy is off", async () => {
    const id = await gitApp("manual");
    const { secret } = (await json(await webhook.GET(req("GET"), p({ id })))).body;
    expect((await json(await send(id, secret, "push", { ref: "refs/heads/main", after: "b".repeat(40) }))).body.ignored).toMatch(/off/);
  });
});
