import { prisma } from "./prisma";

interface TokenResponse {
  token: string;
}

interface ManifestResponse {
  config?: { digest: string };
  digest?: string;
  mediaType?: string;
  manifests?: Array<{ digest: string; platform?: { architecture: string; os: string } }>;
}

async function getGithubToken(): Promise<string> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
  });
  return settings?.githubToken || "";
}

async function getRegistryToken(
  repository: string,
  ghToken: string
): Promise<string> {
  // GHCR uses token-based auth
  const url = `https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io`;
  const headers: Record<string, string> = {};

  if (ghToken) {
    headers["Authorization"] = `Bearer ${ghToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get registry token: ${res.status}`);
  }
  const data: TokenResponse = await res.json();
  return data.token;
}

export async function getRemoteDigest(
  registry: string,
  repository: string,
  tag: string
): Promise<string | null> {
  if (registry !== "ghcr.io") {
    // For non-GHCR registries, use Docker Hub v2 API
    return getDockerHubDigest(repository, tag);
  }

  const ghToken = await getGithubToken();
  const registryToken = await getRegistryToken(repository, ghToken);

  const url = `https://ghcr.io/v2/${repository}/manifests/${tag}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${registryToken}`,
      Accept: [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.index.v1+json",
      ].join(", "),
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`Registry API error ${res.status}: ${await res.text()}`);
  }

  // The Docker-Content-Digest header is the canonical digest
  const digest = res.headers.get("docker-content-digest");
  if (digest) return digest;

  // Fallback: parse the manifest
  const manifest: ManifestResponse = await res.json();
  return manifest.config?.digest || manifest.digest || null;
}

async function getDockerHubDigest(
  repository: string,
  tag: string
): Promise<string | null> {
  // Add library/ prefix for official images
  const repo = repository.includes("/") ? repository : `library/${repository}`;

  // Get token
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`
  );
  if (!tokenRes.ok) return null;
  const { token } = await tokenRes.json();

  const url = `https://registry-1.docker.io/v2/${repo}/manifests/${tag}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.docker.distribution.manifest.v2+json",
    },
  });

  if (!res.ok) return null;
  return res.headers.get("docker-content-digest");
}

export async function getAvailableTags(
  registry: string,
  repository: string
): Promise<string[]> {
  if (registry !== "ghcr.io") return [];

  const ghToken = await getGithubToken();
  const registryToken = await getRegistryToken(repository, ghToken);

  const url = `https://ghcr.io/v2/${repository}/tags/list`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${registryToken}`,
    },
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.tags || [];
}
