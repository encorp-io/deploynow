/**
 * Docker Engine API clients for each endpoint type.
 *
 *   socket  local unix socket (default /var/run/docker.sock)
 *   ssh     `docker system dial-stdio` over SSH with a private key; the host key
 *           is pinned on first connect (trust on first use)
 *   tls     Docker's TCP API on :2376 with client certificates, server verified
 *           against the given CA
 */
import crypto from "crypto";
import Docker from "dockerode";

export type EndpointType = "socket" | "ssh" | "tls";
export const ENDPOINT_TYPES: EndpointType[] = ["socket", "ssh", "tls"];

export interface EndpointCredentials {
  privateKey?: string;
  passphrase?: string;
  ca?: string;
  cert?: string;
  key?: string;
}

export interface EndpointConnection {
  type: EndpointType;
  host: string;
  port?: number | null;
  username?: string;
  credentials: EndpointCredentials;
  /** Pinned SSH host key fingerprint ("SHA256:…"); empty = accept and report the first one seen */
  hostKeyFingerprint?: string;
  /** Called with the fingerprint seen on connect (ssh only) */
  onHostKey?: (fingerprint: string) => void;
}

export class HostKeyMismatchError extends Error {
  constructor() {
    super("SSH host key does not match the pinned fingerprint");
  }
}

export function sshFingerprint(key: Buffer): string {
  return "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}

export function buildDockerOptions(conn: EndpointConnection): Docker.DockerOptions {
  switch (conn.type) {
    case "socket":
      return { socketPath: conn.host || "/var/run/docker.sock" };
    case "tls":
      return {
        protocol: "https",
        host: conn.host,
        port: conn.port ?? 2376,
        ca: conn.credentials.ca,
        cert: conn.credentials.cert,
        key: conn.credentials.key,
      };
    case "ssh": {
      const pinned = conn.hostKeyFingerprint || "";
      return {
        protocol: "ssh",
        host: conn.host,
        port: conn.port ?? 22,
        username: conn.username || "root",
        sshOptions: {
          privateKey: conn.credentials.privateKey,
          passphrase: conn.credentials.passphrase || undefined,
          readyTimeout: 10_000,
          hostVerifier: (key: Buffer) => {
            const fp = sshFingerprint(key);
            conn.onHostKey?.(fp);
            return !pinned || pinned === fp;
          },
        },
      };
    }
    default:
      throw new Error("Unknown endpoint type");
  }
}

export function createDockerClient(conn: EndpointConnection): Docker {
  return new Docker(buildDockerOptions(conn));
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what = "Docker request"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ProbeResult {
  dockerVersion: string;
  os: string;
  cpus: number;
  memoryBytes: number;
  containers: number;
}

export async function probeDocker(docker: Docker, timeoutMs = 10_000): Promise<ProbeResult> {
  const info = await withTimeout(docker.info(), timeoutMs, "Connecting to Docker");
  return {
    dockerVersion: String(info.ServerVersion ?? ""),
    os: String(info.OperatingSystem ?? ""),
    cpus: Number(info.NCPU ?? 0),
    memoryBytes: Number(info.MemTotal ?? 0),
    containers: Number(info.Containers ?? 0),
  };
}

/** Docker errors carry the daemon's message in `json.message`; keep it, drop the rest. */
export function dockerErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { json?: { message?: string }; message?: string; statusCode?: number };
    if (e.json?.message) return e.json.message;
    if (e.message) return e.message.replace(/\(HTTP code \d+\)\s*/i, "").slice(0, 300);
  }
  return "Docker request failed";
}

export function dockerStatusCode(err: unknown): number | undefined {
  return err && typeof err === "object" ? (err as { statusCode?: number }).statusCode : undefined;
}
