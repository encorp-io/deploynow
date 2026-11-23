import fs from "fs";
import type Docker from "dockerode";
import type { Endpoint } from "@prisma/client";
import { prisma } from "./prisma";
import { decryptSecret, encryptSecret } from "./secretsCrypto";
import { AGENT_TYPE, agentSocketPath } from "./agent/hub";
import {
  createDockerClient,
  dockerErrorMessage,
  ENDPOINT_TYPES,
  probeDocker,
  type EndpointConnection,
  type EndpointCredentials,
  type EndpointType,
} from "./docker/client";

export const DEFAULT_SOCKET = "/var/run/docker.sock";

const BLOCKED_HOSTS = new Set(["169.254.169.254", "169.254.170.2", "metadata.google.internal", "fd00:ec2::254"]);
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$|^\[?[0-9a-fA-F:]+\]?$/;
const NAME_RE = /^[\w .-]{1,64}$/;

export function parseCredentials(enc: string): EndpointCredentials {
  if (!enc) return {};
  try {
    return JSON.parse(decryptSecret(enc) || "{}") as EndpointCredentials;
  } catch {
    return {};
  }
}

export function encryptCredentials(creds: EndpointCredentials): string {
  const clean = Object.fromEntries(Object.entries(creds).filter(([, v]) => typeof v === "string" && v));
  return Object.keys(clean).length ? encryptSecret(JSON.stringify(clean)) : "";
}

export function toConnection(e: Pick<Endpoint, "id" | "type" | "host" | "port" | "username" | "credentials" | "hostKeyFingerprint">): EndpointConnection {
  // An agent endpoint is reached through the hub's local socket for it
  if (e.type === AGENT_TYPE) return { type: "socket", host: agentSocketPath(e.id), credentials: {} };
  return {
    type: e.type as EndpointType,
    host: e.host,
    port: e.port,
    username: e.username,
    credentials: parseCredentials(e.credentials),
    hostKeyFingerprint: e.hostKeyFingerprint,
  };
}

// One client per endpoint, rebuilt when the endpoint row changes
const clients = new Map<string, { version: number; docker: Docker }>();

export function dockerFor(e: Endpoint): Docker {
  const version = e.updatedAt.getTime();
  const cached = clients.get(e.id);
  if (cached && cached.version === version) return cached.docker;
  const docker = createDockerClient(toConnection(e));
  clients.set(e.id, { version, docker });
  return docker;
}

export class EndpointNotFoundError extends Error {
  constructor() {
    super("Endpoint not found");
  }
}

export async function getEndpointDocker(endpointId: string): Promise<{ endpoint: Endpoint; docker: Docker }> {
  const endpoint = await prisma.endpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) throw new EndpointNotFoundError();
  return { endpoint, docker: dockerFor(endpoint) };
}

/** Probe an endpoint and store its status. Never throws. */
export async function refreshEndpoint(endpoint: Endpoint): Promise<Endpoint> {
  try {
    const info = await probeDocker(dockerFor(endpoint));
    return await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { ...info, status: "online", lastSeenAt: new Date(), lastError: "" },
    });
  } catch (err) {
    return await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { status: "offline", lastError: dockerErrorMessage(err) },
    });
  }
}

/** Shape sent to the browser: never includes key material. */
export function serializeEndpoint(e: Endpoint) {
  const creds = parseCredentials(e.credentials);
  return {
    id: e.id,
    name: e.name,
    type: e.type,
    host: e.host,
    port: e.port,
    username: e.username,
    labels: e.labels ? e.labels.split(",").map((l) => l.trim()).filter(Boolean) : [],
    status: e.status,
    dockerVersion: e.dockerVersion,
    os: e.os,
    cpus: e.cpus,
    memoryBytes: e.memoryBytes,
    containers: e.containers,
    lastSeenAt: e.lastSeenAt,
    lastError: e.lastError,
    hostKeyFingerprint: e.hostKeyFingerprint,
    hasPrivateKey: !!creds.privateKey,
    hasTlsCerts: !!(creds.ca && creds.cert && creds.key),
    agent:
      e.type === AGENT_TYPE
        ? {
            enrolled: !!e.agentCertSerial,
            joinPending: !!e.agentJoinExpiresAt && e.agentJoinExpiresAt > new Date(),
            version: e.agentVersion,
            hostname: e.agentHostname,
            connectedAt: e.agentConnectedAt,
          }
        : null,
    hostMetrics: parseMetrics(e.hostMetrics),
    hostMetricsAt: e.hostMetricsAt,
    createdAt: e.createdAt,
  };
}

export interface HostMetrics {
  cpus: number;
  load1: number;
  load5: number;
  memTotal: number;
  memAvailable: number;
  diskPath: string;
  diskTotal: number;
  diskFree: number;
}

export function parseMetrics(raw: string): HostMetrics | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HostMetrics;
  } catch {
    return null;
  }
}

export interface EndpointInput {
  name: string;
  type: EndpointType | typeof AGENT_TYPE;
  host: string;
  port: number | null;
  username: string;
  labels: string;
  credentials: EndpointCredentials;
}

function str(v: unknown, max = 20_000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Validate a create/update body. With `existing`, missing key material keeps
 * the stored value, so the UI never has to send keys back.
 */
export function validateEndpointInput(
  body: Record<string, unknown>,
  existing?: Endpoint,
): { data?: EndpointInput; error?: string } {
  const name = str(body.name ?? existing?.name, 64);
  if (!NAME_RE.test(name)) return { error: "Name must be 1–64 letters, numbers, spaces, dots, dashes or underscores" };

  const rawType = body.type ?? existing?.type;
  if (rawType === AGENT_TYPE) {
    return { data: { name, type: AGENT_TYPE, host: "", port: null, username: "", labels: labels(body, existing), credentials: {} } };
  }
  const type = rawType as EndpointType;
  if (!ENDPOINT_TYPES.includes(type)) return { error: "Type must be socket, ssh, tls or agent" };

  const host = str(body.host ?? existing?.host, 255);
  let port: number | null = null;
  const prev = existing ? parseCredentials(existing.credentials) : {};
  const credentials: EndpointCredentials = {};

  if (type === "socket") {
    const path = host || DEFAULT_SOCKET;
    if (!path.startsWith("/") || path.includes("..") || !/^[\w./-]+$/.test(path)) {
      return { error: "Socket path must be an absolute path such as /var/run/docker.sock" };
    }
    return { data: { name, type, host: path, port: null, username: "", labels: labels(body, existing), credentials } };
  }

  if (!host || !HOSTNAME_RE.test(host)) return { error: "Enter a valid hostname or IP address" };
  if (BLOCKED_HOSTS.has(host.toLowerCase().replace(/^\[|\]$/g, ""))) return { error: "That host is not allowed" };

  const rawPort = body.port ?? existing?.port ?? (type === "ssh" ? 22 : 2376);
  port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Port must be between 1 and 65535" };

  let username = "";
  if (type === "ssh") {
    username = str(body.username ?? existing?.username, 64) || "root";
    if (!/^[a-z_][a-z0-9_.-]*$/i.test(username)) return { error: "Invalid SSH username" };
    credentials.privateKey = str(body.privateKey) || prev.privateKey;
    credentials.passphrase = body.passphrase !== undefined ? str(body.passphrase, 1000) : prev.passphrase;
    if (!credentials.privateKey || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(credentials.privateKey)) {
      return { error: "Paste the SSH private key (PEM or OpenSSH format)" };
    }
  } else {
    credentials.ca = str(body.ca) || prev.ca;
    credentials.cert = str(body.cert) || prev.cert;
    credentials.key = str(body.key) || prev.key;
    if (!credentials.ca?.includes("BEGIN CERTIFICATE") || !credentials.cert?.includes("BEGIN CERTIFICATE") || !credentials.key?.includes("PRIVATE KEY")) {
      return { error: "TLS needs the CA certificate, client certificate and client key (PEM)" };
    }
  }

  return { data: { name, type, host, port, username, labels: labels(body, existing), credentials } };
}

function labels(body: Record<string, unknown>, existing?: Endpoint): string {
  const raw = body.labels ?? existing?.labels ?? "";
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list
    .map((l) => String(l).trim().toLowerCase())
    .filter((l) => /^[a-z0-9_-]{1,32}$/.test(l))
    .slice(0, 10)
    .join(",");
}

export function localSocketAvailable(path = DEFAULT_SOCKET): boolean {
  try {
    return fs.statSync(path).isSocket();
  } catch {
    return false;
  }
}
