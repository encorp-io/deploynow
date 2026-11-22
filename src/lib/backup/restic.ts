/**
 * Running restic: in a helper container on an endpoint (volumes, binds, dumps),
 * or with the local binary for DeployNow's own data.
 */
import type Docker from "dockerode";
import { spawn } from "child_process";
import { RESTIC_IMAGE } from "./config";
import { runHelper, type HelperResult } from "./helper";

export interface ResticRunner {
  /** Runs `restic <args>`; binds are only used by the container runner */
  run(args: string[], opts?: { binds?: string[]; onLine?: (l: string) => void; timeoutMs?: number; shell?: string }): Promise<HelperResult>;
  local: boolean;
}

export function containerRestic(docker: Docker, env: Record<string, string>): ResticRunner {
  return {
    local: false,
    run: (args, opts = {}) =>
      runHelper(docker, {
        image: RESTIC_IMAGE,
        // `shell` runs a script with restic on PATH (for restore checks); otherwise restic itself
        entrypoint: opts.shell ? ["sh", "-c"] : ["restic"],
        cmd: opts.shell ? [opts.shell] : args,
        env,
        binds: opts.binds,
        timeoutMs: opts.timeoutMs,
        onLine: opts.onLine ? (l) => opts.onLine!(l) : undefined,
      }),
  };
}

export function localRestic(env: Record<string, string>, bin = process.env.RESTIC_BIN || "restic"): ResticRunner {
  return {
    local: true,
    run: (args, opts = {}) =>
      new Promise((resolve, reject) => {
        const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as unknown as NodeJS.ProcessEnv;
        const child = opts.shell ? spawn("sh", ["-c", opts.shell], { env: childEnv }) : spawn(bin, args, { env: childEnv });
        let stdout = "";
        let stderr = "";
        let buf = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 6 * 3600_000);
        const feed = (s: string) => {
          if (!opts.onLine) return;
          buf += s;
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            opts.onLine(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        };
        child.stdout.on("data", (d: Buffer) => {
          stdout = (stdout + d.toString()).slice(-4_000_000);
          feed(d.toString());
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr = (stderr + d.toString()).slice(-4_000_000);
          feed(d.toString());
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err.message.includes("ENOENT") ? new Error("restic is not installed in this DeployNow image") : err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (buf && opts.onLine) opts.onLine(buf);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      }),
  };
}

/** The JSON summary line restic prints with --json. */
export function jsonSummary<T = Record<string, unknown>>(stdout: string): T | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const l of lines) {
    try {
      const v = JSON.parse(l);
      if (v && v.message_type === "summary") return v as T;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

export function lastError(r: HelperResult): string {
  const text = (r.stderr || r.stdout).trim().split("\n").filter(Boolean);
  const fatal = text.find((l) => l.startsWith("Fatal:")) ?? text[text.length - 1] ?? "";
  return fatal.replace(/^Fatal:\s*/, "").slice(0, 500) || `restic exited with code ${r.code}`;
}

/** Create the repository if it doesn't exist yet. Returns true when it was created. */
export async function ensureRepo(r: ResticRunner, log: (l: string) => void): Promise<boolean> {
  const probe = await r.run(["cat", "config", "--quiet"]);
  if (probe.code === 0) return false;
  // 10: the repository does not exist (restic 0.17+)
  if (probe.code !== 10 && !/does not exist|unable to open config file|Is there a repository/i.test(probe.stderr)) {
    throw new Error(`Can't open the backup repository: ${lastError(probe)}`);
  }
  log("Creating the restic repository");
  const init = await r.run(["init"]);
  if (init.code !== 0) throw new Error(`Can't create the backup repository: ${lastError(init)}`);
  return true;
}

export interface Snapshot {
  id: string;
  short_id: string;
  time: string;
  hostname: string;
  paths: string[];
  tags?: string[];
  summary?: { total_files_processed?: number; total_bytes_processed?: number; data_added?: number };
}

export async function listSnapshots(r: ResticRunner, tags: string[] = []): Promise<Snapshot[]> {
  const args = ["snapshots", "--json"];
  for (const t of tags) args.push("--tag", t);
  const res = await r.run(args);
  if (res.code !== 0) throw new Error(`Can't list snapshots: ${lastError(res)}`);
  try {
    const v = JSON.parse(res.stdout.trim() || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function tagValue(s: Snapshot, name: string): string {
  const t = (s.tags ?? []).find((x) => x.startsWith(name + "="));
  return t ? t.slice(name.length + 1) : "";
}
