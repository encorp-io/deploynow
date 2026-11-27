/**
 * Render a user's docker-compose file into the one DeployNow runs.
 *
 *  - the app's env vars (plain, secret, Vault) are NOT written into the file:
 *    compose reads them from the CLI's environment for ${VAR} interpolation,
 *    the way Portainer stack variables work, so the stored file holds no values.
 *  - every service gets deploynow.* labels; built services get an image tag
 *    per deployment (dn/<slug>-<service>:<id>) so a rollback can reuse them.
 *  - domains: Traefik labels and the proxy network on the target service.
 */
import YAML from "yaml";
import { traefikLabels, type RoutedDomain } from "../apps/config";

export class ComposeError extends Error {}

export interface RenderInput {
  compose: string;
  appId: string;
  slug: string;
  deploymentId: string;
  domains: (RoutedDomain & { service: string })[];
  proxyNetwork: string | null;
}

export interface RenderResult {
  yaml: string;
  services: string[];
  builtServices: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** labels / environment may be a list ("K=V") or a map */
function toMap(v: unknown, what: string): Record<string, string | null> {
  if (v === undefined || v === null) return {};
  if (Array.isArray(v)) {
    const out: Record<string, string | null> = {};
    for (const item of v) {
      const s = String(item);
      const i = s.indexOf("=");
      if (i === -1) out[s] = null;
      else out[s.slice(0, i)] = s.slice(i + 1);
    }
    return out;
  }
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val === null ? null : String(val)]));
  throw new ComposeError(`${what} must be a list or a map`);
}

export function renderCompose(input: RenderInput): RenderResult {
  let doc: unknown;
  try {
    doc = YAML.parse(input.compose, { maxAliasCount: 100 });
  } catch (err) {
    throw new ComposeError(`The compose file is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (!isObj(doc) || !isObj(doc.services) || !Object.keys(doc.services).length) {
    throw new ComposeError("The compose file has no services");
  }
  const services = doc.services as Record<string, Obj>;
  const names = Object.keys(services);
  const depTag = input.deploymentId.slice(-10);
  const built: string[] = [];

  const domainService = (d: { service: string }) => {
    if (d.service) return d.service;
    if (names.length === 1) return names[0];
    throw new ComposeError("This compose file has several services: choose which one each domain points to");
  };
  const domainsBySvc = new Map<string, RenderInput["domains"]>();
  for (const d of input.domains) {
    const svc = domainService(d);
    if (!services[svc]) throw new ComposeError(`Domain ${d.host} points to service "${svc}", which isn't in the compose file`);
    domainsBySvc.set(svc, [...(domainsBySvc.get(svc) ?? []), d]);
  }
  let usesProxyNetwork = false;

  for (const name of names) {
    const svc = services[name];
    if (!isObj(svc)) throw new ComposeError(`Service "${name}" is not a map`);

    const labels = toMap(svc.labels, `labels of ${name}`);
    labels["deploynow.app"] = input.appId;
    labels["deploynow.deployment"] = input.deploymentId;
    labels["deploynow.service"] = name;

    if (svc.build !== undefined) {
      svc.image = `dn/${input.slug}-${name}:${depTag}`;
      built.push(name);
    }

    const domains = domainsBySvc.get(name) ?? [];
    if (domains.length) {
      if (!input.proxyNetwork) throw new ComposeError("Set up the edge proxy on this endpoint before adding domains");
      if (svc.network_mode !== undefined) throw new ComposeError(`Service "${name}" sets network_mode, so it can't join the proxy network`);
      // Compose interpolates $VAR in labels: escape the $ in bcrypt hashes and redirect patterns
      for (const [k, v] of Object.entries(traefikLabels(input.slug, domains, input.proxyNetwork))) labels[k] = v.replace(/\$/g, "$$$$");
      if (svc.networks === undefined) {
        svc.networks = ["default", input.proxyNetwork];
      } else if (Array.isArray(svc.networks)) {
        if (!svc.networks.includes(input.proxyNetwork)) svc.networks.push(input.proxyNetwork);
      } else if (isObj(svc.networks)) {
        svc.networks[input.proxyNetwork] ??= null;
      }
      usesProxyNetwork = true;
    }
    svc.labels = labels;
  }

  if (usesProxyNetwork && input.proxyNetwork) {
    const nets = isObj(doc.networks) ? doc.networks : {};
    // A service that listed networks explicitly may not use "default"; declaring it is harmless
    nets[input.proxyNetwork] = { external: true, name: input.proxyNetwork };
    doc.networks = nets;
  }
  // Compose ignores the top-level "name" when -p is given; drop it to avoid confusion
  delete (doc as Obj).name;

  return { yaml: YAML.stringify(doc, { lineWidth: 0 }), services: names, builtServices: built };
}

/**
 * Rewrite a rendered compose file for a rollback: built services already have
 * their per-deployment image, so the build sections are dropped.
 */
export function stripBuild(renderedYaml: string): string {
  const doc = YAML.parse(renderedYaml) as Obj;
  for (const svc of Object.values((doc.services ?? {}) as Record<string, Obj>)) delete svc.build;
  return YAML.stringify(doc, { lineWidth: 0 });
}

/**
 * Point registry services at the exact images an earlier deployment ran
 * (image@sha256:…), so a rollback doesn't start whatever the tag points to now.
 * Built services and services without a recorded digest are left as they are.
 */
export function pinImages(renderedYaml: string, pins: Record<string, string>): { yaml: string; pinned: number } {
  const doc = YAML.parse(renderedYaml) as Obj;
  let pinned = 0;
  for (const [name, svc] of Object.entries((doc.services ?? {}) as Record<string, Obj>)) {
    const pin = pins[name];
    if (!pin || !isObj(svc) || svc.build !== undefined || typeof svc.image !== "string" || svc.image.startsWith("dn/")) continue;
    if (!/^[\w./:-]+@sha256:[0-9a-f]{64}$/.test(pin)) continue;
    svc.image = pin;
    pinned++;
  }
  return { yaml: pinned ? YAML.stringify(doc, { lineWidth: 0 }) : renderedYaml, pinned };
}

/** The repository part of an image reference: "ghcr.io/acme/web:1" → "ghcr.io/acme/web", "nginx" → "nginx". */
export function imageRepo(image: string): string {
  return image.replace(/@sha256:[0-9a-f]+$/, "").replace(/:[\w.-]+$/, "");
}

/** The RepoDigest of `image`'s repository among an image's RepoDigests (Docker Hub names may be written with or without docker.io/library/). */
export function matchRepoDigest(image: string, repoDigests: string[]): string {
  const strip = (r: string) => r.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "").replace(/^library\//, "");
  const want = strip(imageRepo(image));
  return repoDigests.find((d) => strip(d.split("@")[0]) === want) ?? "";
}
