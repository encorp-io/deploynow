/**
 * Run one deployment of a single-container app (image or Dockerfile).
 *
 * Stateless apps (no host ports, no volumes) start the new container next to
 * the old one, wait for it to be healthy and only then stop the old one, so
 * Traefik always has a backend. Apps with host ports or volumes stop the old
 * container first; if the new one fails, the old one is started again.
 */
import type Docker from "dockerode";
import { logBufferToText } from "../docker/streams";
import { dockerErrorMessage, dockerStatusCode } from "../docker/client";
import type { PortMap, VolumeMount } from "../apps/config";

export interface ContainerSpec {
  appId: string;
  slug: string;
  deploymentId: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  cmd?: string[];
  ports: PortMap[];
  volumes: VolumeMount[];
  restartPolicy: string;
  appNetwork: string;
  proxyNetwork: string | null;
}

export type Log = (line: string) => void;

export function containerName(slug: string, deploymentId: string) {
  return `${slug}-${deploymentId.slice(-8)}`;
}

export function volumeName(slug: string, name: string) {
  return `dn-${slug}-${name}`;
}

export function buildCreateOptions(spec: ContainerSpec): Docker.ContainerCreateOptions {
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostPort: string }[]> = {};
  for (const p of spec.ports) {
    const key = `${p.container}/${p.protocol}`;
    exposed[key] = {};
    if (p.host) bindings[key] = [...(bindings[key] ?? []), { HostPort: String(p.host) }];
  }
  const mounts: Docker.MountSettings[] = spec.volumes.map((v) => ({ Type: "volume", Source: volumeName(spec.slug, v.name), Target: v.path }));

  return {
    name: containerName(spec.slug, spec.deploymentId),
    Image: spec.image,
    Env: spec.env,
    Cmd: spec.cmd?.length ? spec.cmd : undefined,
    Labels: {
      ...spec.labels,
      "deploynow.app": spec.appId,
      "deploynow.deployment": spec.deploymentId,
    },
    ExposedPorts: Object.keys(exposed).length ? exposed : undefined,
    HostConfig: {
      PortBindings: Object.keys(bindings).length ? bindings : undefined,
      Mounts: mounts.length ? mounts : undefined,
      RestartPolicy: { Name: spec.restartPolicy === "no" ? "" : spec.restartPolicy, ...(spec.restartPolicy === "on-failure" ? { MaximumRetryCount: 5 } : {}) },
      NetworkMode: spec.appNetwork,
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
    },
    NetworkingConfig: { EndpointsConfig: { [spec.appNetwork]: { Aliases: [spec.slug] } } },
  };
}

async function tailLogs(container: Docker.Container, lines = 30): Promise<string> {
  try {
    const buf = (await container.logs({ stdout: true, stderr: true, tail: lines, follow: false })) as unknown as Buffer;
    return logBufferToText(buf);
  } catch {
    return "";
  }
}

/**
 * Wait until the container is healthy (if the image has a health check) or
 * has stayed up for `settleMs` without restarting.
 */
export async function waitHealthy(container: Docker.Container, log: Log, opts: { timeoutMs?: number; settleMs?: number; signal?: AbortSignal } = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const settle = opts.settleMs ?? 5000;
  let lastHealth = "";
  let upSince: number | null = null;
  let startedAt = "";
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Cancelled");
    const info = await container.inspect();
    const st = info.State;
    if (!st.Running && !st.Restarting) {
      const out = await tailLogs(container);
      if (out) for (const l of out.split("\n").slice(-30)) log(`  │ ${l}`);
      throw new Error(`The container stopped (exit code ${st.ExitCode}${st.Error ? `: ${st.Error}` : ""})`);
    }
    if (st.Health) {
      if (st.Health.Status !== lastHealth) {
        lastHealth = st.Health.Status;
        log(`Health: ${lastHealth}`);
      }
      if (st.Health.Status === "healthy") return;
      if (st.Health.Status === "unhealthy") {
        const last = st.Health.Log?.[st.Health.Log.length - 1];
        throw new Error(`Health check failed${last?.Output ? `: ${last.Output.trim().slice(0, 300)}` : ""}`);
      }
    } else if (st.Running) {
      if (st.StartedAt !== startedAt) {
        startedAt = st.StartedAt;
        upSince = Date.now();
      }
      if (upSince && Date.now() - upSince >= settle) return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Timed out waiting for the container to become healthy");
}

async function connectNetwork(docker: Docker, network: string, containerId: string, aliases?: string[]) {
  await docker.getNetwork(network).connect({ Container: containerId, EndpointConfig: aliases ? { Aliases: aliases } : {} });
}

export async function oldContainers(docker: Docker, appId: string, exceptDeployment: string): Promise<Docker.ContainerInfo[]> {
  const list = await docker.listContainers({ all: true, filters: { label: [`deploynow.app=${appId}`] } });
  return list.filter((c) => c.Labels["deploynow.deployment"] !== exceptDeployment);
}

async function removeQuietly(docker: Docker, id: string) {
  try {
    await docker.getContainer(id).remove({ force: true, v: false });
  } catch (err) {
    if (dockerStatusCode(err) !== 404) throw err;
  }
}

export async function deployContainer(
  docker: Docker,
  spec: ContainerSpec,
  log: Log,
  opts: { healthTimeoutMs?: number; settleMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const old = await oldContainers(docker, spec.appId, spec.deploymentId);
  const stopFirst = spec.ports.some((p) => p.host) || spec.volumes.length > 0;

  // A leftover from an earlier, interrupted attempt of this same deployment
  await removeQuietly(docker, containerName(spec.slug, spec.deploymentId));

  const created = await docker.createContainer(buildCreateOptions(spec));
  log(`Created container ${containerName(spec.slug, spec.deploymentId)}`);
  try {
    if (spec.proxyNetwork && spec.proxyNetwork !== spec.appNetwork) await connectNetwork(docker, spec.proxyNetwork, created.id);
  } catch (err) {
    await removeQuietly(docker, created.id);
    throw new Error(`Couldn't join the proxy network ${spec.proxyNetwork}: ${dockerErrorMessage(err)}`);
  }

  const stopped: string[] = [];
  try {
    if (stopFirst) {
      for (const c of old.filter((c) => c.State === "running" || c.State === "restarting")) {
        log(`Stopping ${c.Names[0]?.replace(/^\//, "")} (this app publishes ports or uses volumes)`);
        await docker.getContainer(c.Id).stop({ t: 30 }).catch((e) => {
          if (dockerStatusCode(e) !== 304) throw e;
        });
        stopped.push(c.Id);
      }
    }
    await created.start();
    log("Started, waiting for it to become healthy…");
    await waitHealthy(created, log, { timeoutMs: opts.healthTimeoutMs, settleMs: opts.settleMs, signal: opts.signal });
    log("Healthy");
  } catch (err) {
    log(`Rolling back: ${dockerErrorMessage(err)}`);
    await removeQuietly(docker, created.id);
    for (const id of stopped) {
      await docker.getContainer(id).start().catch(() => log("Couldn't restart the previous container"));
    }
    throw err;
  }

  for (const c of old) {
    log(`Removing previous container ${c.Names[0]?.replace(/^\//, "")}`);
    if (!stopFirst && c.State === "running") await docker.getContainer(c.Id).stop({ t: 30 }).catch(() => {});
    await removeQuietly(docker, c.Id);
  }
  return created.id;
}
