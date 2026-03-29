import { prisma } from "./prisma";

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
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
  });
  if (!settings?.portainerUrl || !settings?.portainerApiKey) {
    throw new Error("Portainer not configured");
  }
  return settings;
}

async function portainerFetch(path: string, options: RequestInit = {}) {
  const settings = await getSettings();
  const url = `${settings.portainerUrl.replace(/\/$/, "")}/api${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      "X-API-Key": settings.portainerApiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Portainer API error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function getEndpoints(): Promise<PortainerEndpoint[]> {
  return portainerFetch("/endpoints");
}

export async function getContainers(
  endpointId: number = 1
): Promise<PortainerContainer[]> {
  return portainerFetch(`/endpoints/${endpointId}/docker/containers/json?all=true`);
}

export async function getContainerInspect(
  endpointId: number,
  containerId: string
) {
  return portainerFetch(
    `/endpoints/${endpointId}/docker/containers/${containerId}/json`
  );
}

export async function pullImage(endpointId: number, image: string) {
  const settings = await getSettings();
  const url = `${settings.portainerUrl.replace(/\/$/, "")}/api/endpoints/${endpointId}/docker/images/create?fromImage=${encodeURIComponent(image)}`;

  const headers: Record<string, string> = {
    "X-API-Key": settings.portainerApiKey,
  };

  // If we have a GitHub token, add registry auth for ghcr.io
  if (settings.githubToken && image.startsWith("ghcr.io")) {
    const authConfig = Buffer.from(
      JSON.stringify({
        username: "token",
        password: settings.githubToken,
        serveraddress: "ghcr.io",
      })
    ).toString("base64");
    headers["X-Registry-Auth"] = authConfig;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pull failed ${res.status}: ${text}`);
  }

  // Consume the streaming response
  await res.text();
  return true;
}

export async function recreateContainer(
  endpointId: number,
  containerId: string
) {
  // 1. Inspect current container to get its config
  const inspect = await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/${containerId}/json`
  );

  const config = inspect.Config;
  const hostConfig = inspect.HostConfig;
  const networkingConfig = inspect.NetworkSettings;
  const name = inspect.Name.replace(/^\//, "");

  // 2. Stop the container
  try {
    await portainerFetch(
      `/endpoints/${endpointId}/docker/containers/${containerId}/stop`,
      { method: "POST" }
    );
  } catch {
    // May already be stopped
  }

  // 3. Remove the container
  await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/${containerId}?force=true`,
    { method: "DELETE" }
  );

  // 4. Create a new container with the same config
  const createBody = {
    ...config,
    HostConfig: hostConfig,
    NetworkingConfig: {
      EndpointsConfig: networkingConfig?.Networks || {},
    },
    name,
  };

  const created = await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/create?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      body: JSON.stringify(createBody),
    }
  );

  // 5. Start the new container
  await portainerFetch(
    `/endpoints/${endpointId}/docker/containers/${created.Id}/start`,
    { method: "POST" }
  );

  return created.Id;
}

export function parseImageRef(image: string): {
  registry: string;
  repository: string;
  tag: string;
  full: string;
} {
  // Handle images like ghcr.io/org/repo:tag, docker.io/library/nginx:latest, etc.
  let registry = "docker.io";
  let repository = image;
  let tag = "latest";

  // Split off tag
  const colonIdx = repository.lastIndexOf(":");
  if (colonIdx > -1 && !repository.substring(colonIdx).includes("/")) {
    tag = repository.substring(colonIdx + 1);
    repository = repository.substring(0, colonIdx);
  }

  // Detect registry
  const parts = repository.split("/");
  if (parts.length >= 2 && (parts[0].includes(".") || parts[0].includes(":"))) {
    registry = parts[0];
    repository = parts.slice(1).join("/");
  }

  return {
    registry,
    repository,
    tag,
    full: `${registry}/${repository}:${tag}`,
  };
}

export function isFloatingTag(tag: string): boolean {
  const floatingTags = ["latest", "main", "master", "dev", "develop", "staging", "nightly", "edge"];
  return floatingTags.includes(tag.toLowerCase());
}
