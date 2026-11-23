import { prisma } from "./prisma";
import { decryptSecret } from "./secretsCrypto";

interface TokenResponse {
  token: string;
}

interface ManifestList {
  mediaType: string;
  manifests?: Array<{
    digest: string;
    mediaType: string;
    platform?: { architecture: string; os: string };
  }>;
}

interface ImageManifest {
  mediaType?: string;
  config?: { digest: string };
  digest?: string;
}

async function getGithubCredentials(): Promise<{ user: string; token: string }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const token = settings?.githubToken ? decryptSecret(settings.githubToken) : "";
  const user = settings?.githubUser ?? "";
  return { user, token };
}

async function getRegistryToken(repository: string, ghUser: string, ghToken: string): Promise<string> {
  const url = `https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io`;
  const headers: Record<string, string> = {};

  if (ghUser && ghToken) {
    headers["Authorization"] = `Basic ${Buffer.from(`${ghUser}:${ghToken}`).toString("base64")}`;
  } else if (ghToken) {
    headers["Authorization"] = `Bearer ${ghToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get GHCR registry token (status ${res.status})`);
  }
  const data: TokenResponse = await res.json();
  return data.token;
}

const ACCEPT_ALL = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
].join(", ");

const ACCEPT_SINGLE = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

/**
 * Normalize architecture name to Docker convention.
 */
function normalizeArch(arch?: string): string {
  if (!arch) return "amd64";
  if (arch === "x64" || arch === "x86_64") return "amd64";
  if (arch === "aarch64") return "arm64";
  return arch; // amd64, arm64, arm, etc. already correct
}

/**
 * Resolves the image config digest for a given tag.
 *
 * Docker's ImageID (what Portainer returns) is the config digest — i.e. the
 * sha256 of the image config JSON. For multi-arch images the registry returns
 * a manifest list/index; we must resolve it to the amd64 manifest, then read
 * its config.digest to get a value comparable to the local ImageID.
 */
/**
 * Get the image config digest for the given tag and architecture.
 * The `arch` parameter should be the architecture of the currently running
 * container (from Portainer image inspect), so we compare apples to apples.
 */
export async function getRemoteDigest(
  registry: string,
  repository: string,
  tag: string,
  arch?: string,
): Promise<string | null> {
  return (await getRemoteDigests(registry, repository, tag, arch))?.config ?? null;
}

export interface RemoteDigests {
  /** Image config digest for the platform: Docker's ImageID with the classic image store */
  config: string;
  /** Digest of what the tag points to (index or manifest): the ImageID with the containerd image store, and the RepoDigest */
  manifest: string;
}

/**
 * Both digests for a tag, so a local image can be matched whichever image store
 * the Docker daemon uses (Docker 29+ defaults to containerd, where the ImageID
 * is the index digest rather than the config digest).
 */
export async function getRemoteDigests(
  registry: string,
  repository: string,
  tag: string,
  arch?: string,
  creds?: { username: string; password: string },
): Promise<RemoteDigests | null> {
  const targetArch = normalizeArch(arch);

  if (registry !== "ghcr.io") {
    return getDockerHubDigests(repository, tag, targetArch, creds);
  }

  // A registry login (shared, project or the app's own) wins over the legacy Settings token
  const { user: ghUser, token: ghToken } = creds ? { user: creds.username, token: creds.password } : await getGithubCredentials();
  const registryToken = await getRegistryToken(repository, ghUser, ghToken);

  // Step 1: Fetch the manifest (could be a single manifest or a manifest list)
  const url = `https://ghcr.io/v2/${repository}/manifests/${tag}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${registryToken}`,
      Accept: ACCEPT_ALL,
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GHCR manifest request failed (status ${res.status})`);
  }

  const body = await res.json();
  const mediaType: string = body.mediaType || "";
  const tagDigest = res.headers?.get?.("docker-content-digest") ?? "";
  const both = (config: string | undefined) => (config ? { config, manifest: tagDigest } : null);

  // Step 2: If it's a manifest list / OCI index, resolve to the correct arch manifest
  if (
    mediaType === "application/vnd.docker.distribution.manifest.list.v2+json" ||
    mediaType === "application/vnd.oci.image.index.v1+json"
  ) {
    const list = body as ManifestList;
    // Match the architecture of the currently running container image.
    // This ensures that if a container runs amd64 (even on an arm64 host via emulation),
    // we compare against the amd64 manifest in the registry.
    const realManifests = list.manifests?.filter(
      (m) => m.platform?.os === "linux" || !m.platform?.os
    ) || [];
    const target =
      realManifests.find((m) => m.platform?.architecture === targetArch) ||
      realManifests[0];
    if (!target) return null;

    // Fetch the platform-specific manifest
    const platformRes = await fetch(
      `https://ghcr.io/v2/${repository}/manifests/${target.digest}`,
      {
        headers: {
          Authorization: `Bearer ${registryToken}`,
          Accept: ACCEPT_SINGLE,
        },
      }
    );
    if (!platformRes.ok) return null;

    const platformManifest: ImageManifest = await platformRes.json();
    // The config.digest is the image config hash — same as Docker's ImageID
    return both(platformManifest.config?.digest);
  }

  // Step 3: Single-platform manifest — config.digest is what we need
  const manifest = body as ImageManifest;
  return both(manifest.config?.digest);
}

async function getDockerHubDigests(repository: string, tag: string, targetArch: string, creds?: { username: string; password: string }): Promise<RemoteDigests | null> {
  const repo = repository.includes("/") ? repository : `library/${repository}`;

  // Signed in: private repositories work, and the pull rate limit is the account's
  const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  const tokenRes = creds
    ? await fetch(tokenUrl, { headers: { Authorization: `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}` } })
    : await fetch(tokenUrl);
  if (!tokenRes.ok) return null;
  const { token } = await tokenRes.json();

  // Step 1: Get the manifest (could be multi-arch)
  const url = `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: ACCEPT_ALL,
    },
  });

  if (!res.ok) return null;

  const body = await res.json();
  const mediaType: string = body.mediaType || "";
  const tagDigest = res.headers?.get?.("docker-content-digest") ?? "";
  const both = (config: string | undefined) => (config ? { config, manifest: tagDigest } : null);

  // Step 2: Handle manifest list
  if (
    mediaType === "application/vnd.docker.distribution.manifest.list.v2+json" ||
    mediaType === "application/vnd.oci.image.index.v1+json"
  ) {
    const list = body as ManifestList;
    const realManifests = list.manifests?.filter(
      (m) => m.platform?.os === "linux" || !m.platform?.os
    ) || [];
    const target =
      realManifests.find((m) => m.platform?.architecture === targetArch) ||
      realManifests[0];
    if (!target) return null;

    const platformRes = await fetch(
      `https://registry-1.docker.io/v2/${repo}/manifests/${target.digest}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: ACCEPT_SINGLE,
        },
      }
    );
    if (!platformRes.ok) return null;

    const platformManifest: ImageManifest = await platformRes.json();
    return both(platformManifest.config?.digest);
  }

  // Step 3: Single manifest
  const manifest = body as ImageManifest;
  return both(manifest.config?.digest);
}

export async function getAvailableTags(registry: string, repository: string): Promise<string[]> {
  if (registry !== "ghcr.io") return [];

  const { user: ghUser, token: ghToken } = await getGithubCredentials();
  const registryToken = await getRegistryToken(repository, ghUser, ghToken);

  const url = `https://ghcr.io/v2/${repository}/tags/list`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${registryToken}` },
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.tags ?? [];
}
