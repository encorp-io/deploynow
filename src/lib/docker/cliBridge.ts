/**
 * Run the docker CLI (docker build, docker compose) against any endpoint.
 *
 * The CLI only understands DOCKER_HOST, so for SSH and TLS endpoints we open a
 * private unix socket in a 0700 temp directory and forward each connection to
 * the endpoint: over SSH with `docker system dial-stdio` (the same transport
 * dockerode uses, with the pinned host key), or over mutual TLS. Keys never
 * touch the disk; only registry credentials are written, to a config.json in
 * the same temp directory, which is removed afterwards.
 */
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import tls from "tls";
import { Client as SshClient } from "ssh2";
import { sshFingerprint, type EndpointConnection } from "./client";

export interface CliEnv {
  dir: string;
  env: Record<string, string | undefined>;
}

export interface RegistryLogin {
  serveraddress: string;
  username: string;
  password: string;
}

function connectSsh(conn: EndpointConnection): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    const pinned = conn.hostKeyFingerprint || "";
    client
      .on("ready", () => resolve(client))
      .on("error", reject)
      .connect({
        host: conn.host,
        port: conn.port ?? 22,
        username: conn.username || "root",
        privateKey: conn.credentials.privateKey,
        passphrase: conn.credentials.passphrase || undefined,
        readyTimeout: 15_000,
        keepaliveInterval: 15_000,
        hostVerifier: (key: Buffer) => !pinned || pinned === sshFingerprint(key),
      });
  });
}

/**
 * Give `fn` an environment whose DOCKER_HOST reaches the endpoint.
 * Everything is torn down when `fn` settles.
 */
export async function withDockerCli<T>(
  conn: EndpointConnection,
  registries: RegistryLogin[],
  fn: (cli: CliEnv) => Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-cli-"));
  fs.chmodSync(dir, 0o700);
  const auths = Object.fromEntries(
    registries.map((r) => [r.serveraddress, { auth: Buffer.from(`${r.username}:${r.password}`).toString("base64") }]),
  );
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ auths }), { mode: 0o600 });

  let server: net.Server | null = null;
  let ssh: SshClient | null = null;
  const sockets = new Set<net.Socket>();
  let dockerHost: string;

  try {
    if (conn.type === "socket") {
      dockerHost = `unix://${conn.host || "/var/run/docker.sock"}`;
    } else {
      const sockPath = path.join(dir, "docker.sock");
      if (conn.type === "ssh") ssh = await connectSsh(conn);
      server = net.createServer((local) => {
        sockets.add(local);
        local.on("close", () => sockets.delete(local));
        local.on("error", () => local.destroy());
        if (ssh) {
          ssh.exec("docker system dial-stdio", (err, stream) => {
            if (err) return local.destroy();
            local.pipe(stream).pipe(local);
            stream.on("close", () => local.destroy());
            local.on("close", () => stream.close());
          });
        } else {
          const remote = tls.connect({
            host: conn.host,
            port: conn.port ?? 2376,
            ca: conn.credentials.ca,
            cert: conn.credentials.cert,
            key: conn.credentials.key,
            servername: net.isIP(conn.host) ? undefined : conn.host,
          });
          remote.on("error", () => local.destroy());
          local.on("close", () => remote.destroy());
          local.pipe(remote).pipe(local);
        }
      });
      await new Promise<void>((resolve, reject) => server!.once("error", reject).listen(sockPath, () => resolve()));
      fs.chmodSync(sockPath, 0o600);
      dockerHost = `unix://${sockPath}`;
    }

    const env: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: dir,
      DOCKER_HOST: dockerHost,
      DOCKER_CONFIG: dir,
      DOCKER_BUILDKIT: "1",
      BUILDX_NO_DEFAULT_ATTESTATIONS: "1",
      COMPOSE_ANSI: "never",
      NO_COLOR: "1",
    };
    return await fn({ dir, env });
  } finally {
    for (const s of sockets) s.destroy();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    ssh?.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface RunOptions {
  cwd?: string;
  env: Record<string, string | undefined>;
  onOutput: (line: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Data written to stdin, then closed */
  input?: string;
}

/** Run a command without a shell, streaming output lines. Rejects on a non-zero exit. */
export function runCommand(cmd: string, args: string[], opts: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let buffered = "";
    const flush = (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n|\r/);
      buffered = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) opts.onOutput(l);
    };
    child.stdout.on("data", flush);
    child.stderr.on("data", flush);
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();

    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : undefined;
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, sig) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (buffered.trim()) opts.onOutput(buffered);
      if (code === 0) return resolve();
      if (opts.signal?.aborted) return reject(new Error("Cancelled"));
      reject(new Error(sig ? `${cmd} was stopped (${sig})` : `${cmd} exited with code ${code}`));
    });
  });
}
