/**
 * Short-lived helper containers on an endpoint, through the Docker API.
 *
 * Backups, restores, database dumps and host probes all run this way, so they
 * work the same on a local socket, over SSH, TLS or through an agent.
 */
import type Docker from "dockerode";
import { PassThrough } from "stream";
import { pullImage } from "../docker/recreate";

export const HELPER_LABEL = "deploynow.helper";

export interface HelperOptions {
  image: string;
  cmd: string[];
  entrypoint?: string[];
  env?: Record<string, string>;
  /** "volume:/path[:ro]" or "/host/path:/path[:ro]" */
  binds?: string[];
  networkMode?: string;
  user?: string;
  timeoutMs?: number;
  name?: string;
  /** Called with each output line as it arrives */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
}

export interface HelperResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

export async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch {
    await pullImage(docker, image);
  }
}

function lineSplitter(stream: "stdout" | "stderr", sink: (s: string) => void, onLine?: HelperOptions["onLine"]) {
  let buf = "";
  const out = new PassThrough();
  out.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    sink(text);
    if (!onLine) return;
    buf += text;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i).replace(/\r$/, ""), stream);
      buf = buf.slice(i + 1);
    }
  });
  out.on("end", () => {
    if (onLine && buf) onLine(buf, stream);
  });
  return out;
}

/** Run a container to completion and return its exit code and output. The container is always removed. */
export async function runHelper(docker: Docker, opts: HelperOptions): Promise<HelperResult> {
  await ensureImage(docker, opts.image);
  let stdout = "";
  let stderr = "";
  const add = (which: "out" | "err") => (s: string) => {
    if (which === "out") stdout = (stdout + s).slice(-MAX_CAPTURE);
    else stderr = (stderr + s).slice(-MAX_CAPTURE);
  };
  const container = await docker.createContainer({
    name: opts.name,
    Image: opts.image,
    Cmd: opts.cmd,
    Entrypoint: opts.entrypoint,
    Env: Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    User: opts.user,
    Labels: { [HELPER_LABEL]: "true" },
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: { Binds: opts.binds ?? [], NetworkMode: opts.networkMode, AutoRemove: false },
  });
  try {
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const outS = lineSplitter("stdout", add("out"), opts.onLine);
    const errS = lineSplitter("stderr", add("err"), opts.onLine);
    container.modem.demuxStream(stream, outS, errS);
    const ended = new Promise<void>((r) => {
      stream.on("end", r);
      stream.on("close", r);
      stream.on("error", () => r());
    });
    await container.start();
    const timeout = opts.timeoutMs ?? 6 * 3600_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => container.kill().catch(() => {});
    opts.signal?.addEventListener("abort", onAbort);
    const result = (await Promise.race([
      container.wait(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          container.kill().catch(() => {});
          reject(new Error(`Timed out after ${Math.round(timeout / 1000)}s`));
        }, timeout);
      }),
    ])) as { StatusCode: number };
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    // Let the last output drain
    await Promise.race([ended, new Promise((r) => setTimeout(r, 2000))]);
    outS.end();
    errS.end();
    return { code: result.StatusCode, stdout, stderr };
  } finally {
    await container.remove({ force: true, v: false }).catch(() => {});
  }
}

/** Run a shell command in a running container. */
export async function execIn(docker: Docker, containerRef: string, command: string, opts: { timeoutMs?: number; onLine?: HelperOptions["onLine"]; user?: string } = {}): Promise<HelperResult> {
  const c = docker.getContainer(containerRef);
  const exec = await c.exec({ Cmd: ["sh", "-c", command], AttachStdout: true, AttachStderr: true, User: opts.user });
  const stream = await exec.start({ hijack: true, stdin: false });
  let stdout = "";
  let stderr = "";
  const outS = lineSplitter("stdout", (s) => (stdout = (stdout + s).slice(-MAX_CAPTURE)), opts.onLine);
  const errS = lineSplitter("stderr", (s) => (stderr = (stderr + s).slice(-MAX_CAPTURE)), opts.onLine);
  docker.modem.demuxStream(stream, outS, errS);
  const timeout = opts.timeoutMs ?? 3600_000;
  await Promise.race([
    new Promise<void>((r) => {
      stream.on("end", r);
      stream.on("close", r);
    }),
    new Promise<void>((_, reject) => setTimeout(() => {
      stream.destroy();
      reject(new Error(`Timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout)),
  ]);
  outS.end();
  errS.end();
  const info = await exec.inspect();
  return { code: info.ExitCode ?? -1, stdout, stderr };
}
