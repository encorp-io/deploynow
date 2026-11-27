/**
 * Usage summaries (per service, per app, hosts) and the routes that serve them:
 * the project usage, Monitoring usage and Overview endpoints. Real SQLite, no Docker.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-usage-"));
  process.env.DATABASE_URL = `file:${d}/u.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/endpoints", async (orig) => ({ ...(await orig<typeof import("@/lib/endpoints")>()), dockerFor: vi.fn(() => ({})) }));

import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import * as cm from "@/lib/containerMetrics";
import { appsOf, baseKey, downsample, hostTrends, servicesOf, unmanagedOf, type History } from "@/lib/usageSummary";
import * as projectUsage from "@/app/api/projects/[id]/usage/route";
import * as monitoringUsage from "@/app/api/monitoring/usage/route";
import * as overview from "@/app/api/overview/route";
import * as monitoring from "@/app/api/monitoring/route";

const MIN = 60_000;
const HOUR = 3600_000;
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

let endpointId = "";
let otherEndpointId = "";
let appId = "";
let projectId = "";
let hiddenAppId = "";

function raw(over: Partial<cm.RawSample> & { at: number }): cm.RawSample {
  return { containerId: "c1", containerName: "web-1", applicationId: "", service: "", replica: 1, cpuNs: 0, memUsage: 100, memLimit: 1000, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, pids: 3, ...over };
}

/** Five minutes of samples for one container: `cpu` % of a core and `mem` bytes. */
async function run(endpoint: string, o: { id: string; name: string; app?: string; service?: string; replica?: number; cpu: number; mem: number; from?: number }) {
  const t = o.from ?? Date.now() - 5 * MIN;
  for (let i = 0; i < 5; i++) {
    await cm.storeSample(endpoint, raw({ containerId: o.id, containerName: o.name, applicationId: o.app ?? "", service: o.service ?? "", replica: o.replica ?? 1, at: t + i * MIN, cpuNs: i * (o.cpu / 100) * 60e9, memUsage: o.mem, netRx: i * 6000 }));
  }
}

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  endpointId = (await prisma.endpoint.create({ data: { name: "host-a", type: "socket", host: "/x.sock", status: "online", containers: 4, hostMetrics: JSON.stringify({ cpus: 4, load1: 2, load5: 1, memTotal: 8000, memAvailable: 2000, diskPath: "/", diskTotal: 100, diskFree: 40 }), hostMetricsAt: new Date() } })).id;
  otherEndpointId = (await prisma.endpoint.create({ data: { name: "host-b", type: "agent", host: "", status: "offline" } })).id;
  const project = await prisma.project.create({ data: { name: "Shop", slug: "shop" } });
  projectId = project.id;
  const env = await prisma.environment.create({ data: { projectId: project.id, name: "production", slug: "production" } });
  appId = (await prisma.application.create({ data: { environmentId: env.id, endpointId, name: "Storefront", slug: "storefront", sourceType: "compose", status: "running" } })).id;
  const secret = await prisma.project.create({ data: { name: "Secret", slug: "secret" } });
  const senv = await prisma.environment.create({ data: { projectId: secret.id, name: "production", slug: "production" } });
  hiddenAppId = (await prisma.application.create({ data: { environmentId: senv.id, endpointId, name: "Hidden", slug: "hidden", sourceType: "image", status: "running" } })).id;
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.containerSample.deleteMany();
  await prisma.containerUsageHourly.deleteMany();
  await prisma.metricSample.deleteMany();
  cm.resetCollectorState();
  signInAs("viewer");
});

describe("helpers", () => {
  it("strips the replica suffix and downsamples by averaging", () => {
    expect(baseKey("app:a:web#2")).toBe("app:a:web");
    expect(baseKey("name:postgres")).toBe("name:postgres");
    expect(downsample([1, 2, 3])).toEqual([1, 2, 3]);
    expect(downsample([1, 3, 5, 7], 2)).toEqual([2, 6]);
  });

  it("works out host and fleet trends, carrying values over gaps", () => {
    const from = 0;
    const s = (endpointId: string, h: number, load1: number, memUsed: number) => ({ endpointId, at: new Date(h * HOUR + 1000), cpus: 4, load1, memTotal: 1000, memUsed });
    const t = hostTrends([s("a", 0, 2, 500), s("a", 2, 4, 1000), s("b", 0, 0, 0), s("b", 1, 2, 500)], from, HOUR, 3);
    expect(t.endpoints.get("a")!.cpu).toEqual([50, 50, 100]); // hour 1 repeats hour 0
    expect(t.endpoints.get("a")!.mem).toEqual([50, 50, 100]);
    expect(t.fleet.cpu).toEqual([25, 50, 75]); // load (2+0, 2+2, 4+2) over 8 cores
    // A host first seen in hour 1 has nothing before it, and the fleet ignores it there
    const late = hostTrends([s("a", 0, 2, 500), s("b", 1, 4, 1000)], from, HOUR, 3);
    expect(late.endpoints.get("b")!.cpu).toEqual([0, 100, 100]);
    expect(late.fleet.cpu).toEqual([50, 75, 75]);
  });
});

describe("grouping", () => {
  it("adds up replicas per service and services per app, and keeps other containers apart", async () => {
    await run(endpointId, { id: "w1", name: "storefront-web-1", app: appId, service: "web", cpu: 20, mem: 300 });
    await run(endpointId, { id: "w2", name: "storefront-web-2", app: appId, service: "web", replica: 2, cpu: 10, mem: 200 });
    await run(endpointId, { id: "d", name: "storefront-db-1", app: appId, service: "db", cpu: 5, mem: 1000 });
    await run(endpointId, { id: "pg", name: "postgres", cpu: 1, mem: 50 });
    const h = (await cm.readHistory({}, "1h")) as History;

    const services = servicesOf({ ...h, series: h.series.filter((s) => s.key.startsWith("app:")) });
    const web = services.find((s) => s.service === "web")!;
    expect(web.replicas).toBe(2);
    expect(web.now!.cpu).toBeCloseTo(30, 0);
    expect(web.now!.mem).toBe(500);
    expect(web.now!.rx).toBe(200); // 100 B/s per replica
    expect(services[0].service).toBe("web"); // busiest first

    const app = appsOf(h).get(appId)!;
    expect(app.services).toHaveLength(2);
    expect(app.now!.cpu).toBeCloseTo(35, 0);
    expect(app.now!.mem).toBe(1500);
    expect(app.avg.cpu).toBeGreaterThan(0);
    expect(app.trend.length).toBeGreaterThan(1);

    const other = unmanagedOf(h);
    expect(other.map((s) => s.container)).toEqual(["postgres"]);
  });

  it("marks a service that stopped as not running but keeps its last sighting", async () => {
    await run(endpointId, { id: "old", name: "storefront-worker-1", app: appId, service: "worker", cpu: 10, mem: 100, from: Date.now() - 40 * MIN });
    const app = appsOf((await cm.readHistory({ applicationId: appId }, "1h")) as History).get(appId)!;
    expect(app.now).toBeNull();
    expect(app.services[0].now).toBeNull();
    expect(app.services[0].lastSeen).toBeTruthy();
    expect(app.avg.mem).toBe(100);
  });
});

describe("routes", () => {
  it("serves the project's usage per app", async () => {
    await run(endpointId, { id: "w1", name: "storefront-web-1", app: appId, service: "web", cpu: 20, mem: 300 });
    const res = await projectUsage.GET(new Request("http://dn.local/x"), p({ id: projectId }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apps[appId].services[0].service).toBe("web");
    expect(body.apps[appId].now.mem).toBe(300);
    signOut();
    expect((await projectUsage.GET(new Request("http://dn.local/x"), p({ id: projectId }))).status).toBe(401);
  });

  it("lists app usage in Monitoring, busiest first, with other containers", async () => {
    await run(endpointId, { id: "w1", name: "storefront-web-1", app: appId, service: "web", cpu: 20, mem: 300 });
    await run(endpointId, { id: "h", name: "hidden", app: hiddenAppId, service: "", cpu: 50, mem: 10 });
    await run(endpointId, { id: "pg", name: "postgres", cpu: 1, mem: 50 });
    const ranged = await (await monitoringUsage.GET(new Request("http://dn.local/x?range=24h"))).json();
    expect(ranged.range).toBe("24h");

    signInAs("viewer");
    const all = await (await monitoringUsage.GET(new Request("http://dn.local/x"))).json();
    expect(all.range).toBe("1h");
    expect(all.apps.map((a: { name: string }) => a.name)).toEqual(["Hidden", "Storefront"]); // busiest first
    expect(all.unmanaged[0]).toMatchObject({ container: "postgres", endpointName: "host-a" });
    signOut();
    expect((await monitoringUsage.GET(new Request("http://dn.local/x"))).status).toBe(401);
  });

  it("builds the overview: machines, apps, busiest apps and trends", async () => {
    await run(endpointId, { id: "w1", name: "storefront-web-1", app: appId, service: "web", cpu: 20, mem: 300 });
    await prisma.metricSample.create({ data: { endpointId, at: new Date(Date.now() - 30 * MIN), cpus: 4, load1: 1, memTotal: 8000, memUsed: 4000 } });
    const project = await prisma.application.findUniqueOrThrow({ where: { id: appId }, select: { id: true } });
    await prisma.deployment.create({ data: { applicationId: project.id, trigger: "manual", status: "success", finishedAt: new Date() } });

    const res = await overview.GET();
    expect(res.status).toBe(200);
    const o = await res.json();
    expect(o.fleet).toMatchObject({ online: 1, total: 2, containers: 4, cpu: 50, memUsed: 6000, memTotal: 8000 });
    expect(o.fleet.cpuTrend).toHaveLength(24);
    expect(o.fleet.cpuTrend.at(-1)).toBe(25);
    expect(o.machines.map((m: { name: string }) => m.name)).toEqual(["host-a", "host-b"]);
    expect(o.machines[0]).toMatchObject({ cpu: 50, mem: 75, disk: 60 });
    expect(o.apps).toMatchObject({ total: 2, projects: 2 });
    expect(o.topApps[0]).toMatchObject({ name: "Storefront", services: 1 });
    expect(o.deployments[0]).toMatchObject({ status: "success", app: { name: "Storefront" } });
    expect(o.backups).toBeNull(); // viewers do not see backups
    expect(o.log).toBeNull(); // nor deployment logs

    signInAs("operator");
    const op = await (await overview.GET()).json();
    expect(op.backups).toMatchObject({ last: null, ok7d: 0 });
    expect(op.log).toMatchObject({ lines: [] });

    // A snapshot from a machine that stopped reporting is not current usage
    await prisma.endpoint.update({ where: { id: endpointId }, data: { hostMetricsAt: new Date(Date.now() - HOUR) } });
    const stale = await (await overview.GET()).json();
    expect(stale.machines[0]).toMatchObject({ cpu: null, mem: null });
    expect(stale.fleet).toMatchObject({ cpu: null, memTotal: 0 });
    await prisma.endpoint.update({ where: { id: endpointId }, data: { hostMetricsAt: new Date() } });
  });

  it("adds 24-hour trends to the monitoring hosts", async () => {
    await prisma.metricSample.create({ data: { endpointId, at: new Date(Date.now() - 10 * MIN), cpus: 4, load1: 2, memTotal: 8000, memUsed: 2000 } });
    const m = await (await monitoring.GET()).json();
    const a = m.endpoints.find((e: { id: string }) => e.id === endpointId);
    expect(a.trend.cpu.at(-1)).toBe(50);
    expect(a.trend.mem.at(-1)).toBe(25);
    expect(m.fleet.cpu).toHaveLength(24);
    expect(otherEndpointId).toBeTruthy();
  });
});
