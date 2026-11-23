/**
 * Container resource history and the Prometheus endpoint, against a real
 * SQLite database. Docker is a fake.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";

const dir = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const d = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "dn-cmetrics-"));
  process.env.DATABASE_URL = `file:${d}/m.db`;
  process.env.DEPLOYNOW_DATA_DIR = d;
  return d as string;
});

vi.mock("@/lib/apiAuth", () => import("../helpers/apiAuthMock"));
vi.mock("@/lib/endpoints", async (orig) => ({ ...(await orig<typeof import("@/lib/endpoints")>()), dockerFor: vi.fn(() => ({})) }));

import type Docker from "dockerode";
import { signInAs, signOut } from "../helpers/apiAuthMock";
import { prisma } from "@/lib/prisma";
import * as cm from "@/lib/containerMetrics";
import { escapeLabel, render } from "@/lib/prometheus";
import * as metricsRoute from "@/app/api/metrics/route";
import * as appMetrics from "@/app/api/apps/[id]/metrics/route";
import * as containerMetricsRoute from "@/app/api/endpoints/[id]/containers/[cid]/metrics/route";
import * as usageRoute from "@/app/api/endpoints/[id]/container-usage/route";

const MIN = 60_000;
const HOUR = 3600_000;
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

let endpointId = "";
let appId = "";

function raw(over: Partial<cm.RawSample> & { at: number }): cm.RawSample {
  return { containerId: "c1", containerName: "web-1", applicationId: "", service: "", replica: 1, cpuNs: 0, memUsage: 100, memLimit: 1000, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0, pids: 3, ...over };
}

beforeAll(async () => {
  execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
  endpointId = (await prisma.endpoint.create({ data: { name: "host-a", type: "socket", host: "/x.sock", status: "online" } })).id;
  const project = await prisma.project.create({ data: { name: "Shop", slug: "shop" } });
  const env = await prisma.environment.create({ data: { projectId: project.id, name: "production", slug: "production" } });
  appId = (await prisma.application.create({ data: { environmentId: env.id, endpointId, name: "Storefront", slug: "storefront", sourceType: "compose", status: "running" } })).id;
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.containerSample.deleteMany();
  await prisma.containerUsageHourly.deleteMany();
  cm.resetCollectorState();
  signInAs("viewer");
});

describe("interval maths", () => {
  it("works out CPU % from CPU time and handles counter resets", () => {
    const prev = { at: 0, cpuNs: 0, netRx: 1000, netTx: 0, blkRead: 0, blkWrite: 0 };
    const iv = cm.intervalValues(raw({ at: 60_000, cpuNs: 30e9, netRx: 3000 }), prev);
    expect(iv.seconds).toBe(60);
    expect(iv.cpuPercent).toBe(50);
    expect(iv.netRx).toBe(2000);
    // Restarted container: the counter starts again from zero
    expect(cm.intervalValues(raw({ at: 60_000, netRx: 500 }), prev).netRx).toBe(500);
    expect(cm.intervalValues(raw({ at: 60_000 }), undefined).seconds).toBe(0);
    expect(cm.intervalValues(raw({ at: 3600_000 }), prev).seconds).toBe(0); // too far apart
  });

  it("keys app containers by app and service, others by name", () => {
    expect(cm.seriesKey("app1", "web", "x-web-1")).toBe("app:app1:web");
    expect(cm.seriesKey("app1", "", "app1-dep2")).toBe("app:app1:app");
    expect(cm.seriesKey("", "", "postgres")).toBe("name:postgres");
    expect(cm.seriesKey("app1", "web", "x-web-2", 2)).toBe("app:app1:web#2");
  });
});

describe("storing, rolling up and reading", () => {
  it("stores interval values from consecutive samples", async () => {
    const t = Date.now() - 2 * MIN;
    await cm.storeSample(endpointId, raw({ at: t, cpuNs: 0, netRx: 0 }));
    await cm.storeSample(endpointId, raw({ at: t + MIN, cpuNs: 6e9, netRx: 6000, blkWrite: 1200 }));
    const rows = await prisma.containerSample.findMany({ orderBy: { at: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].seconds).toBe(0);
    expect(rows[1]).toMatchObject({ seconds: 60, cpuPercent: 10, netRx: 6000, blkWrite: 1200, cpuSecondsTotal: 6, key: "name:web-1" });
  });

  it("picks up the previous sample from the database after a restart", async () => {
    const t = Date.now() - 2 * MIN;
    await cm.storeSample(endpointId, raw({ at: t, cpuNs: 1e9 }));
    cm.resetCollectorState();
    await cm.storeSample(endpointId, raw({ at: t + MIN, cpuNs: 4e9 }));
    const last = await prisma.containerSample.findFirst({ orderBy: { at: "desc" } });
    expect(last?.cpuPercent).toBe(5);
  });

  it("charts raw samples for short ranges, grouped by service, and sums totals", async () => {
    const t = Date.now() - 10 * MIN;
    for (let i = 0; i < 5; i++) {
      await cm.storeSample(endpointId, raw({ containerId: "w", containerName: "storefront-web-1", applicationId: appId, service: "web", at: t + i * MIN, cpuNs: i * 12e9, netRx: i * 600, memUsage: 100 + i }));
      await cm.storeSample(endpointId, raw({ containerId: "d", containerName: "storefront-db-1", applicationId: appId, service: "db", at: t + i * MIN, cpuNs: i * 6e9 }));
    }
    const h = await cm.readHistory({ applicationId: appId }, "1h");
    expect(h.series.map((s) => s.service)).toEqual(["db", "web"]);
    const web = h.series.find((s) => s.service === "web")!;
    expect(web.summary.cpuAvg).toBe(20);
    expect(web.summary.netRx).toBe(2400);
    expect(web.summary.memMax).toBe(104);
    expect(web.points.length).toBeGreaterThanOrEqual(4);
    expect(web.points.at(-1)!.rx).toBe(10); // 600 bytes over 60 s
  });

  it("rolls up hours, reads 7 days from the rollups plus the current hour, and prunes", async () => {
    const now = Date.now();
    const hourAgo = Math.floor(now / HOUR) * HOUR - HOUR;
    for (let i = 0; i < 4; i++) await cm.storeSample(endpointId, raw({ containerName: "redis", at: hourAgo + i * 10 * MIN, cpuNs: i * 60e9, memUsage: 200 * (i + 1) }));
    const n = await cm.rollup(hourAgo, hourAgo + HOUR);
    expect(n).toBe(1);
    const row = await prisma.containerUsageHourly.findFirst();
    // 60 s of CPU over each 600 s interval = 10%
    // The first sample has no interval, so three 600 s intervals are covered
    expect(row).toMatchObject({ key: "name:redis", samples: 4, seconds: 1800, cpuAvg: 10, cpuMax: 10, memAvg: 500, memMax: 800 });
    // Idempotent
    await cm.rollup(hourAgo, hourAgo + HOUR);
    expect(await prisma.containerUsageHourly.count()).toBe(1);

    const h = await cm.readHistory({ endpointId, key: "name:redis" }, "7d", now);
    expect(h.series).toHaveLength(1);
    expect(h.series[0].summary.memMax).toBe(800);

    // An old rollup and an old raw sample are pruned
    await prisma.containerUsageHourly.create({ data: { endpointId, key: "name:old", containerName: "old", hour: new Date(now - 400 * 24 * HOUR) } });
    await prisma.containerSample.create({ data: { endpointId, key: "name:old", containerId: "o", containerName: "old", at: new Date(now - 2 * 24 * HOUR) } });
    await cm.prune(now);
    expect(await prisma.containerUsageHourly.count({ where: { key: "name:old" } })).toBe(0);
    expect(await prisma.containerSample.count({ where: { key: "name:old" } })).toBe(0);
  });

  it("collects from Docker, maps compose containers to their app and skips helpers", async () => {
    const stats = (cpu: number) => ({ cpu_stats: { cpu_usage: { total_usage: cpu }, online_cpus: 2 }, memory_stats: { usage: 5000, limit: 10000, stats: { inactive_file: 1000 } }, networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } }, blkio_stats: { io_service_bytes_recursive: [{ op: "Read", value: 7 }] }, pids_stats: { current: 4 } });
    const docker = {
      listContainers: vi.fn(async () => [
        { Id: "aaa", Names: ["/storefront-web-1"], Labels: { "com.docker.compose.project": "storefront", "com.docker.compose.service": "web" } },
        { Id: "ccc", Names: ["/storefront-web-2"], Labels: { "com.docker.compose.project": "storefront", "com.docker.compose.service": "web", "com.docker.compose.container-number": "2" } },
        { Id: "bbb", Names: ["/dn-helper"], Labels: { "deploynow.helper": "1" } },
      ]),
      getContainer: vi.fn(() => ({ stats: vi.fn(async () => stats(1e9)) })),
    } as unknown as Docker;
    const e = await prisma.endpoint.findUniqueOrThrow({ where: { id: endpointId } });
    expect(await cm.collectEndpoint(e, docker)).toBe(2);
    expect((await prisma.containerSample.findFirstOrThrow({ where: { containerId: "ccc" } })).key).toBe(`app:${appId}:web#2`);
    const row = await prisma.containerSample.findFirstOrThrow({ where: { containerId: "aaa" } });
    expect(row).toMatchObject({ applicationId: appId, service: "web", key: `app:${appId}:web`, memUsage: 4000, netRxTotal: 10, blkReadTotal: 7, pids: 4 });
  });

  it("maybeRollup builds the finished hours once", async () => {
    const now = Date.now();
    const hourAgo = Math.floor(now / HOUR) * HOUR - HOUR;
    await cm.storeSample(endpointId, raw({ at: hourAgo + MIN }));
    await cm.maybeRollup(now);
    expect(await prisma.containerUsageHourly.count()).toBe(1);
  });
});

describe("toSeries", () => {
  it("averages CPU by time and turns byte counts into rates", () => {
    const u = (at: number, cpu: number, rx: number) => ({ endpointId: "e", key: "k", containerName: "c", service: "", at, seconds: 60, samples: 1, cpuAvg: cpu, cpuMax: cpu, memAvg: 10, memMax: 10, memLimit: 0, netRx: rx, netTx: 0, blkRead: 0, blkWrite: 0 });
    const s = cm.toSeries([u(0, 10, 600), u(60_000, 30, 1200)], 0, 120_000);
    expect(s.points).toHaveLength(1);
    expect(s.points[0]).toMatchObject({ cpu: 20, cpuMax: 30, rx: 15 });
    expect(s.summary).toMatchObject({ cpuAvg: 20, netRx: 1800 });
  });
});

describe("Prometheus", () => {
  it("escapes label values and renders families", () => {
    expect(escapeLabel('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    const out = render([{ name: "x_total", help: "X", type: "counter", samples: [{ labels: { a: "1" }, value: 2 }, { labels: {}, value: NaN }] }]);
    expect(out).toBe('# HELP x_total X\n# TYPE x_total counter\nx_total{a="1"} 2\nx_total NaN\n');
  });

  it("serves container, host, app and alert metrics to a signed-in caller", async () => {
    await prisma.endpoint.update({ where: { id: endpointId }, data: { hostMetrics: JSON.stringify({ cpus: 4, load1: 0.5, load5: 0, memTotal: 8e9, memAvailable: 6e9, diskPath: "/", diskTotal: 1e11, diskFree: 4e10 }), hostMetricsAt: new Date() } });
    await prisma.alert.create({ data: { key: `disk:${endpointId}`, kind: "disk", endpointId, message: "Disk full" } });
    const t = Date.now() - MIN;
    await cm.storeSample(endpointId, raw({ containerId: "w", containerName: "storefront-web-1", applicationId: appId, service: "web", at: t - MIN, cpuNs: 0 }));
    await cm.storeSample(endpointId, raw({ containerId: "w", containerName: "storefront-web-1", applicationId: appId, service: "web", at: t, cpuNs: 12e9, netRx: 123 }));

    const res = await metricsRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    const labels = `endpoint="host-a",container="storefront-web-1",app="Storefront",project="Shop",environment="production",service="web"`;
    expect(body).toContain(`deploynow_container_cpu_usage_seconds_total{${labels}} 12`);
    expect(body).toContain(`deploynow_container_cpu_percent{${labels}} 20`);
    expect(body).toContain(`deploynow_container_network_receive_bytes_total{${labels}} 123`);
    expect(body).toContain(`deploynow_host_memory_used_bytes{endpoint="host-a",endpoint_id="${endpointId}"} 2000000000`);
    expect(body).toContain(`deploynow_endpoint_up{endpoint="host-a",endpoint_id="${endpointId}",type="socket"} 1`);
    expect(body).toContain(`deploynow_app_status{app="Storefront"`);
    expect(body).toContain(`deploynow_alerts_firing{kind="disk"} 1`);
    await prisma.alert.deleteMany();
  });

  it("refuses anonymous scrapes", async () => {
    signOut();
    expect((await metricsRoute.GET()).status).toBe(401);
  });
});

describe("history routes", () => {
  it("serve an app's, a container's and an endpoint's usage", async () => {
    const t = Date.now() - 3 * MIN;
    for (let i = 0; i < 3; i++) await cm.storeSample(endpointId, raw({ containerId: "w123", containerName: "storefront-web-1", applicationId: appId, service: "web", at: t + i * MIN, cpuNs: i * 6e9 }));

    const a = await appMetrics.GET(new Request("http://dn.local/x?range=6h"), p({ id: appId }));
    const ab = await a.json();
    expect(ab.range).toBe("6h");
    expect(ab.series[0].summary.cpuAvg).toBe(10);

    const c = await containerMetricsRoute.GET(new Request("http://dn.local/x?range=bogus"), p({ id: endpointId, cid: "w123" }));
    const cb = await c.json();
    expect(cb.range).toBe("24h");
    expect(cb.series).toHaveLength(1);

    const none = await containerMetricsRoute.GET(new Request("http://dn.local/x"), p({ id: endpointId, cid: "nothing" }));
    expect((await none.json()).series).toEqual([]);

    const u = await usageRoute.GET(new Request("http://dn.local/x"), p({ id: endpointId }));
    const ub = await u.json();
    expect(ub.containers[0]).toMatchObject({ service: "web", app: { id: appId, name: "Storefront" } });
  });

  it("hides an app's usage from someone without access", async () => {
    signOut();
    expect((await appMetrics.GET(new Request("http://dn.local/x"), p({ id: appId }))).status).toBe(401);
  });
});
