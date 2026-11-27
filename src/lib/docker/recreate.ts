/**
 * Recreate a container on a new image while keeping its configuration
 * (volumes, ports, env, labels, networks, restart policy), the way
 * `docker compose up` or Portainer's "recreate" would.
 *
 * Steps: pull → rename old → stop old → create new → connect networks → start
 * → remove old. If anything after "stop old" fails, the new container is
 * removed and the old one is renamed back and restarted.
 */
import type Docker from "dockerode";
import type { AuthConfig } from "../registryAuth";

type Inspect = Docker.ContainerInspectInfo;

export async function pullImage(docker: Docker, image: string, authconfig?: AuthConfig): Promise<void> {
  const stream = await docker.pull(image, authconfig ? { authconfig } : {});
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null, output: Array<{ error?: string }>) => {
      if (err) return reject(err);
      const failed = output?.find((o) => o.error);
      return failed ? reject(new Error(failed.error)) : resolve();
    });
  });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The container's Config mixes values set at `docker run` with defaults baked
 * into the old image. Keep only what the container set itself, so the new
 * image's own defaults (CMD, ENV, labels…) take effect.
 */
export function containerOnlyConfig(
  config: Inspect["Config"],
  oldImageConfig: Partial<Inspect["Config"]> | undefined,
  newImage: string,
  oldId: string,
): Record<string, unknown> {
  const img = oldImageConfig ?? {};
  const out: Record<string, unknown> = { ...config, Image: newImage };

  if (config.Hostname && oldId.startsWith(config.Hostname)) delete out.Hostname;

  const imgEnv = new Set(img.Env ?? []);
  out.Env = (config.Env ?? []).filter((e) => !imgEnv.has(e));

  const imgLabels = (img.Labels ?? {}) as Record<string, string>;
  out.Labels = Object.fromEntries(
    Object.entries(config.Labels ?? {}).filter(([k, v]) => imgLabels[k] !== v),
  );

  for (const key of ["Cmd", "Entrypoint", "WorkingDir", "User", "Healthcheck", "StopSignal", "Shell"] as const) {
    if (sameJson((config as Record<string, unknown>)[key], (img as Record<string, unknown>)[key])) delete out[key];
  }
  if (config.ExposedPorts && img.ExposedPorts) {
    const own = Object.keys(config.ExposedPorts).filter((p) => !(p in (img.ExposedPorts ?? {})));
    out.ExposedPorts = Object.fromEntries(own.map((p) => [p, {}]));
  }
  if (config.Volumes && (img as Record<string, unknown>).Volumes) {
    const imgVols = (img as { Volumes?: Record<string, unknown> }).Volumes ?? {};
    out.Volumes = Object.fromEntries(Object.keys(config.Volumes).filter((v) => !(v in imgVols)).map((v) => [v, {}]));
  }
  return out;
}

/** Endpoint settings worth carrying over; ids and addresses are assigned fresh. */
export function networkEndpointConfig(
  settings: Record<string, unknown> | undefined,
  oldId: string,
): Record<string, unknown> {
  const s = (settings ?? {}) as {
    Aliases?: string[] | null;
    IPAMConfig?: unknown;
    Links?: string[] | null;
    DriverOpts?: unknown;
  };
  const aliases = (s.Aliases ?? []).filter((a) => !oldId.startsWith(a));
  return {
    ...(aliases.length ? { Aliases: aliases } : {}),
    ...(s.IPAMConfig ? { IPAMConfig: s.IPAMConfig } : {}),
    ...(s.Links?.length ? { Links: s.Links } : {}),
    ...(s.DriverOpts ? { DriverOpts: s.DriverOpts } : {}),
  };
}

function hasStaticAddress(settings: Record<string, unknown> | undefined): boolean {
  const ipam = (settings?.IPAMConfig ?? null) as { IPv4Address?: string; IPv6Address?: string } | null;
  return !!(ipam?.IPv4Address || ipam?.IPv6Address);
}

/**
 * Anonymous volumes show up in Mounts but not in HostConfig.Binds, so a plain
 * create would give the new container fresh empty volumes. Bind the existing
 * ones by name at the same paths.
 */
export function withAnonymousVolumes(info: Pick<Inspect, "HostConfig" | "Mounts">): Inspect["HostConfig"] {
  const host = { ...info.HostConfig };
  const binds = [...(host.Binds ?? [])];
  const covered = new Set<string>([
    ...binds.map((b) => b.split(":")[1]).filter(Boolean),
    ...((host as { Mounts?: { Target?: string }[] }).Mounts ?? []).map((m) => m.Target ?? ""),
  ]);
  for (const m of info.Mounts ?? []) {
    if (m.Type === "volume" && m.Name && !covered.has(m.Destination)) {
      binds.push(`${m.Name}:${m.Destination}${m.RW ? "" : ":ro"}`);
      covered.add(m.Destination);
    }
  }
  host.Binds = binds;
  return host;
}

/** The recreate failed, and starting the old container again failed too. */
export class RollbackError extends Error {
  constructor(
    public cause: unknown,
    public rollbackCause: unknown,
  ) {
    super(`${(cause as Error)?.message ?? cause}; starting the old container again also failed: ${(rollbackCause as Error)?.message ?? rollbackCause}`);
  }
}

export interface RecreateOptions {
  /** Image to run; defaults to the container's current image reference */
  image?: string;
  pull?: boolean;
  authconfig?: AuthConfig;
  /** Runs once the old container has stopped, before the new one is created (e.g. to snapshot its data) */
  afterStop?: () => Promise<void> | void;
}

/**
 * A recreate whose old container is kept (stopped, renamed) until commit(), so
 * the caller can check the new one first and roll back to the old one.
 */
export interface StagedRecreate {
  newId: string;
  oldId: string;
  /** Remove the old container */
  commit(): Promise<void>;
  /** Remove the new container and start the old one again under its name. beforeStart runs in between. */
  rollback(beforeStart?: () => Promise<void> | void): Promise<void>;
}

export async function recreateContainer(docker: Docker, containerId: string, opts: RecreateOptions = {}): Promise<string> {
  const staged = await stagedRecreate(docker, containerId, opts);
  await staged.commit();
  return staged.newId;
}

export async function stagedRecreate(docker: Docker, containerId: string, opts: RecreateOptions = {}): Promise<StagedRecreate> {
  const old = docker.getContainer(containerId);
  const info = await old.inspect();
  const image = opts.image ?? info.Config.Image;
  const name = info.Name.replace(/^\//, "");
  const wasRunning = info.State.Running;

  if (opts.pull) await pullImage(docker, image, opts.authconfig);

  let oldImageConfig: Partial<Inspect["Config"]> | undefined;
  try {
    oldImageConfig = (await docker.getImage(info.Image).inspect()).Config as Partial<Inspect["Config"]>;
  } catch {
    oldImageConfig = undefined; // image already gone; keep the full config
  }

  const networkMode = info.HostConfig.NetworkMode ?? "default";
  const networks = Object.entries(info.NetworkSettings?.Networks ?? {});
  const primary = networks.find(([n]) => n === networkMode) ?? networks[0];
  const extra = networks.filter(([n]) => n !== primary?.[0]);
  const sharesNamespace = networkMode.startsWith("container:") || networkMode === "host" || networkMode === "none";

  const createOpts = {
    ...containerOnlyConfig(info.Config, oldImageConfig, image, info.Id),
    name,
    HostConfig: withAnonymousVolumes(info),
    ...(primary && !sharesNamespace
      ? { NetworkingConfig: { EndpointsConfig: { [primary[0]]: networkEndpointConfig(primary[1] as Record<string, unknown>, info.Id) } } }
      : {}),
  };

  // Docker keeps a static address reserved for the stopped old container, so
  // release it first (and give it back on rollback)
  const pinned = sharesNamespace ? [] : networks.filter(([, n]) => hasStaticAddress(n as Record<string, unknown>));

  const backupName = `${name}-old-${Date.now()}`;
  await old.rename({ name: backupName });
  if (wasRunning) await old.stop({ t: 10 }).catch(() => {});

  let created: Docker.Container | undefined;
  const released: string[] = [];
  const restoreOld = async (beforeStart?: () => Promise<void> | void) => {
    if (created) await created.stop({ t: 10 }).catch(() => {});
    if (created) await created.remove({ force: true }).catch(() => {});
    for (const [net, settings] of pinned.filter(([n]) => released.includes(n))) {
      await docker
        .getNetwork(net)
        .connect({ Container: info.Id, EndpointConfig: networkEndpointConfig(settings as Record<string, unknown>, info.Id) })
        .catch(() => {});
    }
    await old.rename({ name }).catch(() => {});
    if (beforeStart) await beforeStart();
    // A failed start must surface: the caller would otherwise report the old container as running
    if (wasRunning) {
      await old.start().catch((e: { statusCode?: number }) => {
        if (e?.statusCode !== 304) throw e; // 304 = already running
      });
    }
  };

  try {
    if (opts.afterStop) await opts.afterStop();
    for (const [net] of pinned) {
      await docker.getNetwork(net).disconnect({ Container: info.Id, Force: true });
      released.push(net);
    }
    created = await docker.createContainer(createOpts as Docker.ContainerCreateOptions);
    if (!sharesNamespace) {
      for (const [net, settings] of extra) {
        await docker.getNetwork(net).connect({
          Container: created.id,
          EndpointConfig: networkEndpointConfig(settings as Record<string, unknown>, info.Id),
        });
      }
    }
    if (wasRunning) await created.start();
  } catch (err) {
    // Roll back to the old container
    try {
      await restoreOld();
    } catch (rollbackErr) {
      throw new RollbackError(err, rollbackErr);
    }
    throw err;
  }

  const newContainer = created;
  return {
    newId: newContainer.id,
    oldId: info.Id,
    commit: async () => {
      await old.remove({ force: true }).catch(() => {});
    },
    rollback: restoreOld,
  };
}
