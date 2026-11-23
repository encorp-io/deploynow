import type Docker from "dockerode";

export function summarizeStats(s: Docker.ContainerStats) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;

  // Docker counts page cache in usage; subtract it like `docker stats` does
  const memStats = (s.memory_stats.stats ?? {}) as Record<string, number>;
  const cache = memStats.inactive_file ?? memStats.total_inactive_file ?? memStats.cache ?? 0;
  const memUsage = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
  const memLimit = s.memory_stats.limit ?? 0;

  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes;
    tx += n.tx_bytes;
  }
  let read = 0;
  let write = 0;
  for (const b of s.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (b.op.toLowerCase() === "read") read += b.value;
    if (b.op.toLowerCase() === "write") write += b.value;
  }

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsage: memUsage,
    memoryLimit: memLimit,
    memoryPercent: memLimit ? Math.round((memUsage / memLimit) * 1000) / 10 : 0,
    networkRx: rx,
    networkTx: tx,
    blockRead: read,
    blockWrite: write,
    pids: s.pids_stats?.current ?? 0,
  };
}
