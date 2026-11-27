/**
 * What an image tag points to in its registry, for any registry: GHCR and
 * Docker Hub go through lib/ghcr.ts, everything else (Quay, lscr.io, GitLab,
 * a self-hosted registry, ...) through the Docker Registry v2 API with the
 * standard token challenge.
 */
import { getRemoteDigests, type RemoteDigests } from "./ghcr";
import { parseImageRef } from "./imageRef";
import { normalizeRegistryHost } from "./registryAuth";
import { BlockedAddressError, guardedGet, type GuardedResponse } from "./netGuard";

const ACCEPT_ALL = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ");
const ACCEPT_SINGLE = ["application/vnd.docker.distribution.manifest.v2+json", "application/vnd.oci.image.manifest.v1+json"].join(", ");
const INDEX_TYPES = ["application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.index.v1+json"];
const TIMEOUT_MS = 20_000;

type Creds = { username: string; password: string };

function normalizeArch(arch?: string): string {
  if (!arch || arch === "x64" || arch === "x86_64") return "amd64";
  if (arch === "aarch64") return "arm64";
  return arch;
}

/** Parse `Bearer realm="...",service="...",scope="..."`. */
export function parseChallenge(header: string): { scheme: string; params: Record<string, string> } | null {
  const m = /^\s*(\w+)\s*(.*)$/.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[2].matchAll(/(\w+)="([^"]*)"/g)) params[p[1].toLowerCase()] = p[2];
  return { scheme: m[1].toLowerCase(), params };
}

const MAX_REDIRECTS = 3;

/**
 * GET through netGuard: the image host and the token realm come from whoever
 * configured the app, so cloud metadata and link-local addresses are refused.
 * Private ranges stay allowed (a self-hosted registry on the LAN is normal, and
 * operators can run containers there anyway). Redirects (lscr.io → ghcr.io) are
 * followed by hand, each hop checked again, https only, and credentials are
 * dropped when the host changes.
 */
async function get(url: string, headers: Record<string, string>): Promise<GuardedResponse> {
  let current = new URL(url);
  let h = headers;
  for (let hop = 0; ; hop++) {
    const res = await guardedGet(current, { headers: h, allowPrivate: true, timeoutMs: TIMEOUT_MS, maxBodyBytes: 4 * 1024 * 1024 });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects from the registry");
    const next = new URL(location, current);
    if (next.protocol !== "https:") throw new BlockedAddressError("The registry redirected to a non-https address");
    if (next.host !== current.host) {
      const { Authorization: _drop, ...rest } = h;
      h = rest;
    }
    current = next;
  }
}

/** A registry speaking the v2 API at https://<host>. */
async function genericDigests(host: string, repository: string, tag: string, arch: string, creds?: Creds): Promise<RemoteDigests | null> {
  const base = `https://${host}/v2/${repository}/manifests/`;
  let auth = "";

  const fetchManifest = async (ref: string, accept: string): Promise<GuardedResponse> => {
    let res = await get(base + ref, { Accept: accept, ...(auth ? { Authorization: auth } : {}) });
    if (res.status !== 401 || auth) return res;
    const challenge = parseChallenge(res.headers.get("www-authenticate") ?? "");
    if (challenge?.scheme === "basic") {
      if (!creds) return res;
      auth = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`;
    } else if (challenge?.scheme === "bearer" && challenge.params.realm) {
      const realm = new URL(challenge.params.realm);
      if (realm.protocol !== "https:") throw new Error(`${host} asks for a token over plain http`);
      if (challenge.params.service) realm.searchParams.set("service", challenge.params.service);
      realm.searchParams.set("scope", challenge.params.scope || `repository:${repository}:pull`);
      const tokenRes = await get(realm.toString(), creds ? { Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}` } : {});
      if (!tokenRes.ok) throw new Error(`${host} refused a pull token (status ${tokenRes.status})`);
      const body = (await tokenRes.json()) as { token?: string; access_token?: string };
      const token = body.token || body.access_token;
      if (!token) throw new Error(`${host} sent no pull token`);
      auth = `Bearer ${token}`;
    } else {
      return res;
    }
    res = await get(base + ref, { Accept: accept, Authorization: auth });
    return res;
  };

  const res = await fetchManifest(tag, ACCEPT_ALL);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${host} manifest request failed (status ${res.status})`);
  const tagDigest = res.headers.get("docker-content-digest") ?? "";
  const body = (await res.json()) as { mediaType?: string; manifests?: { digest: string; platform?: { architecture?: string; os?: string } }[]; config?: { digest?: string } };
  const mediaType = body.mediaType || res.headers.get("content-type")?.split(";")[0] || "";
  if (INDEX_TYPES.includes(mediaType) || Array.isArray(body.manifests)) {
    const list = (body.manifests ?? []).filter((m) => m.platform?.os === "linux" || !m.platform?.os);
    const target = list.find((m) => m.platform?.architecture === arch) ?? list[0];
    if (!target) return null;
    const pRes = await fetchManifest(target.digest, ACCEPT_SINGLE);
    if (!pRes.ok) return null;
    const p = (await pRes.json()) as { config?: { digest?: string } };
    return p.config?.digest ? { config: p.config.digest, manifest: tagDigest } : null;
  }
  return body.config?.digest ? { config: body.config.digest, manifest: tagDigest } : null;
}

/**
 * Digests of what `image` (a tag, not a digest reference) points to now, or
 * null when the registry doesn't have it. Throws on network or auth errors.
 */
export async function registryDigests(image: string, opts: { arch?: string; auth?: Creds } = {}): Promise<RemoteDigests | null> {
  const ref = parseImageRef(image);
  const host = normalizeRegistryHost(ref.registry);
  const creds = opts.auth?.username ? { username: opts.auth.username, password: opts.auth.password } : undefined;
  if (host === "ghcr.io" || host === "docker.io") return getRemoteDigests(host, ref.repository, ref.tag, opts.arch, creds);
  if (host === "localhost" || /^localhost:/.test(host)) throw new Error(`${host} is a local registry; it can't be checked from DeployNow`);
  return genericDigests(host, ref.repository, ref.tag, normalizeArch(opts.arch), creds);
}
