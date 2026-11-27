/**
 * Validation and parsing of application settings, shared by the API and the
 * deploy pipeline.
 */
import { validateRepoPath, validateRepoUrl, BRANCH_RE } from "../deploy/git";
import { parseEnvInput } from "./env";

export const SOURCE_TYPES = ["image", "git-dockerfile", "git-compose", "compose"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const UPDATE_POLICIES = ["manual", "auto-digest", "on-push"] as const;
export const RESTART_POLICIES = ["no", "always", "unless-stopped", "on-failure"] as const;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}[a-z0-9]$|^[a-z0-9]$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const PATH_RE = /^\/[\w./~%-]*$/;
const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

export class ConfigError extends Error {}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 42)
      .replace(/-+$/, "") || "app"
  );
}

export { parseEnvInput } from "./env";

export interface PortMap {
  host: number | null;
  container: number;
  protocol: "tcp" | "udp";
}
export interface VolumeMount {
  name: string;
  path: string;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function port(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`${what} must be between 1 and 65535`);
  return n;
}

export function parsePorts(v: unknown): PortMap[] {
  return asArray(v).map((item) => {
    const r = item as Record<string, unknown>;
    const protocol = r?.protocol === "udp" ? "udp" : "tcp";
    return {
      container: port(r?.container, "Container port"),
      host: r?.host === null || r?.host === undefined || r?.host === "" ? null : port(r.host, "Host port"),
      protocol,
    };
  });
}

export function parseVolumes(v: unknown): VolumeMount[] {
  const seen = new Set<string>();
  return asArray(v).map((item) => {
    const r = item as Record<string, unknown>;
    const name = String(r?.name ?? "").trim().toLowerCase();
    const path = String(r?.path ?? "").trim();
    if (!VOLUME_NAME_RE.test(name)) throw new ConfigError(`Invalid volume name "${name}"`);
    if (!path.startsWith("/") || path.includes("..") || path === "/") {
      throw new ConfigError(`Invalid mount path "${path}"`);
    }
    if (seen.has(path)) throw new ConfigError(`Two volumes are mounted at ${path}`);
    seen.add(path);
    return { name, path };
  });
}

export function validateHost(raw: unknown): string {
  const host = String(raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!HOST_RE.test(host)) throw new ConfigError(`"${host}" is not a valid domain name`);
  return host;
}

export function validatePath(raw: unknown): string {
  const p = String(raw ?? "/").trim() || "/";
  if (!PATH_RE.test(p)) throw new ConfigError(`Invalid path "${p}"`);
  return p;
}

export function validateNetworkName(raw: unknown): string {
  const n = String(raw ?? "").trim();
  if (!NETWORK_RE.test(n)) throw new ConfigError("Invalid network name");
  return n;
}

/** Split a command line into arguments, honouring single and double quotes. */
export function splitCommand(cmd: string): string[] {
  const args: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) args.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
    } else {
      cur += ch;
    }
  }
  if (quote) throw new ConfigError("Unclosed quote in command");
  if (cur || has) args.push(cur);
  return args;
}

export interface AppInput {
  name: string;
  slug: string;
  sourceType: SourceType;
  image: string;
  gitRepo: string;
  gitBranch: string;
  buildContext: string;
  dockerfilePath: string;
  composePath: string;
  composeInline: string;
  env: string;
  ports: string;
  volumes: string;
  command: string;
  restartPolicy: string;
  updatePolicy: string;
}

type Existing = Partial<Record<keyof AppInput, string>> | null | undefined;

/** Validate a create or update body; fields left out keep their existing value. */
export function validateAppInput(body: Record<string, unknown>, existing?: Existing): AppInput {
  const pick = <K extends keyof AppInput>(k: K, fallback: AppInput[K]): unknown => (body[k] !== undefined ? body[k] : existing?.[k] ?? fallback);

  const name = String(pick("name", "")).trim();
  if (!name || name.length > 64) throw new ConfigError("Give the application a name (up to 64 characters)");
  const slug = String(pick("slug", "") || slugify(name)).trim();
  if (!SLUG_RE.test(slug)) throw new ConfigError("The Docker name may use lowercase letters, digits and dashes (up to 42)");

  const sourceType = pick("sourceType", "image") as SourceType;
  if (!SOURCE_TYPES.includes(sourceType)) throw new ConfigError("Choose a source: image, Dockerfile from Git, compose from Git, or compose file");

  const out: AppInput = {
    name,
    slug,
    sourceType,
    image: "",
    gitRepo: "",
    gitBranch: "main",
    buildContext: ".",
    dockerfilePath: "Dockerfile",
    composePath: "docker-compose.yml",
    composeInline: "",
    // Left out: keep the stored list as is (secret values stay encrypted)
    env: body.env !== undefined ? JSON.stringify(parseEnvInput(body.env, existing?.env ?? "[]")) : existing?.env ?? "[]",
    ports: JSON.stringify(parsePorts(pick("ports", "[]"))),
    volumes: JSON.stringify(parseVolumes(pick("volumes", "[]"))),
    command: String(pick("command", "")).trim().slice(0, 2000),
    restartPolicy: String(pick("restartPolicy", "unless-stopped")),
    updatePolicy: String(pick("updatePolicy", "manual")),
  };
  if (out.command) splitCommand(out.command);
  if (!(RESTART_POLICIES as readonly string[]).includes(out.restartPolicy)) throw new ConfigError("Invalid restart policy");
  if (!(UPDATE_POLICIES as readonly string[]).includes(out.updatePolicy)) throw new ConfigError("Invalid update policy");

  if (sourceType === "image") {
    const image = String(pick("image", "")).trim();
    if (!image || image.length > 300 || !/^[\w./:@-]+$/.test(image) || image.startsWith("-")) {
      throw new ConfigError("Enter an image such as ghcr.io/org/app:latest");
    }
    out.image = image;
    if (out.updatePolicy === "on-push") throw new ConfigError("Image apps update on a new digest, not on a Git push");
  }

  if (sourceType === "git-dockerfile" || sourceType === "git-compose") {
    try {
      out.gitRepo = validateRepoUrl(pick("gitRepo", ""));
      out.gitBranch = String(pick("gitBranch", "main")).trim() || "main";
      if (!BRANCH_RE.test(out.gitBranch)) throw new ConfigError("Invalid branch name");
      if (sourceType === "git-dockerfile") {
        out.buildContext = validateRepoPath(pick("buildContext", "."), ".");
        out.dockerfilePath = validateRepoPath(pick("dockerfilePath", "Dockerfile"), "Dockerfile");
      } else {
        out.composePath = validateRepoPath(pick("composePath", "docker-compose.yml"), "docker-compose.yml");
      }
    } catch (err) {
      throw err instanceof ConfigError ? err : new ConfigError((err as Error).message);
    }
    if (out.updatePolicy === "auto-digest") throw new ConfigError("Git apps update on push, not on a new image digest");
  }

  if (sourceType === "compose") {
    out.composeInline = String(pick("composeInline", ""));
    if (!out.composeInline.trim()) throw new ConfigError("Paste the docker-compose.yml");
    if (out.composeInline.length > 200_000) throw new ConfigError("The compose file is too large");
    if (out.updatePolicy !== "manual") throw new ConfigError("Inline compose apps are deployed by hand");
  }

  if (sourceType === "git-compose" || sourceType === "compose") {
    if (JSON.parse(out.ports).length || JSON.parse(out.volumes).length) {
      throw new ConfigError("Set ports and volumes in the compose file");
    }
  }
  return out;
}

export interface RoutedDomain {
  id: string;
  host: string;
  path: string;
  containerPort: number;
  https: boolean;
  redirectTo?: string;
  redirectCode?: number;
  basicAuth?: string;
}

/** Docker labels Traefik reads to route a domain to this app (or redirect it, or guard it with basic auth). */
export function traefikLabels(slug: string, domains: RoutedDomain[], network: string): Record<string, string> {
  if (!domains.length) return {};
  const labels: Record<string, string> = { "traefik.enable": "true", "traefik.docker.network": network };
  for (const d of domains) {
    const r = `dn-${slug}-${d.id.slice(-8)}`;
    const rule = d.path && d.path !== "/" ? `Host(\`${d.host}\`) && PathPrefix(\`${d.path}\`)` : `Host(\`${d.host}\`)`;
    labels[`traefik.http.services.${r}.loadbalancer.server.port`] = String(d.containerPort);
    const middlewares: string[] = [];
    if (d.redirectTo) {
      // Keep the path and query: https://www.example.com/a?b → https://example.com/a?b
      labels[`traefik.http.middlewares.${r}-redirect.redirectregex.regex`] = "^https?://[^/]+(.*)$";
      labels[`traefik.http.middlewares.${r}-redirect.redirectregex.replacement`] = `${d.redirectTo.replace(/\/+$/, "")}\${1}`;
      labels[`traefik.http.middlewares.${r}-redirect.redirectregex.permanent`] = String((d.redirectCode ?? 308) === 301 || (d.redirectCode ?? 308) === 308);
      middlewares.push(`${r}-redirect`);
    } else if (d.basicAuth) {
      labels[`traefik.http.middlewares.${r}-auth.basicauth.users`] = d.basicAuth.split("\n").filter(Boolean).join(",");
      labels[`traefik.http.middlewares.${r}-auth.basicauth.removeheader`] = "true";
      middlewares.push(`${r}-auth`);
    }
    labels[`traefik.http.routers.${r}.rule`] = rule;
    labels[`traefik.http.routers.${r}.service`] = r;
    if (middlewares.length) labels[`traefik.http.routers.${r}.middlewares`] = middlewares.join(",");
    if (d.https) {
      labels[`traefik.http.routers.${r}.entrypoints`] = "websecure";
      labels[`traefik.http.routers.${r}.tls.certresolver`] = "letsencrypt";
      labels[`traefik.http.routers.${r}-http.rule`] = rule;
      labels[`traefik.http.routers.${r}-http.entrypoints`] = "web";
      labels[`traefik.http.routers.${r}-http.middlewares`] = `${r}-https`;
      labels[`traefik.http.routers.${r}-http.service`] = r;
      labels[`traefik.http.middlewares.${r}-https.redirectscheme.scheme`] = "https";
      labels[`traefik.http.middlewares.${r}-https.redirectscheme.permanent`] = "true";
    } else {
      // No certificate of our own, but still answer on 443: Cloudflare's proxy (SSL mode Full)
      // and other TLS-terminating CDNs connect to the origin over HTTPS, and with only a "web"
      // router Traefik had nothing for them and answered 404. Traefik's default cert serves it.
      labels[`traefik.http.routers.${r}.entrypoints`] = "web";
      labels[`traefik.http.routers.${r}-tls.rule`] = rule;
      labels[`traefik.http.routers.${r}-tls.entrypoints`] = "websecure";
      labels[`traefik.http.routers.${r}-tls.tls`] = "true";
      labels[`traefik.http.routers.${r}-tls.service`] = r;
      if (middlewares.length) labels[`traefik.http.routers.${r}-tls.middlewares`] = middlewares.join(",");
    }
  }
  return labels;
}

export const REDIRECT_CODES = [301, 302, 307, 308];

/** "https://example.com" (no path beyond /, no query): where a redirect domain sends people. */
export function validateRedirect(raw: unknown): string {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError("The redirect must be a URL like https://example.com");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError("The redirect must start with https://");
  if (u.search || u.hash || u.username || u.password) throw new ConfigError("The redirect can't have a query, fragment or credentials");
  if (/[$`\\\s]/.test(v)) throw new ConfigError("The redirect contains characters that aren't allowed");
  return `${u.origin}${u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "")}`;
}

/** Basic auth users as htpasswd lines with bcrypt hashes ($2y$, which Traefik reads). */
export async function basicAuthLine(user: unknown, password: unknown): Promise<string> {
  const u = String(user ?? "").trim();
  const p = String(password ?? "");
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(u)) throw new ConfigError("The user name may use letters, digits and . _ @ -");
  if (p.length < 8 || p.length > 72) throw new ConfigError("The password needs 8 to 72 characters");
  const bcrypt = (await import("bcryptjs")).default;
  return `${u}:${(await bcrypt.hash(p, 10)).replace(/^\$2[ab]\$/, () => "$2y$")}`;
}
