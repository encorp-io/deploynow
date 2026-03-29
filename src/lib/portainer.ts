import { prisma } from "./prisma";
import { decryptSecret } from "./secretsCrypto";

interface PortainerContainer {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  State: string;
  Status: string;
  Labels: Record<string, string>;
}

interface PortainerEndpoint {
  Id: number;
  Name: string;
  Type: number;
}

async function getSettings() {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings?.portainerUrl || !settings?.portainerApiKey) {
    throw new Error("Portainer not configured");
  }
  return {
    ...settings,
    portainerApiKey: decryptSecret(settings.portainerApiKey),
  };
}

async function portainerFetch(path: string, options: RequestInit = {}) {
  const settings = await getSettings();
  const base = settings.portainerUrl.replace(/\/$/, "");
  const url = `${base}/api${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-Key": settings.portainerApiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    // Don't include response body — may contain internal details
    throw new Error(`Portainer API error ${res.status} on ${path}`);
  }

  return res.json();
}

export async function getEndpoints(): Promise<PortainerEndpoint[]> {
  return portainerFetch("/endpoints");
}

export async function getConfiguredEndpointId(): Promise<number> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return settings?.portainerEndpointId ?? 1;
}

export async function getContainers(endpointId: number): Promise<PortainerContainer[]> {
  return portainerFetch(`/endpoints/${endpointId}/docker/containers/json?all=true`);
}

export async function getContainerInspect(endpointId: number, containerId: string) {
  return portainerFetch(`/endpoints/${endpointId}/docker/containers/${containerId}/json`);
}

export async function pullImage(endpointId: number, image: string) {
  const settings = await getSettings();
  const base = settings.portainerUrl.replace(/\/$/, "");
  const url = `${base}/api/endpoints/${endpointId}/docker/images/create?fromImage=${encodeURIComponent(image)}`;

  const headers: Record<string, string> = {
    "X-API-Key": settings.portainerApiKey,
  };

  if (settings.githubToken && image.startsWith("ghcr.io")) {
    const decryptedGhToken = decryptSecret(settings.githubToken);
    if (decryptedGhToken) {
      const authConfig = Buffer.from(
        JSON.stringify({
          username: "token",
          password: decryptedGhToken,
          serveraddress: "ghcr.io",
        })
      ).toString("base64");
      headers["X-Registry-Auth"] = authConfig;
    }
  }

  const res = await fetch(url, { method: "POST", headers });

  if (!res.ok) {
    throw new Error(`Image pull failed with status ${res.status}`);
  }

  await res.text(); // consume streaming response
  return true;
}

export async function recreateContainer(endpointId: number, containerId: string) {
  const inspect = await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/${containerId}/json`
  );

  const config          = inspect.Config;
  const hostConfig      = inspect.HostConfig;
  const networkingConfig = inspect.NetworkSettings;
  const name            = inspect.Name.replace(/^\//, "");

  try {
    await portainerFetch(
      `/endpoints/${endpointId}/docker/containers/${containerId}/stop`,
      { method: "POST" }
    );
  } catch {
    // Container may already be stopped — ignore
  }

  await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/${containerId}?force=true`,
    { method: "DELETE" }
  );

  const createBody = {
    ...config,
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: networkingConfig?.Networks || {} },
    name,
  };

  const created = await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/create?name=${encodeURIComponent(name)}`,
    { method: "POST", body: JSON.stringify(createBody) }
  );

  await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/${created.Id}/start`,
    { method: "POST" }
  );

  return created.Id as string;
}

export function parseImageRef(image: string): {
  registry: string;
  repository: string;
  tag: string;
  full: string;
} {
  let registry   = "docker.io";
  let repository = image;
  let tag        = "latest";

  const colonIdx = repository.lastIndexOf(":");
  if (colonIdx > -1 && !repository.substring(colonIdx).includes("/")) {
    tag        = repository.substring(colonIdx + 1);
    repository = repository.substring(0, colonIdx);
  }

  const parts = repository.split("/");
  if (parts.length >= 2 && (parts[0].includes(".") || parts[0].includes(":"))) {
    registry   = parts[0];
    repository = parts.slice(1).join("/");
  }

  return { registry, repository, tag, full: `${registry}/${repository}:${tag}` };
}

export function isFloatingTag(tag: string): boolean {
  const floatingTags = ["latest", "main", "master", "dev", "develop", "staging", "nightly", "edge"];
  return floatingTags.includes(tag.toLowerCase());
}
