/**
 * DeployNow updating itself.
 *
 * A container can't replace itself: stopping it ends the process that would
 * create the new one (that's why the Services "Update" button used to leave
 * DeployNow stopped). So DeployNow pulls the new image, then starts a
 * short-lived "deploynow-updater" container from its own image with the Docker
 * socket and the data volume. The updater (runner.ts) swaps the container,
 * waits for the health check and rolls back, database included, when the new
 * version doesn't come up.
 *
 *   startSelfUpdate()        Settings → Updates → Update now, Services → Update, auto-update
 *   selfUpdateInfo()         what the Updates panel shows
 *   startSelfUpdateWorker()  reports finished updates (audit + notification) and runs auto-update
 *
 * Off with DEPLOYNOW_SELF_UPDATE=off.
 */
import path from "path";
import type Docker from "dockerode";
import { prisma } from "../prisma";
import { VERSION } from "../version";
import { audit, type AuditActor } from "../audit";
import { notify } from "../notify";
import { publicBaseUrl } from "../publicOrigin";
import { registryAuthFor } from "../registryAuth";
import { pullImage } from "../docker/recreate";
import { dockerErrorMessage } from "../docker/client";
import { findLocalTarget, selfContainerCandidates, type LocalTarget } from "../platformDomain";
import { compareVersions, parseVersion } from "../updates";
import {
  FINAL_STATES,
  UPDATER_LABEL,
  UPDATER_NAME,
  nextImageRef,
  readStatus,
  splitRef,
  statusFileFor,
  writeStatus,
  type SelfUpdatePlan,
  type SelfUpdateStatus,
} from "./shared";

export type { SelfUpdateStatus } from "./shared";

export class SelfUpdateError extends Error {
  constructor(
    message: string,
    public code: "disabled" | "unsupported" | "busy" | "current" | "pull" | "docker" = "unsupported",
  ) {
    super(message);
  }
}

export function selfUpdateEnabledByEnv(): boolean {
  return String(process.env.DEPLOYNOW_SELF_UPDATE ?? "").toLowerCase() !== "off";
}

export function dbFile(): string {
  const url = process.env.DATABASE_URL || "file:/data/deployer.db";
  if (!url.startsWith("file:")) return "";
  const p = url.slice("file:".length).split("?")[0];
  return path.resolve(p);
}

/** Where the status file lives: next to the database, on the data volume. */
export function dataDir(): string {
  return path.dirname(dbFile() || "/data/deployer.db");
}

export function statusFile(): string {
  return statusFileFor(dataDir());
}

export function currentStatus(): SelfUpdateStatus | null {
  return readStatus(statusFile());
}

/** Is this container id ours? (Docker shows the short id as our hostname.) */
export function isSelfContainer(containerId: string): boolean {
  if (!containerId) return false;
  return selfContainerCandidates().some((c) => !!c && c.length >= 12 && (containerId.startsWith(c) || c.startsWith(containerId)));
}

type Mount = { Type?: string; Name?: string; Source?: string; Destination: string; RW?: boolean };

/** The mount that holds a path inside the container (longest matching destination). */
export function mountFor(mounts: Mount[], p: string): Mount | null {
  let best: Mount | null = null;
  for (const m of mounts) {
    const d = m.Destination.replace(/\/+$/, "") || "/";
    if (p === d || p.startsWith(d === "/" ? "/" : `${d}/`)) if (!best || d.length > best.Destination.length) best = m;
  }
  return best;
}

export function bindFor(m: Mount, target = m.Destination): string | null {
  if (m.Type === "volume" && m.Name) return `${m.Name}:${target}`;
  if (m.Type === "bind" && m.Source) return `${m.Source}:${target}`;
  return null;
}

export interface SelfUpdateSetup {
  target: LocalTarget;
  image: string;
  next: { ref: string; pinned: boolean; tag: string };
  socketBind: string;
  dataBind: string;
  envBind: string; // host dir of the compose .env, mounted at /compose-env ("" when not needed)
  envFile: string; // inside the updater
  envFileHost: string;
}

/** Everything a self-update needs, or why it can't run here. */
export async function prepare(latestRelease: string): Promise<SelfUpdateSetup> {
  if (!selfUpdateEnabledByEnv()) throw new SelfUpdateError("Self-update is turned off with DEPLOYNOW_SELF_UPDATE=off.", "disabled");
  const target = await findLocalTarget();
  if (!target) {
    throw new SelfUpdateError(
      "DeployNow can't find its own container through a local Docker socket endpoint. Mount /var/run/docker.sock (and keep the \"local\" endpoint) to update from the UI.",
    );
  }
  const self = target.self;
  const image = self.Config.Image;
  const next = nextImageRef(image, latestRelease);
  if (!next) {
    throw new SelfUpdateError(
      splitRef(image) ? "No newer release is known yet. Check for releases first." : `DeployNow runs from ${image.slice(0, 24)}, not a tag, so there's nothing to pull.`,
      splitRef(image) ? "current" : "unsupported",
    );
  }
  if (next.pinned && !(parseVersion(VERSION) && compareVersions(latestRelease, VERSION) > 0)) {
    throw new SelfUpdateError(`You already run the newest release (${VERSION}).`, "current");
  }

  const mounts = (self.Mounts ?? []) as Mount[];
  const sock = mounts.find((m) => m.Destination === target.endpoint.host) ?? mounts.find((m) => m.Destination === "/var/run/docker.sock");
  if (!sock || sock.Type !== "bind" || !sock.Source) throw new SelfUpdateError("The Docker socket isn't bind-mounted into DeployNow, so the updater can't reach Docker.");
  const data = mountFor(mounts, dataDir());
  const dataBind = data ? bindFor(data) : null;
  if (!dataBind) throw new SelfUpdateError(`${dataDir()} isn't on a volume, so an update would lose DeployNow's data.`);

  // A pinned tag in a compose .env (DEPLOYNOW_TAG=1.0.0) moves along, so `docker compose up` later keeps the new version
  let envBind = "";
  let envFile = "";
  let envFileHost = "";
  const labels = self.Config.Labels ?? {};
  const workDir = labels["com.docker.compose.project.working_dir"];
  if (next.pinned && workDir) {
    envFileHost = (labels["com.docker.compose.project.environment_file"] || "").split(",")[0] || path.posix.join(workDir, ".env");
    envBind = `${path.posix.dirname(envFileHost)}:/compose-env`;
    envFile = `/compose-env/${path.posix.basename(envFileHost)}`;
  }
  return { target, image, next, socketBind: `${sock.Source}:/var/run/docker.sock`, dataBind, envBind, envFile, envFileHost };
}

async function updaterContainer(docker: Docker): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await docker.getContainer(UPDATER_NAME).inspect();
  } catch {
    return null;
  }
}

export function isRunning(status: SelfUpdateStatus | null): boolean {
  return !!status && !FINAL_STATES.includes(status.state);
}

export interface StartOptions {
  actor?: AuditActor | null;
  ip?: string;
  auto?: boolean;
  autoKey?: string;
  healthTimeoutMs?: number;
}

/**
 * Pull the new image and hand over to the updater. Returns once the updater
 * runs; DeployNow stops a few seconds later. Nothing changes when the pull fails.
 */
export async function startSelfUpdate(opts: StartOptions = {}): Promise<SelfUpdateStatus> {
  const prior = currentStatus();
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const setup = await prepare(s?.latestRelease ?? "");
  const { target, next } = setup;
  const docker = target.docker;

  const existing = await updaterContainer(docker);
  if (existing?.State.Running) throw new SelfUpdateError("An update is already running.", "busy");
  if (isRunning(prior) && existing?.State.Running) throw new SelfUpdateError("An update is already running.", "busy");

  try {
    await pullImage(docker, next.ref, await registryAuthFor(next.ref));
  } catch (err) {
    throw new SelfUpdateError(`Couldn't pull ${next.ref}: ${dockerErrorMessage(err)}`, "pull");
  }
  const pulled = await docker.getImage(next.ref).inspect();
  if (pulled.Id === target.self.Image) throw new SelfUpdateError(`${next.ref} is the image DeployNow already runs.`, "current");

  if (existing) await docker.getContainer(existing.Id).remove({ force: true }).catch(() => {});

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const status: SelfUpdateStatus = {
    id,
    state: "starting",
    fromVersion: VERSION,
    fromImage: target.self.Image,
    targetRef: next.ref,
    targetVersion: next.pinned ? next.tag.replace(/^v/, "") : "",
    startedAt: new Date().toISOString(),
    actor: opts.auto ? "auto" : opts.actor?.email ?? "",
    ...(opts.autoKey ? { autoKey: opts.autoKey } : {}),
  };
  const file = statusFile();
  writeStatus(file, status);

  const plan: SelfUpdatePlan = {
    id,
    selfId: target.self.Id,
    targetRef: next.ref,
    statusFile: file,
    dbFile: dbFile(),
    envFile: setup.envFile,
    envFileHost: setup.envFileHost,
    envTag: next.pinned ? next.tag : "",
    healthTimeoutMs: opts.healthTimeoutMs ?? 300_000,
    delayMs: 3000,
  };

  try {
    const helper = await docker.createContainer({
      name: UPDATER_NAME,
      Image: target.self.Image, // the image we run has this updater in it
      User: "0:0", // the socket, and a compose .env owned by root
      Entrypoint: ["node", "/app/updater/selfUpdate/runner.js"],
      Cmd: [],
      Env: [`SELF_UPDATE_PLAN=${JSON.stringify(plan)}`],
      Labels: { [UPDATER_LABEL]: "true", "deploynow.role": "updater" },
      Healthcheck: { Test: ["NONE"] },
      HostConfig: {
        Binds: [setup.socketBind, setup.dataBind, ...(setup.envBind ? [setup.envBind] : [])],
        NetworkMode: "none",
        RestartPolicy: { Name: "no" },
      },
    } as Docker.ContainerCreateOptions);
    await helper.start();
  } catch (err) {
    const message = `Couldn't start the updater: ${dockerErrorMessage(err)}`;
    writeStatus(file, { ...status, state: "failed", message, finishedAt: new Date().toISOString(), reported: true });
    throw new SelfUpdateError(message, "docker");
  }

  await audit({
    actor: opts.actor,
    ip: opts.ip,
    action: "deploynow.update",
    message: `${opts.auto ? "Auto-update" : opts.actor?.email ?? "Someone"} started updating DeployNow ${VERSION} to ${next.pinned ? next.tag : next.ref}`,
    details: `Image: ${next.ref} (${pulled.Id.slice(0, 19)}…)`,
  });
  return status;
}

// ── What the Updates panel shows ─────────────────────────────────────────────

export interface SelfUpdateInfo {
  supported: boolean;
  reason: string; // why not, when unsupported
  image: string;
  pinned: boolean;
  auto: boolean;
  hour: number;
  status: SelfUpdateStatus | null;
}

let cache: { at: number; key: string; value: { supported: boolean; reason: string; image: string; pinned: boolean } } | null = null;

export async function selfUpdateInfo(latestRelease: string): Promise<SelfUpdateInfo> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  let support = cache && cache.key === latestRelease && Date.now() - cache.at < 60_000 ? cache.value : null;
  if (!support) {
    try {
      const setup = await prepare(latestRelease || "0.0.0");
      support = { supported: true, reason: "", image: setup.image, pinned: setup.next.pinned };
    } catch (err) {
      const e = err as SelfUpdateError;
      // "You already run the newest release" still means it works here
      support = { supported: e.code === "current", reason: e.code === "current" ? "" : e.message, image: "", pinned: false };
      if (e.code === "current") {
        const t = await findLocalTarget().catch(() => null);
        const img = t?.self.Config.Image ?? "";
        support.image = img;
        support.pinned = !!nextImageRef(img, "0.0.0")?.pinned;
      }
    }
    cache = { at: Date.now(), key: latestRelease, value: support };
  }
  return { ...support, auto: !!s?.selfUpdateAuto, hour: s?.selfUpdateHour ?? -1, status: currentStatus() };
}

// ── After an update: report it; auto-update ──────────────────────────────────

/** Log and announce a finished update once, and clean up the updater container. */
export async function reconcileSelfUpdate(): Promise<void> {
  const file = statusFile();
  const status = readStatus(file);
  if (!status) return;

  if (isRunning(status)) {
    // The updater died without finishing: say so instead of showing "updating" forever
    const started = Date.parse(status.startedAt);
    if (Number.isFinite(started) && Date.now() - started < 60_000) return;
    const t = await findLocalTarget().catch(() => null);
    if (!t) return;
    const helper = await updaterContainer(t.docker);
    if (helper?.State.Running) return;
    writeStatus(file, { ...status, state: "failed", message: "The updater stopped before it finished.", finishedAt: new Date().toISOString() });
    return reconcileSelfUpdate();
  }
  if (status.reported) return;

  const ok = status.state === "succeeded";
  const to = status.targetVersion || (ok ? VERSION : status.targetRef);
  const done: SelfUpdateStatus = { ...status, targetVersion: ok ? VERSION : status.targetVersion, reported: true };
  writeStatus(file, done);

  await audit({
    action: "deploynow.update",
    outcome: ok ? "success" : "failure",
    message: ok ? `DeployNow updated from ${status.fromVersion} to ${VERSION}` : `DeployNow update to ${to} failed: ${status.message ?? "unknown error"}`,
    details: [status.envFile ? `DEPLOYNOW_TAG moved in ${status.envFile}` : "", status.logs ? `Last lines of the new version:\n${status.logs}` : ""].filter(Boolean).join("\n\n"),
  });
  const base = publicBaseUrl() ?? "";
  await notify({
    event: "update.installed",
    ok,
    title: ok ? `DeployNow updated to ${VERSION}` : `DeployNow update to ${to} rolled back`,
    text: ok ? `${status.actor === "auto" ? "Auto-update" : "The update"} from ${status.fromVersion} finished and passed its health check.` : (status.message ?? "The update failed."),
    link: base ? `${base}/settings?section=updates` : undefined,
    fields: { From: status.fromVersion, To: ok ? VERSION : to },
  }).catch(() => {});

  const t = await findLocalTarget().catch(() => null);
  const helper = t ? await updaterContainer(t.docker) : null;
  if (t && helper && !helper.State.Running) await t.docker.getContainer(helper.Id).remove({ force: true }).catch(() => {});
}

/** Is it time for an auto-update? */
export function inWindow(hour: number, now = new Date()): boolean {
  return hour < 0 || hour > 23 || now.getHours() === hour;
}

interface WorkerState {
  timer: ReturnType<typeof setInterval> | null;
  lastAutoKey: string;
  lastAutoAt: number;
  ticks: number;
}
const g = globalThis as unknown as { __deploynowSelfUpdate?: WorkerState };
const state: WorkerState = (g.__deploynowSelfUpdate ??= { timer: null, lastAutoKey: "", lastAutoAt: 0, ticks: 0 });
const RETRY_SAME_MS = 6 * 3600_000;

/** One auto-update decision. Exported for tests. */
export async function autoUpdateTick(now = new Date()): Promise<string> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!s?.selfUpdateAuto || !selfUpdateEnabledByEnv()) return "off";
  if (!inWindow(s.selfUpdateHour, now)) return "outside window";
  const status = currentStatus();
  if (isRunning(status)) return "running";

  // A newer release, or (edge and other moving tags) a new image behind our tag
  let key = "";
  if (s.latestRelease && parseVersion(VERSION) && compareVersions(s.latestRelease, VERSION) > 0) key = `release:${s.latestRelease}`;
  if (!key) {
    const svc = await prisma.service.findMany({ where: { updateAvailable: true }, select: { containerId: true, remoteDigest: true } });
    const mine = svc.find((x) => isSelfContainer(x.containerId));
    if (mine) key = `image:${mine.remoteDigest}`;
  }
  if (!key) return "nothing new";
  // Don't retry what already failed, and don't pull the same thing over and over
  if (status && status.autoKey === key && status.state !== "succeeded") return "failed before";
  if (state.lastAutoKey === key && now.getTime() - state.lastAutoAt < RETRY_SAME_MS) return "tried recently";
  state.lastAutoKey = key;
  state.lastAutoAt = now.getTime();
  try {
    await startSelfUpdate({ auto: true, autoKey: key });
    return "started";
  } catch (err) {
    const e = err as SelfUpdateError;
    if (e.code !== "current") console.warn("[deployer] Auto-update didn't start:", e.message);
    return e.code === "current" ? "nothing new" : "error";
  }
}

export function startSelfUpdateWorker() {
  if (state.timer || process.env.NODE_ENV === "test") return;
  const run = async () => {
    state.ticks++;
    try {
      await reconcileSelfUpdate();
    } catch (err) {
      console.warn("[deployer] Self-update report failed:", err instanceof Error ? err.message : err);
    }
    // Auto-update looks every 10 minutes, starting 5 minutes after boot
    if (state.ticks >= 5 && state.ticks % 10 === 5) {
      await autoUpdateTick().catch((err) => console.warn("[deployer] Auto-update check failed:", err instanceof Error ? err.message : err));
    }
  };
  setTimeout(run, 10_000).unref?.();
  state.timer = setInterval(run, 60_000);
  state.timer.unref?.();
}
