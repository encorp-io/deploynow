/**
 * Containers DeployNow doesn't manage ("external"): whatever ran on a server
 * before DeployNow, started with `docker run` or `docker compose`.
 *
 *  - listing: grouped per compose project (com.docker.compose.project), the
 *    way Portainer shows stacks it didn't create; the rest are standalone.
 *    DeployNow's own, helper and proxy containers are never listed here, and
 *    containers of an app that no longer exists show up as left over.
 *  - adopting: a compose stack becomes a compose app. The compose file is
 *    rebuilt from the running containers; environment values are not written
 *    into it but referenced as ${VAR} and stored as the app's variables
 *    (credential-like names as secrets), so the browser never sees them.
 *    The app keeps the stack's name as its compose project, so the first
 *    deploy takes over the same containers and named volumes.
 */
import type Docker from "dockerode";
import YAML from "yaml";
import { containerKind, SECRET_LABEL_RE, type ContainerKind } from "./containerProtection";
import { checkComposeRuntime, ComposePolicyError, composePolicyTrusted } from "./deploy/composePolicy";
import { SLUG_RE } from "./apps/config";

export const STANDALONE = "_standalone";
// What compose accepts as a project name (lowercase letters, digits, dashes, underscores)
export const STACK_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface ExternalContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  service: string | null;
  ports: string[];
  /** Left over from an app that was deleted (still carries deploynow.app) */
  leftover: boolean;
}

export interface ExternalStack {
  name: string;
  /** Where `docker compose` ran (from the containers' labels) */
  workingDir: string | null;
  configFiles: string | null;
  containers: ExternalContainer[];
  running: number;
  /** A DeployNow app with this compose project already exists (adopted, not deployed yet) */
  appId: string | null;
}

export interface ExternalGroups {
  stacks: ExternalStack[];
  standalone: ExternalContainer[];
}

type ListItem = Docker.ContainerInfo;

function rowOf(c: ListItem, leftover: boolean): ExternalContainer {
  const ports = (c.Ports ?? [])
    .filter((p) => p.PublicPort)
    .map((p) => `${p.PublicPort}→${p.PrivatePort}${p.Type === "udp" ? "/udp" : ""}`)
    .filter((v, i, a) => a.indexOf(v) === i);
  return {
    id: c.Id,
    name: c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created: c.Created,
    service: c.Labels?.["com.docker.compose.service"] ?? null,
    ports,
    leftover,
  };
}

/** Which kind a list entry is, and whether it belongs on the external list. */
export function externalKind(c: ListItem, appIds: Set<string>): { show: boolean; leftover: boolean; kind: ContainerKind } {
  const kind = containerKind({ Id: c.Id, Image: c.Image, Labels: c.Labels });
  if (kind === "other") return { show: true, leftover: false, kind };
  if (kind === "app") {
    const appId = c.Labels?.["deploynow.app"] ?? "";
    // Previews and apps that still exist are managed; a deleted app's containers are left over
    return { show: !appIds.has(appId), leftover: true, kind };
  }
  return { show: false, leftover: false, kind };
}

/** Group a container list into compose stacks and standalone containers. */
export function groupExternal(list: ListItem[], appIds: Set<string>, appsBySlug: Map<string, string> = new Map()): ExternalGroups {
  const stacks = new Map<string, ExternalStack>();
  const standalone: ExternalContainer[] = [];
  for (const c of list) {
    const { show, leftover } = externalKind(c, appIds);
    if (!show) continue;
    const row = rowOf(c, leftover);
    const project = c.Labels?.["com.docker.compose.project"];
    if (!project) {
      standalone.push(row);
      continue;
    }
    let s = stacks.get(project);
    if (!s) {
      s = {
        name: project,
        workingDir: c.Labels?.["com.docker.compose.project.working_dir"] ?? null,
        configFiles: c.Labels?.["com.docker.compose.project.config_files"] ?? null,
        containers: [],
        running: 0,
        appId: appsBySlug.get(project) ?? null,
      };
      stacks.set(project, s);
    }
    s.containers.push(row);
    if (c.State === "running") s.running++;
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  for (const s of stacks.values()) s.containers.sort((a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name));
  return { stacks: [...stacks.values()].sort(byName), standalone: standalone.sort(byName) };
}

/** The containers of one stack (or the standalone ones) on an endpoint. */
export function pickGroup(groups: ExternalGroups, stack: string): ExternalContainer[] | null {
  if (stack === STANDALONE) return groups.standalone;
  return groups.stacks.find((s) => s.name === stack)?.containers ?? null;
}

// ─── Adopting a compose stack ──────────────────────────────────────────────────

/** Names whose values are treated as secrets when imported. */
const SECRET_KEY_RE = /pass(word|wd)?|secret|token|api[-_.]?key|private|credential|auth|salt|dsn|cert|_key$|^key$|database_url|db_url|redis_url|mongo.*url|smtp_|license/i;

export function looksSecret(key: string, value: string): boolean {
  return SECRET_KEY_RE.test(key) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
}

export interface AdoptEnvVar {
  key: string;
  kind: "plain" | "secret";
  value: string;
}

export interface AdoptPlan {
  /** The compose project; also the app's Docker name when it is a valid one */
  stack: string;
  slug: string;
  /** Same compose project, so the first deploy takes over the running containers */
  inPlace: boolean;
  yaml: string;
  /** Variable values (server side only: never send them to the browser) */
  env: AdoptEnvVar[];
  services: string[];
  warnings: string[];
  /** Why DeployNow's compose rules would refuse the file (empty when it passes or the policy is trusted) */
  blocker: string | null;
}

type Inspect = Docker.ContainerInspectInfo;
type ImageInspect = Docker.ImageInspectInfo;

function envPairs(list: string[] | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of list ?? []) {
    const i = e.indexOf("=");
    if (i === -1) m.set(e, "");
    else m.set(e.slice(0, i), e.slice(i + 1));
  }
  return m;
}

const sameList = (a: string[] | null | undefined, b: string[] | null | undefined) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Compose escapes: a literal $ in a value written into the file must be $$ */
const esc = (s: string) => s.replace(/\$/g, "$$$$");

/** A shell-safe variable name for compose interpolation. */
function varSafe(s: string): string {
  const v = s.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(v) ? v : `_${v}`;
}

/**
 * Rebuild a compose file from the inspect results of a stack's containers.
 * `images` maps image ids to their inspect result (for defaults to leave out).
 */
export function planAdoption(
  stack: string,
  containers: Inspect[],
  images: Map<string, ImageInspect>,
  opts: { proxyNetwork: string | null },
): AdoptPlan {
  const warnings: string[] = [];
  const services: Record<string, Record<string, unknown>> = {};
  const topVolumes: Record<string, Record<string, unknown>> = {};
  const topNetworks: Record<string, Record<string, unknown>> = {};
  const envValues = new Map<string, string>(); // variable → value
  const envKinds = new Map<string, "plain" | "secret">();
  /**
   * The variable that carries `value`: the key itself when free (or already holding the
   * same value), else SERVICE_KEY, then SERVICE_KEY_2, … until one is unused.
   */
  const allocVar = (service: string, key: string, value: string, secret: boolean): string => {
    const base = varSafe(key);
    const scoped = varSafe(`${service.toUpperCase()}_${base}`);
    for (let i = 0; ; i++) {
      const v = i === 0 ? base : i === 1 ? scoped : `${scoped}_${i}`;
      const have = envValues.get(v);
      if (have === undefined || have === value) {
        envValues.set(v, value);
        if (secret || envKinds.get(v) !== "secret") envKinds.set(v, secret ? "secret" : "plain");
        return v;
      }
    }
  };
  const replicas = new Map<string, number>();
  const idToService = new Map<string, string>();
  const slug = SLUG_RE.test(stack) ? stack : stack.replace(/_/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "stack";
  const inPlace = slug === stack;
  if (!inPlace) {
    warnings.push(`The stack name ${stack} can't be a DeployNow Docker name, so the app is called ${slug}: stop the old containers before the first deploy, and its volumes start empty unless you point the file at the old ones.`);
  }

  // One entry per service (several containers = replicas)
  const ordered = [...containers].sort((a, b) => Number(a.Config.Labels?.["com.docker.compose.container-number"] ?? 1) - Number(b.Config.Labels?.["com.docker.compose.container-number"] ?? 1));
  for (const c of ordered) {
    const svc = c.Config.Labels?.["com.docker.compose.service"] || c.Name.replace(/^\//, "");
    idToService.set(c.Id, svc);
  }
  const traefikDropped = new Set<string>();

  for (const c of ordered) {
    const name = idToService.get(c.Id)!;
    if (services[name]) {
      replicas.set(name, (replicas.get(name) ?? 1) + 1);
      continue;
    }
    const labels = c.Config.Labels ?? {};
    const img = images.get(c.Image);
    const s: Record<string, unknown> = { image: c.Config.Image };

    const cname = c.Name.replace(/^\//, "");
    const num = labels["com.docker.compose.container-number"] ?? "1";
    if (cname !== `${stack}-${name}-${num}` && cname !== `${stack}_${name}_${num}`) s.container_name = cname;

    if (!sameList(c.Config.Entrypoint as string[] | null, img?.Config?.Entrypoint as string[] | null | undefined) && c.Config.Entrypoint) {
      s.entrypoint = (c.Config.Entrypoint as string[]).map(esc);
    }
    if (c.Config.Cmd && (!sameList(c.Config.Cmd, img?.Config?.Cmd) || s.entrypoint)) s.command = c.Config.Cmd.map(esc);
    if (c.Config.User && c.Config.User !== (img?.Config?.User ?? "")) s.user = c.Config.User;
    if (c.Config.WorkingDir && c.Config.WorkingDir !== (img?.Config?.WorkingDir ?? "")) s.working_dir = c.Config.WorkingDir;
    if (c.Config.Tty) s.tty = true;
    if (c.Config.OpenStdin) s.stdin_open = true;
    const hostname = c.Config.Hostname;
    if (hostname && !c.Id.startsWith(hostname) && hostname !== cname) s.hostname = hostname;

    // Environment: everything the image doesn't already set, as ${VAR} references
    const imageEnv = envPairs(img?.Config?.Env);
    const environment: Record<string, string> = {};
    for (const [key, value] of envPairs(c.Config.Env)) {
      if (imageEnv.get(key) === value) continue;
      // Names that aren't shell identifiers (API-KEY, db.password) get a safe variable too
      const variable = allocVar(name, key, value, !!value && looksSecret(key, value));
      environment[key] = `\${${variable}}`;
    }
    if (Object.keys(environment).length) s.environment = environment;

    // Ports
    const ports: string[] = [];
    for (const [cport, binds] of Object.entries(c.HostConfig?.PortBindings ?? {})) {
      for (const b of (binds as { HostIp?: string; HostPort?: string }[] | null) ?? []) {
        const [p, proto] = cport.split("/");
        const host = b.HostPort ? `${b.HostIp && b.HostIp !== "0.0.0.0" && b.HostIp !== "::" ? `${b.HostIp.includes(":") ? `[${b.HostIp}]` : b.HostIp}:` : ""}${b.HostPort}:` : "";
        const entry = `${host}${p}${proto && proto !== "tcp" ? `/${proto}` : ""}`;
        if (!ports.includes(entry)) ports.push(entry);
      }
    }
    if (ports.length) s.ports = ports;

    // Volumes and bind mounts
    const vols: string[] = [];
    for (const m of c.Mounts ?? []) {
      const ro = m.RW === false ? ":ro" : "";
      if (m.Type === "volume" && m.Name) {
        // Volumes compose made for this stack carry its labels; anonymous ones are 64 hex chars
        if (/^[0-9a-f]{64}$/.test(m.Name)) {
          vols.push(m.Destination);
          continue;
        }
        const short = m.Name.startsWith(`${stack}_`) ? m.Name.slice(stack.length + 1) : m.Name;
        const key = short.replace(/[^a-zA-Z0-9_.-]/g, "_");
        topVolumes[key] = m.Name.startsWith(`${stack}_`) && inPlace ? { name: m.Name } : { name: m.Name, external: true };
        vols.push(`${key}:${m.Destination}${ro}`);
      } else if (m.Type === "bind") {
        vols.push(`${m.Source}:${m.Destination}${ro}`);
      } else if (m.Type === "tmpfs") {
        vols.push(m.Destination);
      }
    }
    if (vols.length) s.volumes = vols;

    // Networks
    const mode = c.HostConfig?.NetworkMode ?? "";
    if (mode === "host" || mode === "none") {
      s.network_mode = mode;
    } else if (mode.startsWith("container:")) {
      const target = idToService.get(mode.slice(10)) ?? [...idToService.entries()].find(([id]) => id.startsWith(mode.slice(10)))?.[1];
      if (target) s.network_mode = `service:${target}`;
      else warnings.push(`${name} shares the network of a container outside this stack; that part was left out.`);
    } else {
      const nets: string[] = [];
      for (const net of Object.keys(c.NetworkSettings?.Networks ?? {})) {
        if (net === `${stack}_default` || net === "bridge") continue;
        if (opts.proxyNetwork && net === opts.proxyNetwork) continue; // DeployNow adds it for domains
        const own = net.startsWith(`${stack}_`) && inPlace;
        const key = own ? net.slice(stack.length + 1) : net.replace(/[^a-zA-Z0-9_.-]/g, "_");
        topNetworks[key] = own ? { name: net } : { name: net, external: true };
        nets.push(key);
      }
      if (nets.length) {
        const joinsDefault = Object.keys(c.NetworkSettings?.Networks ?? {}).includes(`${stack}_default`);
        s.networks = joinsDefault ? ["default", ...nets] : nets;
      }
    }

    // Restart policy, healthcheck, dependencies
    const restart = c.HostConfig?.RestartPolicy?.Name;
    if (restart && restart !== "no") s.restart = restart === "on-failure" && c.HostConfig?.RestartPolicy?.MaximumRetryCount ? `on-failure:${c.HostConfig.RestartPolicy.MaximumRetryCount}` : restart;
    const hc = c.Config.Healthcheck as { Test?: string[]; Interval?: number; Timeout?: number; Retries?: number; StartPeriod?: number } | undefined;
    if (hc?.Test?.length && JSON.stringify(hc) !== JSON.stringify(img?.Config?.Healthcheck ?? null)) {
      const dur = (ns?: number) => (ns ? `${Math.round(ns / 1e9)}s` : undefined);
      const h: Record<string, unknown> = { test: hc.Test.map(esc) };
      if (dur(hc.Interval)) h.interval = dur(hc.Interval);
      if (dur(hc.Timeout)) h.timeout = dur(hc.Timeout);
      if (hc.Retries) h.retries = hc.Retries;
      if (dur(hc.StartPeriod)) h.start_period = dur(hc.StartPeriod);
      s.healthcheck = h;
    }
    const deps = labels["com.docker.compose.depends_on"];
    if (deps) {
      const d: Record<string, { condition: string }> = {};
      for (const part of deps.split(",")) {
        const [dep, condition] = part.split(":");
        if (dep && dep !== name) d[dep] = { condition: condition || "service_started" };
      }
      if (Object.keys(d).length) s.depends_on = d;
    }

    // Host access: kept as it was, so the policy check below can say what it is
    if (c.HostConfig?.Privileged) s.privileged = true;
    if (c.HostConfig?.CapAdd?.length) s.cap_add = c.HostConfig.CapAdd;
    if (c.HostConfig?.CapDrop?.length) s.cap_drop = c.HostConfig.CapDrop;
    if (c.HostConfig?.Devices?.length) s.devices = c.HostConfig.Devices.map((d: { PathOnHost: string; PathInContainer: string; CgroupPermissions?: string }) => `${d.PathOnHost}:${d.PathInContainer}${d.CgroupPermissions && d.CgroupPermissions !== "rwm" ? `:${d.CgroupPermissions}` : ""}`);
    if (c.HostConfig?.PidMode === "host") s.pid = "host";
    if (c.HostConfig?.ExtraHosts?.length) s.extra_hosts = c.HostConfig.ExtraHosts;
    if (c.HostConfig?.ShmSize && c.HostConfig.ShmSize !== 64 * 1024 * 1024) s.shm_size = `${Math.round(c.HostConfig.ShmSize / 1024 / 1024)}m`;
    if (c.HostConfig?.Memory) s.mem_limit = `${Math.round(c.HostConfig.Memory / 1024 / 1024)}m`;
    if (c.HostConfig?.NanoCpus) s.cpus = c.HostConfig.NanoCpus / 1e9;
    if (c.HostConfig?.LogConfig?.Type && c.HostConfig.LogConfig.Type !== "json-file") {
      s.logging = { driver: c.HostConfig.LogConfig.Type, ...(Object.keys(c.HostConfig.LogConfig.Config ?? {}).length ? { options: c.HostConfig.LogConfig.Config } : {}) };
    }

    // Labels: the container's own, without compose's, the image's and Traefik's
    const imageLabels = img?.Config?.Labels ?? {};
    const own: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (k.startsWith("com.docker.compose.") || k.startsWith("deploynow.") || imageLabels[k] === v) continue;
      if (k.startsWith("traefik.")) {
        traefikDropped.add(name);
        continue;
      }
      // Credential-like labels (masked on the container page too) become secret variables
      own[k] = v && SECRET_LABEL_RE.test(k) ? `\${${allocVar(name, `LABEL_${k}`, v, true)}}` : esc(v);
    }
    if (Object.keys(own).length) s.labels = own;

    services[name] = s;
  }

  for (const [name, n] of replicas) {
    if (services[name].container_name) warnings.push(`${name} runs ${n} containers but sets a container name; only one was kept.`);
    else services[name].scale = n;
  }
  if (traefikDropped.size) {
    warnings.push(`Traefik labels on ${[...traefikDropped].join(", ")} were left out: add the domains on the app's Domains tab instead.`);
  }
  const builtLocally = Object.entries(services).filter(([, s]) => typeof s.image === "string" && !String(s.image).includes("/") && String(s.image).startsWith(`${stack}-`));
  if (builtLocally.length) {
    warnings.push(`${builtLocally.map(([n]) => n).join(", ")} use${builtLocally.length === 1 ? "s" : ""} an image built on this server. It keeps working here, but DeployNow can't rebuild it: connect the Git repository later to build it.`);
  }

  const doc: Record<string, unknown> = { services };
  if (Object.keys(topVolumes).length) doc.volumes = topVolumes;
  if (Object.keys(topNetworks).length) doc.networks = topNetworks;
  const yaml = `# Rebuilt by DeployNow from the running containers of the ${stack} stack.\n# Environment values are stored as the app's variables, not in this file.\n${YAML.stringify(doc, { lineWidth: 0 })}`;

  let blocker: string | null = null;
  if (!composePolicyTrusted()) {
    try {
      checkComposeRuntime(doc, { slug, proxyNetwork: opts.proxyNetwork });
    } catch (err) {
      if (err instanceof ComposePolicyError) blocker = err.message;
      else throw err;
    }
  }

  const env: AdoptEnvVar[] = [...envValues.entries()].map(([key, value]) => ({ key, value, kind: envKinds.get(key) ?? "plain" }));
  return { stack, slug, inPlace, yaml, env, services: Object.keys(services), warnings, blocker };
}

/** Inspect a stack's containers (and their images) and plan the adoption. */
export async function planStackAdoption(docker: Docker, stack: string, opts: { proxyNetwork: string | null; appIds: Set<string> }): Promise<AdoptPlan | null> {
  const list = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${stack}`] } });
  const mine = list.filter((c) => externalKind(c, opts.appIds).kind === "other");
  if (!mine.length) return null;
  if (mine.length !== list.length) return null; // part of it belongs to DeployNow: not adoptable
  const inspects = await Promise.all(mine.map((c) => docker.getContainer(c.Id).inspect()));
  const images = new Map<string, ImageInspect>();
  await Promise.all(
    [...new Set(inspects.map((i) => i.Image))].map(async (id) => {
      try {
        images.set(id, await docker.getImage(id).inspect());
      } catch {
        /* image gone: keep everything the container sets */
      }
    }),
  );
  return planAdoption(stack, inspects, images, opts);
}
