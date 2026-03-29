import https from "https";
import http from "http";
import { prisma } from "./prisma";
import { decryptSecret } from "./secretsCrypto";

export interface PortainerContainer {
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

/**
 * Low-level HTTP(S) request for Portainer.
 * Portainer commonly uses self-signed TLS certs, so we set rejectUnauthorized: false
 * scoped to Portainer calls only (not globally).
 */
function rawRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || "GET",
        headers: options.headers || {},
        rejectUnauthorized: false, // Portainer self-signed certs
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function portainerFetch(path: string, options: RequestInit = {}) {
  const settings = await getSettings();
  const base = settings.portainerUrl.replace(/\/$/, "");
  const url = `${base}/api${path}`;

  const headers: Record<string, string> = {
    "X-API-Key": settings.portainerApiKey,
    "Content-Type": "application/json",
  };

  // Merge additional headers
  if (options.headers) {
    const h = options.headers as Record<string, string>;
    Object.assign(headers, h);
  }

  const res = await rawRequest(url, {
    method: (options.method as string) || "GET",
    headers,
    body: options.body as string | undefined,
  });

  if (res.status < 200 || res.status >= 300) {
    // Don't include response body — may contain internal details
    throw new Error(`Portainer API error ${res.status} on ${path}`);
  }

  return JSON.parse(res.body);
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

/**
 * Inspect a Docker image via Portainer to get its architecture.
 * Returns { Architecture, Os, Variant } from the image metadata.
 */
export async function getImageInspect(
  endpointId: number,
  imageId: string
): Promise<{ Architecture?: string; Os?: string; Variant?: string }> {
  return portainerFetch(
    `/endpoints/${endpointId}/docker/images/${encodeURIComponent(imageId)}/json`
  );
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
    const ghUser = settings.githubUser || "token";
    if (decryptedGhToken) {
      const authConfig = Buffer.from(
        JSON.stringify({
          username: ghUser,
          password: decryptedGhToken,
          serveraddress: "ghcr.io",
        })
      ).toString("base64");
      headers["X-Registry-Auth"] = authConfig;
    }
  }

  const res = await rawRequest(url, { method: "POST", headers });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Image pull failed with status ${res.status}`);
  }

  return true;
}

/**
 * Recreate a container using Portainer's native recreate API.
 *
 * This is much safer than manual stop→delete→create→start because Portainer
 * handles all config preservation (volumes, networks, env vars, labels, etc.)
 * internally. If PullImage is true, it pulls the latest image first.
 */
export async function recreateContainer(endpointId: number, containerId: string, pullImage = false) {
  // Portainer's recreate endpoint: POST /api/docker/{endpointId}/containers/{id}/recreate
  // This preserves the full container configuration and just swaps the image.
  const settings = await getSettings();
  const base = settings.portainerUrl.replace(/\/$/, "");
  const url = `${base}/api/docker/${endpointId}/containers/${containerId}/recreate`;

  const headers: Record<string, string> = {
    "X-API-Key": settings.portainerApiKey,
    "Content-Type": "application/json",
  };

  // If pulling a GHCR image, include registry auth
  // We need to check the container's image to decide
  let registryAuth: Record<string, string> = {};
  if (pullImage) {
    try {
      const inspect = await portainerFetch(
        `/endpoints/${endpointId}/docker/containers/${containerId}/json`
      );
      const image: string = inspect.Config?.Image || "";
      if (image.startsWith("ghcr.io") && settings.githubToken) {
        const decryptedGhToken = decryptSecret(settings.githubToken);
        const ghUser = settings.githubUser || "token";
        if (decryptedGhToken) {
          registryAuth = {
            username: ghUser,
            password: decryptedGhToken,
            serveraddress: "ghcr.io",
          };
        }
      }
    } catch {
      // Non-fatal — proceed without registry auth
    }
  }

  const body: Record<string, unknown> = { PullImage: pullImage };
  if (Object.keys(registryAuth).length > 0) {
    // Portainer expects the registry credentials in the body
    body.Registries = registryAuth;
  }

  const res = await rawRequest(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Portainer recreate failed (status ${res.status})`);
  }

  const result = JSON.parse(res.body);
  return (result.Id || result.id) as string;
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
