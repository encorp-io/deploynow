/**
 * Edge proxy per endpoint: Traefik routes app domains and gets Let's Encrypt
 * certificates with the HTTP challenge.
 *
 *   managed   DeployNow runs deploynow-traefik on ports 80/443
 *   external  an existing Traefik already runs there (Dokploy's, for example);
 *             apps join its network and use its "letsencrypt" resolver and
 *             web/websecure entrypoints, which is Dokploy's layout too
 */
import type Docker from "dockerode";
import { pullImage } from "../docker/recreate";
import { dockerStatusCode } from "../docker/client";

export const PROXY_CONTAINER = "deploynow-traefik";
export const PROXY_IMAGE = "traefik:v3.6";
export const PROXY_ACME_VOLUME = "deploynow-traefik-acme";

export async function ensureNetwork(docker: Docker, name: string, labels: Record<string, string> = {}): Promise<void> {
  try {
    await docker.getNetwork(name).inspect();
  } catch (err) {
    if (dockerStatusCode(err) !== 404) throw err;
    try {
      await docker.createNetwork({ Name: name, Driver: "bridge", Labels: { "deploynow.role": "network", ...labels } });
    } catch (e) {
      if (dockerStatusCode(e) !== 409) throw e; // created meanwhile
    }
  }
}

export function proxyArgs(email: string, network: string): string[] {
  return [
    "--providers.docker=true",
    "--providers.docker.exposedbydefault=false",
    `--providers.docker.network=${network}`,
    "--entrypoints.web.address=:80",
    "--entrypoints.websecure.address=:443",
    "--entrypoints.websecure.http.tls=true",
    `--certificatesresolvers.letsencrypt.acme.email=${email}`,
    "--certificatesresolvers.letsencrypt.acme.storage=/acme/acme.json",
    "--certificatesresolvers.letsencrypt.acme.httpchallenge=true",
    "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
    "--ping=true",
    "--log.level=WARN",
    "--accesslog=false",
    "--global.sendanonymoususage=false",
  ];
}

export interface ProxyStatus {
  running: boolean;
  image: string;
  startedAt: string | null;
  error: string;
}

export async function proxyStatus(docker: Docker): Promise<ProxyStatus> {
  try {
    const info = await docker.getContainer(PROXY_CONTAINER).inspect();
    return {
      running: info.State.Running,
      image: info.Config.Image,
      startedAt: info.State.StartedAt,
      error: info.State.Error || (info.State.Running ? "" : `Exited with code ${info.State.ExitCode}`),
    };
  } catch (err) {
    if (dockerStatusCode(err) === 404) return { running: false, image: "", startedAt: null, error: "" };
    throw err;
  }
}

/** Create or recreate the managed Traefik with the given ACME email. */
export async function installProxy(docker: Docker, opts: { email: string; network: string }): Promise<void> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email)) throw new Error("Enter the email Let's Encrypt should send expiry notices to");
  await ensureNetwork(docker, opts.network);
  try {
    await docker.getImage(PROXY_IMAGE).inspect();
  } catch {
    await pullImage(docker, PROXY_IMAGE);
  }
  await removeProxy(docker);
  const container = await docker.createContainer({
    name: PROXY_CONTAINER,
    Image: PROXY_IMAGE,
    Cmd: proxyArgs(opts.email, opts.network),
    Labels: { "deploynow.role": "proxy" },
    ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: { "80/tcp": [{ HostPort: "80" }], "443/tcp": [{ HostPort: "443" }] },
      Mounts: [
        { Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock", ReadOnly: true },
        { Type: "volume", Source: PROXY_ACME_VOLUME, Target: "/acme" },
      ],
      SecurityOpt: ["no-new-privileges"],
      NetworkMode: opts.network,
    },
  });
  try {
    await container.start();
  } catch (err) {
    const msg = (err as Error).message || "";
    if (/address already in use|port is already allocated/i.test(msg)) {
      await container.remove({ force: true }).catch(() => {});
      throw new Error("Ports 80 or 443 are already in use on this machine. If another Traefik (e.g. Dokploy's) runs there, choose \"Use existing Traefik\" instead.");
    }
    throw err;
  }
}

export async function removeProxy(docker: Docker): Promise<void> {
  try {
    await docker.getContainer(PROXY_CONTAINER).remove({ force: true });
  } catch (err) {
    if (dockerStatusCode(err) !== 404) throw err;
  }
}

/** For "external": check the network exists and something on it looks like Traefik. */
export async function checkExternalProxy(docker: Docker, network: string): Promise<{ ok: boolean; message: string }> {
  try {
    const net = await docker.getNetwork(network).inspect();
    const containers = Object.values((net.Containers ?? {}) as Record<string, { Name: string }>);
    const all = await docker.listContainers({ filters: { network: [network] } });
    const traefik = all.find((c) => /traefik/i.test(c.Image));
    if (!traefik) return { ok: false, message: `No Traefik container is attached to ${network} (${containers.length} containers on it)` };
    return { ok: true, message: `Found ${traefik.Names[0]?.replace(/^\//, "")} (${traefik.Image}) on ${network}` };
  } catch (err) {
    if (dockerStatusCode(err) === 404) return { ok: false, message: `Network ${network} doesn't exist on this endpoint` };
    throw err;
  }
}
