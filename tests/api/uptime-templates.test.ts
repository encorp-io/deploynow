/** Uptime checks, the public status page and creating apps from templates. */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-uptime-"));
  process.env.DATABASE_URL = `file:${d}/api.db`;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), clientIp: () => "1.2.3.4" }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }));
vi.mock("@/lib/jobs", () => ({ enqueueDeploy: vi.fn(async () => ({ id: "cdep00000000000000000000001" })), DeployBusyError: class extends Error {} }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import { notify } from "@/lib/notify";
import { enqueueDeploy } from "@/lib/jobs";
import { checkCertificate, daySeries, formatDuration, recordResult, runDueChecks, uptimePercent, validateCheck } from "@/lib/uptime";
import { decryptSecret, encryptSecret } from "@/lib/secretsCrypto";
import * as uptime from "@/app/api/uptime/route";
import * as check from "@/app/api/uptime/[id]/route";
import * as run from "@/app/api/uptime/[id]/run/route";
import * as statusPage from "@/app/api/uptime/status-page/route";
import * as status from "@/app/api/status/route";
import * as templates from "@/app/api/templates/route";

const req = (method: string, body?: unknown, url = "http://dn.local/x") => new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

let server: http.Server;
let base = "";
let healthy = true;

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  server = http.createServer((q, s) => {
    if (q.url === "/kw") return s.end("hello deploynow");
    s.statusCode = healthy ? 200 : 503;
    s.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  server.close();
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  signOut();
  healthy = true;
});

describe("validateCheck", () => {
  it("normalizes and rejects targets", () => {
    expect(validateCheck({ name: "a", target: "example.com" }).target).toBe("https://example.com/");
    expect(validateCheck({ name: "a", type: "tcp", target: "db.local:5432" })).toMatchObject({ target: "db.local:5432", certWarnDays: 0, keyword: "" });
    expect(() => validateCheck({ name: "a", type: "tcp", target: "db.local" })).toThrow(/host:port/);
    expect(() => validateCheck({ name: "a", target: "ftp://x" })).toThrow(/http/);
    expect(() => validateCheck({ name: "a", target: "https://x.com", intervalSec: 5 })).toThrow(/interval/);
    expect(() => validateCheck({ name: "a", target: "https://x.com", expectStatus: "ok" })).toThrow(/status/);
    expect(() => validateCheck({ name: "", target: "https://x.com" })).toThrow(/name/);
  });

  it("summarizes days", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const s = daySeries([{ day: "2026-11-23", total: 4, up: 3, latencySum: 300 }], 3, now);
    expect(s.map((d) => d.day)).toEqual(["2026-11-21", "2026-11-22", "2026-11-23"]);
    expect(s[2]).toEqual({ day: "2026-11-23", total: 4, up: 3, avgLatencyMs: 100 });
    expect(uptimePercent(s)).toBe(75);
    expect(uptimePercent(s.slice(0, 2))).toBeNull();
    expect(formatDuration(252_000)).toBe("4m 12s");
  });
});

describe("uptime API", () => {
  it("needs an admin to change checks", async () => {
    signInAs("viewer");
    expect((await uptime.GET()).status).toBe(200);
    expect((await uptime.POST(req("POST", { name: "x", target: base }))).status).toBe(403);
  });

  it("checks a URL, goes down after the threshold, comes back up and notifies once each way", async () => {
    signInAs("admin");
    const created = await json(await uptime.POST(req("POST", { name: "Shop", target: `${base}/`, failThreshold: 2, public: true })));
    expect(created.status).toBe(201);
    const id = created.body.id;

    let r = await json(await run.POST(req("POST"), p(id)));
    expect(r.body).toMatchObject({ status: "up", lastError: "" });
    expect(r.body.lastLatencyMs).toBeGreaterThanOrEqual(0);

    healthy = false;
    r = await json(await run.POST(req("POST"), p(id)));
    expect(r.body).toMatchObject({ status: "up", consecutiveFails: 1, lastError: "Answered 503" });
    expect(notify).not.toHaveBeenCalled();
    r = await json(await run.POST(req("POST"), p(id)));
    expect(r.body.status).toBe("down");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "uptime.down", title: "Shop is down" }));
    await run.POST(req("POST"), p(id));
    expect(notify).toHaveBeenCalledTimes(1);

    healthy = true;
    r = await json(await run.POST(req("POST"), p(id)));
    expect(r.body.status).toBe("up");
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ event: "uptime.up", title: "Shop is up again" }));

    const d = await json(await check.GET(req("GET", undefined, "http://dn.local/x?range=1h"), p(id)));
    expect(d.body.results).toHaveLength(5);
    expect(d.body.stats.uptime).toBe(40);
    expect(d.body.incidents).toHaveLength(1);
    expect(d.body.incidents[0].endedAt).not.toBeNull();
    const list = await json(await uptime.GET());
    expect(list.body.checks[0].uptime7d).toBe(40);
  });

  it("checks keywords, expected status and TCP ports", async () => {
    signInAs("admin");
    const kw = (await json(await uptime.POST(req("POST", { name: "kw", target: `${base}/kw`, keyword: "missing" })))).body.id;
    expect((await json(await run.POST(req("POST"), p(kw)))).body.lastError).toMatch(/doesn't contain/);
    await check.PATCH(req("PATCH", { keyword: "deploynow", expectStatus: "200" }), p(kw));
    expect((await json(await run.POST(req("POST"), p(kw)))).body.status).toBe("up");

    const port = (server.address() as AddressInfo).port;
    const tcp = (await json(await uptime.POST(req("POST", { name: "tcp", type: "tcp", target: `127.0.0.1:${port}` })))).body.id;
    expect((await json(await run.POST(req("POST"), p(tcp)))).body.status).toBe("up");
    const closed = await new Promise<number>((r) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const pt = (s.address() as AddressInfo).port;
        s.close(() => r(pt));
      });
    });
    await check.PATCH(req("PATCH", { target: `127.0.0.1:${closed}`, failThreshold: 1 }), p(tcp));
    const res = await json(await run.POST(req("POST"), p(tcp)));
    expect(res.body).toMatchObject({ status: "down", lastError: "Connection refused" });
  });

  it("runs due checks on schedule and warns about certificates once", async () => {
    signInAs("admin");
    const id = (await json(await uptime.POST(req("POST", { name: "due", target: `${base}/` })))).body.id;
    await prisma.uptimeCheck.updateMany({ where: { id: { not: id } }, data: { enabled: false } });
    expect(await runDueChecks()).toBe(1);
    expect(await runDueChecks()).toBe(0);

    const c = await prisma.uptimeCheck.update({ where: { id }, data: { target: "https://shop.example.com/", certWarnDays: 14 } });
    const now = new Date();
    const read = vi.fn(async () => new Date(now.getTime() + 3 * 86400_000));
    await checkCertificate(c, now, read);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ event: "uptime.cert" }));
    const again = await prisma.uptimeCheck.findUniqueOrThrow({ where: { id } });
    await checkCertificate({ ...again, certCheckedAt: null }, now, read);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("deletes a check with its history", async () => {
    signInAs("admin");
    const id = (await json(await uptime.POST(req("POST", { name: "gone", target: `${base}/` })))).body.id;
    const c = await prisma.uptimeCheck.findUniqueOrThrow({ where: { id } });
    await recordResult(c, { ok: true, latencyMs: 5, statusCode: 200, error: "" });
    expect((await check.DELETE(req("DELETE"), p(id))).status).toBe(200);
    expect(await prisma.uptimeResult.count({ where: { checkId: id } })).toBe(0);
    expect((await check.GET(req("GET"), p(id))).status).toBe(404);
  });
});

describe("status page", () => {
  it("is off by default and shows only public checks without targets", async () => {
    expect((await status.GET()).status).toBe(404);
    await prisma.uptimeCheck.updateMany({ where: { name: "Shop" }, data: { enabled: true } });
    signInAs("operator");
    expect((await statusPage.PATCH(req("PATCH", { enabled: true }))).status).toBe(403);
    signInAs("admin");
    expect((await json(await statusPage.PATCH(req("PATCH", { enabled: true, title: "Acme status" })))).body).toEqual({ enabled: true, title: "Acme status" });
    signOut();
    const s = await json(await status.GET());
    expect(s.status).toBe(200);
    expect(s.body.title).toBe("Acme status");
    expect(s.body.checks.map((c: { name: string }) => c.name)).toEqual(["Shop"]);
    expect(s.body.checks[0].days).toHaveLength(90);
    expect(JSON.stringify(s.body)).not.toContain("127.0.0.1");
  });
});

describe("templates API", () => {
  let envId = "";
  let edgeId = "";
  let plainId = "";

  beforeAll(async () => {
    const project = await prisma.project.create({ data: { name: "Tpl", slug: "tpl" } });
    plainId = (await prisma.endpoint.create({ data: { name: "plain", type: "socket", host: "/var/run/docker.sock" } })).id;
    edgeId = (await prisma.endpoint.create({ data: { name: "edge", type: "socket", host: "/x.sock", proxyMode: "managed" } })).id;
    envId = (await prisma.environment.create({ data: { projectId: project.id, name: "production", slug: "production", defaultEndpointId: edgeId } })).id;
  });

  it("lists templates without generated secrets", async () => {
    signInAs("viewer");
    const list = await json(await templates.GET());
    expect(list.body.length).toBeGreaterThanOrEqual(20);
    expect(list.body.find((t: { id: string }) => t.id === "n8n").vars.map((v: { key: string }) => v.key)).toEqual(["TZ"]);
  });

  it("creates an app with its domain, secrets and backup policy, then deploys", async () => {
    signInAs("operator");
    expect((await templates.POST(req("POST", { templateId: "n8n", environmentId: envId }))).status).toBe(403);
    signInAs("admin");
    const dest = await prisma.backupDestination.create({ data: { name: "r2", endpointUrl: "https://x.r2.cloudflarestorage.com", bucket: "b", accessKeyId: "a", secretKey: encryptSecret("s") } });
    const r = await json(await templates.POST(req("POST", { templateId: "n8n", environmentId: envId, name: "Flows", domain: "flows.example.com", values: { TZ: "UTC" }, backupDestinationId: dest.id })));
    expect(r.status).toBe(201);
    const app = await prisma.application.findUniqueOrThrow({ where: { id: r.body.id }, include: { domains: true } });
    expect(app).toMatchObject({ sourceType: "compose", slug: "flows", endpointId: edgeId });
    expect(app.domains).toEqual([expect.objectContaining({ host: "flows.example.com", containerPort: 5678, service: "n8n", https: true })]);
    const env = JSON.parse(app.env) as { key: string; kind: string; value: string }[];
    expect(env.find((e) => e.key === "TZ")?.value).toBe("UTC");
    const pw = env.find((e) => e.key === "DB_PASSWORD")!;
    expect(pw.kind).toBe("secret");
    expect(decryptSecret(pw.value)).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(enqueueDeploy).toHaveBeenCalledWith(app.id, expect.objectContaining({ trigger: "manual" }));
    {
      const policy = await prisma.backupPolicy.findUniqueOrThrow({ where: { id: r.body.backupPolicyId } });
      expect(JSON.parse(policy.sources)).toEqual([
        { type: "db", engine: "postgres", container: "flows-db-1", database: "n8n" },
        { type: "volume", name: "flows_data" },
      ]);
      expect(policy.mode).toBe("dump");
    }
  });

  it("refuses a taken name or domain and a domain without the edge proxy", async () => {
    signInAs("admin");
    expect((await templates.POST(req("POST", { templateId: "n8n", environmentId: envId, name: "Flows" }))).status).toBe(409);
    expect((await templates.POST(req("POST", { templateId: "grafana", environmentId: envId, domain: "flows.example.com" }))).status).toBe(409);
    expect((await templates.POST(req("POST", { templateId: "grafana", environmentId: envId, endpointId: plainId, domain: "g.example.com" }))).status).toBe(409);
    const ok = await json(await templates.POST(req("POST", { templateId: "postgres", environmentId: envId, endpointId: plainId, hostPort: 15432, deploy: false })));
    expect(ok.status).toBe(201);
    expect(enqueueDeploy).not.toHaveBeenCalled();
    const app = await prisma.application.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(app.composeInline).toContain("15432:5432");
    expect((await templates.POST(req("POST", { templateId: "nope", environmentId: envId }))).status).toBe(400);
  });
});
