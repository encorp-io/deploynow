/**
 * Self-update pieces shared by DeployNow and its updater container
 * (runner.ts). Nothing here may import Prisma or Next.js: the updater runs it as
 * plain Node outside the app.
 */
import fs from "fs";
import path from "path";
import type Docker from "dockerode";

export const UPDATER_NAME = "deploynow-updater";
export const UPDATER_LABEL = "io.deploynow.updater";
export const STATUS_DIR = "self-update";

export type SelfUpdateState = "starting" | "replacing" | "checking" | "succeeded" | "rolled_back" | "failed";
export const FINAL_STATES: SelfUpdateState[] = ["succeeded", "rolled_back", "failed"];

export interface SelfUpdateStatus {
  id: string;
  state: SelfUpdateState;
  fromVersion: string;
  fromImage: string; // image id the old container ran
  targetRef: string; // image reference the new container runs
  targetVersion: string; // "" for a floating tag until the new container answers
  targetDigest?: string; // repo@sha256:… that was checked before the switch
  verification?: string; // what was checked (signature, release digest), for the Updates panel
  startedAt: string;
  finishedAt?: string;
  message?: string;
  logs?: string; // last lines of the new container when it failed
  actor?: string; // email, or "auto"
  envFile?: string; // the compose .env whose DEPLOYNOW_TAG was moved to the new version
  reported?: boolean; // audit + notification written by the instance that came up afterwards
  autoKey?: string; // what auto-update went for (release:2.1.0 or image:sha256:…), so a failure isn't retried
}

/** What DeployNow hands to its updater container (JSON in SELF_UPDATE_PLAN). */
export interface SelfUpdatePlan {
  id: string;
  selfId: string;
  targetRef: string;
  /** The image id DeployNow pulled and checked; the updater starts nothing else */
  targetImageId?: string;
  /** Status file inside the updater (the data volume is mounted at the same path) */
  statusFile: string;
  /** SQLite database to snapshot before the new version migrates it ("" for none) */
  dbFile: string;
  /** Compose .env inside the updater to move DEPLOYNOW_TAG in, and the tag ("" for none) */
  envFile: string;
  envFileHost: string;
  envTag: string;
  healthTimeoutMs: number;
  delayMs: number;
}

export function statusFileFor(dataDir: string): string {
  return path.join(dataDir, STATUS_DIR, "status.json");
}

export function readStatus(file: string): SelfUpdateStatus | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as SelfUpdateStatus;
  } catch {
    return null;
  }
}

/** Write atomically; when running as root, hand the file to the data directory's owner. */
export function writeStatus(file: string, status: SelfUpdateStatus): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, file);
  chownLike(path.dirname(dir), dir);
  chownLike(path.dirname(dir), file);
}

export function chownLike(ref: string, target: string): void {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  try {
    const st = fs.statSync(ref);
    fs.chownSync(target, st.uid, st.gid);
  } catch {
    /* best effort */
  }
}

// ── Picking the image ────────────────────────────────────────────────────────

const PINNED = /^v?\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** Is this tag one exact release (2.0.0, v2.1.0-rc.1) rather than one that moves (latest, edge, 2.1)? */
export function isPinnedTag(tag: string): boolean {
  return PINNED.test(tag);
}

/** Split an image reference into the part before the tag and the tag. Digests aren't supported. */
export function splitRef(ref: string): { repo: string; tag: string } | null {
  if (!ref || ref.includes("@") || /^sha256:/.test(ref) || /^[0-9a-f]{12,64}$/.test(ref)) return null;
  const i = ref.lastIndexOf(":");
  if (i > -1 && !ref.slice(i).includes("/")) return { repo: ref.slice(0, i), tag: ref.slice(i + 1) };
  return { repo: ref, tag: "latest" };
}

/**
 * Which images an update follows (Settings → Updates → Update channel):
 *   ""        the tag DeployNow runs now: a release moves to the newest release, latest/edge/2.1 are pulled again
 *   "stable"  the newest release, pinned (1.0.0), whatever tag runs now
 *   "edge"    every build from main (the edge tag)
 */
export const CHANNELS = ["", "stable", "edge"] as const;
export type Channel = (typeof CHANNELS)[number];

export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

export interface NextImage {
  ref: string;
  pinned: boolean; // one exact release
  tag: string;
  changed: boolean; // the tag differs from the one running (a channel switch or a newer release)
}

/**
 * The image to move to. A pinned tag moves to the newest release (keeping a "v"
 * prefix if the old tag had one); any other tag is pulled again as it is, unless
 * a channel says otherwise.
 */
export function nextImageRef(currentRef: string, latestRelease: string, channel: Channel = ""): NextImage | null {
  const parts = splitRef(currentRef);
  if (!parts) return null;
  const out = (tag: string, pinned: boolean): NextImage => ({ ref: `${parts.repo}:${tag}`, pinned, tag, changed: tag !== parts.tag });
  if (channel === "edge") return out("edge", false);
  if (channel === "" && !isPinnedTag(parts.tag)) return out(parts.tag, false);
  if (!latestRelease) return null;
  const v = latestRelease.replace(/^v/, "");
  return out(parts.tag.startsWith("v") ? `v${v}` : v, true);
}

/** Set KEY=value in .env text, keeping everything else. Returns null when the key isn't there. */
export function setEnvValue(text: string, key: string, value: string): string | null {
  const re = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=[ \\t]*).*$`, "m");
  if (!re.test(text)) return null;
  return text.replace(re, `$1${value}`);
}

// ── Database snapshot ────────────────────────────────────────────────────────

const DB_SUFFIXES = ["", "-wal", "-shm"];

/** Copy the SQLite file and its WAL while nothing has it open. */
export function snapshotDb(dbFile: string, dir: string): string[] {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const copied: string[] = [];
  for (const s of DB_SUFFIXES) {
    const src = dbFile + s;
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dir, path.basename(src)));
    copied.push(s);
  }
  return copied;
}

/** Put the snapshot back, dropping WAL files the new version created. */
export function restoreDb(dbFile: string, dir: string): void {
  if (!fs.existsSync(path.join(dir, path.basename(dbFile)))) throw new Error("No database snapshot to restore");
  for (const s of DB_SUFFIXES) {
    const saved = path.join(dir, path.basename(dbFile + s));
    if (fs.existsSync(saved)) fs.copyFileSync(saved, dbFile + s);
    else fs.rmSync(dbFile + s, { force: true });
  }
}

// ── Waiting for the new container ────────────────────────────────────────────

export interface HealthResult {
  ok: boolean;
  reason: string;
}

type Inspect = Docker.ContainerInspectInfo;

/**
 * One look at the new container: true = healthy, false = failed, null = not yet.
 * Without a HEALTHCHECK, running for stableMs counts as healthy.
 */
export function judgeHealth(info: Inspect, now: number, stableMs: number): { done: boolean; ok: boolean; reason: string } {
  const st = info.State;
  if (st.Status === "exited" || st.Status === "dead") return { done: true, ok: false, reason: `The new container stopped (exit code ${st.ExitCode})` };
  if (st.Restarting || (info.RestartCount ?? 0) >= 2) return { done: true, ok: false, reason: "The new container keeps restarting" };
  const health = (st as { Health?: { Status?: string } }).Health?.Status;
  if (health === "healthy") return { done: true, ok: true, reason: "healthy" };
  if (health === "unhealthy") return { done: true, ok: false, reason: "The new container's health check failed" };
  if (!health && st.Running) {
    const since = Date.parse(st.StartedAt);
    if (Number.isFinite(since) && now - since >= stableMs) return { done: true, ok: true, reason: "running" };
  }
  return { done: false, ok: false, reason: "" };
}

export async function waitHealthy(
  docker: Docker,
  id: string,
  opts: { timeoutMs: number; intervalMs?: number; stableMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<HealthResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + opts.timeoutMs;
  for (;;) {
    let info: Inspect;
    try {
      info = await docker.getContainer(id).inspect();
    } catch (err) {
      return { ok: false, reason: `The new container is gone: ${(err as Error).message}` };
    }
    const j = judgeHealth(info, now(), opts.stableMs ?? 30_000);
    if (j.done) return { ok: j.ok, reason: j.reason };
    if (now() >= until) return { ok: false, reason: `The new container wasn't healthy after ${Math.round(opts.timeoutMs / 1000)}s` };
    await sleep(opts.intervalMs ?? 3000);
  }
}

/** The last lines a container wrote, as text (Docker multiplexes stdout and stderr in 8-byte framed chunks). */
export function demuxLogs(buf: Buffer): string {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length && (buf[i] === 1 || buf[i] === 2) && buf[i + 1] === 0) {
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + len));
    i += 8 + len;
  }
  return (out.length ? Buffer.concat(out) : buf).toString("utf8");
}
