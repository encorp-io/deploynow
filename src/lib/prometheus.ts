/**
 * Prometheus text exposition (format 0.0.4) for /api/metrics.
 *
 * Containers come from the latest stored sample of each (see containerMetrics),
 * hosts from the latest host metrics of each endpoint, plus endpoint state,
 * app state and firing alerts. Only endpoints and projects the caller may view
 * are included.
 */
import { prisma } from "./prisma";
import { latestSamples } from "./containerMetrics";
import { parseMetrics } from "./endpoints";

type Labels = Record<string, string>;
interface Family {
  name: string;
  help: string;
  type: "gauge" | "counter";
  samples: { labels: Labels; value: number }[];
}

export function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function fmtValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  return String(v);
}

export function render(families: Family[]): string {
  const out: string[] = [];
  for (const f of families) {
    out.push(`# HELP ${f.name} ${f.help}`);
    out.push(`# TYPE ${f.name} ${f.type}`);
    for (const s of f.samples) {
      const l = Object.entries(s.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(",");
      out.push(`${f.name}${l ? `{${l}}` : ""} ${fmtValue(s.value)}`);
    }
  }
  return out.join("\n") + "\n";
}

export interface Visibility {
  endpoint: (endpointId: string) => boolean;
  project: (projectId: string) => boolean;
}

const HOST_FRESH = 10 * 60_000;

export async function collectFamilies(vis: Visibility, now = Date.now()): Promise<Family[]> {
  const fam = (name: string, type: Family["type"], help: string): Family => ({ name, help, type, samples: [] });
  const endpointUp = fam("deploynow_endpoint_up", "gauge", "1 when DeployNow can reach the endpoint's Docker daemon");
  const hostCpus = fam("deploynow_host_cpus", "gauge", "CPUs on the host");
  const hostLoad = fam("deploynow_host_load1", "gauge", "1-minute load average of the host");
  const hostMemTotal = fam("deploynow_host_memory_total_bytes", "gauge", "Host memory");
  const hostMemUsed = fam("deploynow_host_memory_used_bytes", "gauge", "Host memory in use (total minus available)");
  const hostDiskTotal = fam("deploynow_host_disk_total_bytes", "gauge", "Size of the Docker data disk");
  const hostDiskUsed = fam("deploynow_host_disk_used_bytes", "gauge", "Space used on the Docker data disk");
  const cpuTotal = fam("deploynow_container_cpu_usage_seconds_total", "counter", "CPU time used by the container");
  const cpuPct = fam("deploynow_container_cpu_percent", "gauge", "Average CPU over the last sample interval (100 = one core)");
  const memUsage = fam("deploynow_container_memory_usage_bytes", "gauge", "Memory used by the container, without page cache");
  const memLimit = fam("deploynow_container_memory_limit_bytes", "gauge", "Memory limit of the container (host memory when unlimited)");
  const rx = fam("deploynow_container_network_receive_bytes_total", "counter", "Bytes received by the container");
  const tx = fam("deploynow_container_network_transmit_bytes_total", "counter", "Bytes sent by the container");
  const rd = fam("deploynow_container_blkio_read_bytes_total", "counter", "Bytes read from block devices by the container");
  const wr = fam("deploynow_container_blkio_write_bytes_total", "counter", "Bytes written to block devices by the container");
  const pids = fam("deploynow_container_pids", "gauge", "Processes in the container");
  const sampleAge = fam("deploynow_container_last_sample_timestamp_seconds", "gauge", "When the container was last sampled");
  const appUp = fam("deploynow_app_status", "gauge", "1 for the app's current status");
  const alerts = fam("deploynow_alerts_firing", "gauge", "Alerts currently firing, by kind");

  const endpoints = (await prisma.endpoint.findMany({ select: { id: true, name: true, type: true, status: true, hostMetrics: true, hostMetricsAt: true } })).filter((e) => vis.endpoint(e.id));
  const endpointName = new Map(endpoints.map((e) => [e.id, e.name]));
  for (const e of endpoints) {
    const base = { endpoint: e.name, endpoint_id: e.id };
    endpointUp.samples.push({ labels: { ...base, type: e.type }, value: e.status === "online" ? 1 : 0 });
    const m = e.hostMetricsAt && now - e.hostMetricsAt.getTime() < HOST_FRESH ? parseMetrics(e.hostMetrics) : null;
    if (m && m.memTotal) {
      hostCpus.samples.push({ labels: base, value: m.cpus });
      hostLoad.samples.push({ labels: base, value: m.load1 });
      hostMemTotal.samples.push({ labels: base, value: m.memTotal });
      hostMemUsed.samples.push({ labels: base, value: Math.max(0, m.memTotal - m.memAvailable) });
      if (m.diskTotal) {
        hostDiskTotal.samples.push({ labels: base, value: m.diskTotal });
        hostDiskUsed.samples.push({ labels: base, value: Math.max(0, m.diskTotal - m.diskFree) });
      }
    }
  }

  const apps = await prisma.application.findMany({ select: { id: true, name: true, status: true, endpointId: true, environment: { select: { name: true, projectId: true, project: { select: { name: true } } } } } });
  const appInfo = new Map(apps.map((a) => [a.id, a]));
  for (const a of apps) {
    if (!vis.project(a.environment.projectId) || !endpointName.has(a.endpointId)) continue;
    appUp.samples.push({ labels: { app: a.name, app_id: a.id, project: a.environment.project.name, environment: a.environment.name, endpoint: endpointName.get(a.endpointId) ?? "", status: a.status }, value: 1 });
  }

  for (const s of await latestSamples(3 * 60_000, now)) {
    const ep = endpointName.get(s.endpointId);
    if (ep === undefined) continue;
    const app = s.applicationId ? appInfo.get(s.applicationId) : undefined;
    if (app && !vis.project(app.environment.projectId)) continue;
    const labels: Labels = {
      endpoint: ep,
      container: s.containerName,
      app: app?.name ?? "",
      project: app?.environment.project.name ?? "",
      environment: app?.environment.name ?? "",
      service: s.service,
    };
    cpuTotal.samples.push({ labels, value: s.cpuSecondsTotal });
    if (s.seconds > 0) cpuPct.samples.push({ labels, value: s.cpuPercent });
    memUsage.samples.push({ labels, value: s.memUsage });
    memLimit.samples.push({ labels, value: s.memLimit });
    rx.samples.push({ labels, value: s.netRxTotal });
    tx.samples.push({ labels, value: s.netTxTotal });
    rd.samples.push({ labels, value: s.blkReadTotal });
    wr.samples.push({ labels, value: s.blkWriteTotal });
    pids.samples.push({ labels, value: s.pids });
    sampleAge.samples.push({ labels, value: Math.floor(s.at.getTime() / 1000) });
  }

  const firing = await prisma.alert.findMany({ where: { resolvedAt: null }, select: { kind: true, endpointId: true } });
  const byKind = new Map<string, number>();
  for (const a of firing) {
    if (a.endpointId && !vis.endpoint(a.endpointId)) continue;
    byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + 1);
  }
  for (const [kind, n] of byKind) alerts.samples.push({ labels: { kind }, value: n });

  return [endpointUp, hostCpus, hostLoad, hostMemTotal, hostMemUsed, hostDiskTotal, hostDiskUsed, cpuTotal, cpuPct, memUsage, memLimit, rx, tx, rd, wr, pids, sampleAge, appUp, alerts];
}
