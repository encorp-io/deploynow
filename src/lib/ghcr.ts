import { prisma } from "./prisma";
import { decryptSecret } from "./secretsCrypto";

interface TokenResponse {
  token: string;
}

interface ManifestResponse {
  config?: { digest: string };
  digest?: string;
}

async function getGithubToken(): Promise<string> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const raw = settings?.githubToken ?? "";
  return raw ? decryptSecret(raw) : "";
}

async function getRegistryToken(repository: string, ghToken: string): Promise<string> {
  const url = `https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io`;
  const headers: Record<string, string> = {};

  if (ghToken) {
    headers["Authorization"] = `Bearer ${ghToken}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to get GHCR registry token (status ${res.status})`);
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
    return getDockerHubDigest(repository, tag);
  }

  const ghToken       = await getGithubToken();
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
    throw new Error(`GHCR manifest request failed (status ${res.status})`);
  }

  const digest = res.headers.get("docker-content-digest");
  if (digest) return digest;

  const manifest: ManifestResponse = await res.json();
  return manifest.config?.digest ?? manifest.digest ?? null;
}

async function getDockerHubDigest(repository: string, tag: string): Promise<string | null> {
  const repo = repository.includes("/") ? repository : `library/${repository}`;

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

export async function getAvailableTags(registry: string, repository: string): Promise<string[]> {
  if (registry !== "ghcr.io") return [];

  const ghToken       = await getGithubToken();
  const registryToken = await getRegistryToken(repository, ghToken);

  const url = `https://ghcr.io/v2/${repository}/tags/list`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${registryToken}` },
  });

  if (!res.ok) return [];
  const data = await res.json();
  return data.tags ?? [];
}
