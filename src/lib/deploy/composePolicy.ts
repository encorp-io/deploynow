/**
 * What a compose file may do on an endpoint.
 *
 * Anyone who can edit an app's compose file (a project admin, or anyone who can
 * push to the app's repository) must not get the host or DeployNow itself:
 *
 *  - files: docker compose runs inside the DeployNow container, so every local
 *    path it reads (env_file, build contexts and Dockerfiles, build and
 *    service secrets, configs, extends, include) must stay inside the
 *    compose file's own directory. Otherwise `secrets: {s: {file: /proc/1/environ}}`
 *    hands AUTH_SECRET to a build. This is always enforced.
 *  - runtime: no privileged containers, extra capabilities, devices, host
 *    namespaces, bind mounts, other apps' volumes or networks, joining other
 *    containers, or Traefik labels of its own (which could claim DeployNow's
 *    own domain). DEPLOYNOW_COMPOSE_POLICY=trusted turns these off for
 *    installs where everyone who edits compose files is trusted with the host.
 *
 * The runtime rules run twice: on the file as written (quick, clear errors)
 * and on `docker compose config` output right before `up`, after ${VAR}
 * interpolation, so a value like `privileged: ${X}` can't slip through.
 */
import fs from "fs";
import path from "path";

export class ComposePolicyError extends Error {}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** DEPLOYNOW_COMPOSE_POLICY=trusted lifts the runtime rules (never the file rules). */
export function composePolicyTrusted(): boolean {
  return /^trusted$/i.test((process.env.DEPLOYNOW_COMPOSE_POLICY ?? "").trim());
}

const TRUSTED_HINT = "If everyone who can edit compose files here may have root on the host, set DEPLOYNOW_COMPOSE_POLICY=trusted.";

// Docker's default capability set: adding one of these changes nothing
const DEFAULT_CAPS = new Set([
  "CHOWN", "DAC_OVERRIDE", "FSETID", "FOWNER", "MKNOD", "NET_RAW", "SETGID", "SETUID",
  "SETFCAP", "SETPCAP", "NET_BIND_SERVICE", "SYS_CHROOT", "KILL", "AUDIT_WRITE",
]);

// ─── Files ─────────────────────────────────────────────────────────────────────

/** True if `p` is inside `root` (or is root). */
function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep);
}

/**
 * A path a compose file names, resolved against `base`: must be a literal
 * relative path that stays inside `root`, also after following symlinks.
 */
export function assertLocalPath(root: string, base: string, raw: unknown, what: string): void {
  if (typeof raw !== "string" || !raw.trim()) throw new ComposePolicyError(`${what} must be a path`);
  const p = raw.trim();
  if (p.includes("$")) throw new ComposePolicyError(`${what} (${p}) can't use variables`);
  if (p.startsWith("~")) throw new ComposePolicyError(`${what} (${p}) must be a path inside the app's directory`);
  const full = path.resolve(base, p);
  if (!within(root, full)) throw new ComposePolicyError(`${what} (${p}) points outside the app's directory`);
  let real: string;
  try {
    real = fs.realpathSync(full);
  } catch {
    return; // doesn't exist (yet): compose will complain, and there's nothing to leak
  }
  const realRoot = fs.realpathSync(root);
  if (!within(realRoot, real)) throw new ComposePolicyError(`${what} (${p}) is a link to outside the app's directory`);
}

/** Remote build contexts (Git or HTTP URLs, images, other services) read no local files. */
function isRemoteContext(v: string): boolean {
  return /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|docker-image:\/\/|service:|oci-layout:\/\/)/i.test(v) || /\.git(#.*)?$/.test(v);
}

/**
 * Every local file the docker CLI would read for this compose file must be
 * inside `root` (the repository, or the work directory of an inline file).
 * Relative paths resolve against `dir`, the compose file's directory.
 */
export function checkComposeFiles(doc: unknown, root: string, dir = root): void {
  if (!isObj(doc)) return;
  if (doc.include !== undefined) throw new ComposePolicyError("include isn't supported: put the services in this file");

  for (const kind of ["secrets", "configs"] as const) {
    const section = doc[kind];
    if (!isObj(section)) continue;
    for (const [name, def] of Object.entries(section)) {
      if (isObj(def) && def.file !== undefined) assertLocalPath(root, dir, def.file, `The file of ${kind.slice(0, -1)} "${name}"`);
    }
  }

  const services = isObj(doc.services) ? doc.services : {};
  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc)) continue;
    const where = `service "${name}"`;

    if (svc.extends !== undefined) {
      if (typeof svc.extends === "string") {
        // extends: other-service (same file)
      } else if (isObj(svc.extends) && svc.extends.file !== undefined) {
        throw new ComposePolicyError(`extends.file in ${where} isn't supported: extend a service in the same file`);
      }
    }

    const envFiles = svc.env_file === undefined ? [] : Array.isArray(svc.env_file) ? svc.env_file : [svc.env_file];
    for (const f of envFiles) assertLocalPath(root, dir, isObj(f) ? f.path : f, `env_file of ${where}`);

    if (svc.build === undefined) continue;
    const build = typeof svc.build === "string" ? { context: svc.build } : isObj(svc.build) ? svc.build : null;
    if (!build) throw new ComposePolicyError(`build of ${where} must be a path or a map`);
    const ctx = build.context === undefined ? "." : build.context;
    if (typeof ctx !== "string") throw new ComposePolicyError(`build.context of ${where} must be a path`);
    const remote = isRemoteContext(ctx);
    if (!remote) assertLocalPath(root, dir, ctx, `build.context of ${where}`);
    if (build.dockerfile !== undefined && !remote) {
      assertLocalPath(root, path.resolve(dir, ctx), build.dockerfile, `build.dockerfile of ${where}`);
    }
    if (build.ssh !== undefined) throw new ComposePolicyError(`build.ssh in ${where} isn't supported: it would hand the build DeployNow's own keys`);
    if (isObj(build.additional_contexts)) {
      for (const [k, v] of Object.entries(build.additional_contexts)) {
        if (typeof v !== "string") throw new ComposePolicyError(`build.additional_contexts.${k} of ${where} must be a string`);
        if (!isRemoteContext(v)) assertLocalPath(root, dir, v, `build.additional_contexts.${k} of ${where}`);
      }
    } else if (Array.isArray(build.additional_contexts)) {
      for (const item of build.additional_contexts) {
        const s = String(item);
        const v = s.slice(s.indexOf("=") + 1);
        if (!isRemoteContext(v)) assertLocalPath(root, dir, v, `build.additional_contexts of ${where}`);
      }
    }
  }
}

// ─── Runtime ───────────────────────────────────────────────────────────────────

export interface RuntimeOptions {
  /** The app's Docker name: the compose project, and the prefix its own volumes and networks may use */
  slug: string;
  /** The edge proxy network, which DeployNow itself attaches services to */
  proxyNetwork: string | null;
  /** Labels DeployNow added itself (the Traefik routes for the app's domains) are allowed */
  ownLabels?: (service: string) => Set<string>;
}

function list(v: unknown): unknown[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function labelKeys(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).split("=")[0].trim());
  if (isObj(v)) return Object.keys(v);
  return [];
}

function truthy(v: unknown): boolean {
  return v === true || (typeof v === "string" && /^(true|yes|on|1)$/i.test(v.trim()));
}

/** Short volume syntax: "src:dst[:mode]" (or just "dst"). Returns the source, "" for an anonymous volume. */
function shortVolumeSource(v: string): string {
  const parts = v.split(":");
  if (parts.length === 1) return "";
  // Windows drive letters don't apply here; the first part is the source
  return parts[0];
}

function isBindSource(src: string): boolean {
  return src.startsWith("/") || src.startsWith(".") || src.startsWith("~") || src.includes("$");
}

/** Throws if the compose file asks for host access. Works on the file as written and on `docker compose config` output. */
export function checkComposeRuntime(doc: unknown, opts: RuntimeOptions): void {
  if (!isObj(doc) || composePolicyTrusted()) return;
  const deny = (msg: string): never => {
    throw new ComposePolicyError(`${msg}. ${TRUSTED_HINT}`);
  };
  const ownPrefix = `${opts.slug}`;
  const projectPrefix = `${opts.slug}_`;
  const services = isObj(doc.services) ? doc.services : {};
  const names = new Set(Object.keys(services));

  // Top-level volumes: no external ones, no other names, no bind-backed local driver
  const volumes = isObj(doc.volumes) ? doc.volumes : {};
  for (const [name, def] of Object.entries(volumes)) {
    if (!isObj(def)) continue;
    if (truthy(def.external) || isObj(def.external)) deny(`Volume "${name}" is external: an app can only use its own volumes`);
    if (typeof def.name === "string" && def.name !== `${projectPrefix}${name}` && !def.name.startsWith(ownPrefix)) {
      deny(`Volume "${name}" is named ${def.name}: an app's volume names must start with ${ownPrefix}`);
    }
    if (def.driver !== undefined && def.driver !== "local") deny(`Volume "${name}" uses the ${String(def.driver)} driver`);
    if (def.driver_opts !== undefined) deny(`Volume "${name}" sets driver_opts, which can mount host paths`);
  }

  // Top-level networks: only the app's own, and the proxy network DeployNow adds
  const networks = isObj(doc.networks) ? doc.networks : {};
  for (const [name, def] of Object.entries(networks)) {
    if (!isObj(def)) continue;
    const real = typeof def.name === "string" ? def.name : name;
    const isProxy = !!opts.proxyNetwork && real === opts.proxyNetwork;
    if ((truthy(def.external) || isObj(def.external)) && !isProxy) deny(`Network "${name}" is external: an app can only join its own networks`);
    if (typeof def.name === "string" && !isProxy && def.name !== `${projectPrefix}${name}` && !def.name.startsWith(ownPrefix)) {
      deny(`Network "${name}" is named ${def.name}: an app's network names must start with ${ownPrefix}`);
    }
    if (def.driver !== undefined && !["bridge", "overlay"].includes(String(def.driver))) deny(`Network "${name}" uses the ${String(def.driver)} driver`);
  }

  for (const [name, svc] of Object.entries(services)) {
    if (!isObj(svc)) continue;
    const s = `Service "${name}"`;
    if (truthy(svc.privileged)) deny(`${s} is privileged`);
    for (const cap of list(svc.cap_add)) {
      const c = String(cap).toUpperCase().replace(/^CAP_/, "");
      if (!DEFAULT_CAPS.has(c)) deny(`${s} adds the ${c} capability`);
    }
    if (list(svc.devices).length) deny(`${s} maps host devices`);
    if (list(svc.device_cgroup_rules).length) deny(`${s} sets device_cgroup_rules`);
    if (svc.cgroup_parent !== undefined) deny(`${s} sets cgroup_parent`);
    for (const opt of list(svc.security_opt)) {
      const o = String(opt).toLowerCase().replace(/[:=]/, "=");
      if (!/^no-new-privileges(=true)?$/.test(o)) deny(`${s} sets security_opt ${String(opt)}`);
    }
    for (const key of ["pid", "ipc", "uts", "userns_mode", "cgroup"] as const) {
      const v = svc[key];
      if (v === undefined || v === null || v === "") continue;
      const str = String(v);
      if (str === "private" || (key === "ipc" && str === "shareable")) continue;
      const m = /^service:(.+)$/.exec(str);
      if (m && names.has(m[1])) continue;
      deny(`${s} sets ${key}: ${str}`);
    }
    if (svc.network_mode !== undefined && svc.network_mode !== null) {
      const nm = String(svc.network_mode);
      const m = /^service:(.+)$/.exec(nm);
      if (!(nm === "bridge" || nm === "none" || (m && names.has(m[1])))) deny(`${s} sets network_mode: ${nm}`);
    }
    for (const vf of list(svc.volumes_from)) {
      const v = String(vf).split(":");
      const target = v[0] === "container" ? null : v[0] === "service" ? v[1] : v[0];
      if (!target || !names.has(target)) deny(`${s} takes volumes from ${String(vf)}: only from services in this file`);
    }
    for (const vol of list(svc.volumes)) {
      if (typeof vol === "string") {
        const src = shortVolumeSource(vol);
        // A named volume must be declared at the top level (compose checks), so the rules above cover it
        if (src && isBindSource(src)) deny(`${s} mounts the host path ${src}: use a named volume`);
      } else if (isObj(vol)) {
        const type = String(vol.type ?? "volume");
        if (type === "bind" || type === "npipe" || type === "cluster") deny(`${s} mounts ${type === "bind" ? `the host path ${String(vol.source ?? "")}` : `a ${type}`}: use a named volume`);
        if (type === "image") continue; // read-only image contents
        if (type === "volume" && typeof vol.source === "string" && isBindSource(vol.source)) deny(`${s} mounts the host path ${vol.source}`);
      }
    }
    // Traefik routes are DeployNow's job: a label of its own could claim any domain, DeployNow's included
    const own = opts.ownLabels?.(name) ?? new Set<string>();
    for (const k of labelKeys(svc.labels)) {
      if (/^traefik\./i.test(k) && !own.has(k)) deny(`${s} sets the Traefik label ${k}: add domains to the app in DeployNow instead`);
    }
  }
}
