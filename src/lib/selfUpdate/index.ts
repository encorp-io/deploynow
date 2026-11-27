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
import { getRemoteDigests } from "../ghcr";
import { parseImageRef } from "../imageRef";
import {
  FINAL_STATES,
  UPDATER_LABEL,
  UPDATER_NAME,
  isPinnedTag,
  nextImageRef,
  type Channel,
  type NextImage,
  readStatus,
  splitRef,
  statusFileFor,
  writeStatus,
  type SelfUpdatePlan,
  type SelfUpdateStatus,
} from "./shared";
import { VerifyError, verifyTarget } from "./verify";

export type { SelfUpdateStatus } from "./shared";

export class SelfUpdateError extends Error {
  constructor(
    message: string,
    public code: "disabled" | "unsupported" | "busy" | "current" | "pull" | "verify" | "docker" = "unsupported",
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
  next: NextImage;
  socketBind: string;
  dataBind: string;
  envBind: string; // host dir of the compose .env, mounted at /compose-env ("" when not needed)
  envFile: string; // inside the updater
  envFileHost: string;
}

/** Everything a self-update needs, or why it can't run here. */
export async function prepare(latestRelease: string, channel: Channel = ""): Promise<SelfUpdateSetup> {
  if (!selfUpdateEnabledByEnv()) throw new SelfUpdateError("Self-update is turned off with DEPLOYNOW_SELF_UPDATE=off.", "disabled");
  const target = await findLocalTarget();
  if (!target) {
    throw new SelfUpdateError(
      "DeployNow can't find its own container through a local Docker socket endpoint. Mount /var/run/docker.sock (and keep the \"local\" endpoint) to update from the UI.",
    );
  }
  const self = target.self;
  const image = self.Config.Image;
  const next = nextImageRef(image, latestRelease, channel);
  if (!next) {
    throw new SelfUpdateError(
      splitRef(image) ? "No newer release is known yet. Check for releases first." : `DeployNow runs from ${image.slice(0, 24)}, not a tag, so there's nothing to pull.`,
      splitRef(image) ? "current" : "unsupported",
    );
  }
  // A release counts as newer only against a release; from latest or edge, the stable channel always moves
  const runningTag = splitRef(image)?.tag ?? "";
  if (next.pinned && isPinnedTag(runningTag)) {
    const running = runningTag; // the exact release the container was started from
    if (compareVersions(latestRelease, running) <= 0) throw new SelfUpdateError(`You already run the newest release (${running.replace(/^v/, "")}).`, "current");
  }

  const mounts = (self.Mounts ?? []) as Mount[];
  const sock = mounts.find((m) => m.Destination === target.endpoint.host) ?? mounts.find((m) => m.Destination === "/var/run/docker.sock");
  if (!sock || sock.Type !== "bind" || !sock.Source) throw new SelfUpdateError("The Docker socket isn't bind-mounted into DeployNow, so the updater can't reach Docker.");
  const data = mountFor(mounts, dataDir());
  const dataBind = data ? bindFor(data) : null;
  if (!dataBind) throw new SelfUpdateError(`${dataDir()} isn't on a volume, so an update would lose DeployNow's data.`);

  // A new tag (2.0.0 → 2.1.0, or a channel switch) moves along in the compose .env (DEPLOYNOW_TAG), so `docker compose up` later keeps it
  let envBind = "";
  let envFile = "";
  let envFileHost = "";
  const labels = self.Config.Labels ?? {};
  const workDir = labels["com.docker.compose.project.working_dir"];
  if (next.changed && workDir) {
    envFileHost = (labels["com.docker.compose.project.environment_file"] || "").split(",")[0] || path.posix.join(workDir, ".env");
    envBind = `${path.posix.dirname(envFileHost)}:/compose-env`;
    envFile = `/compose-env/${path.posix.basename(envFileHost)}`;
  }
  return { target, image, next, socketBind: `${sock.Source}:/var/run/docker.sock`, dataBind, envBind, envFile, envFileHost };
}

/**
 * Does the registry still serve, under the tag DeployNow runs (edge, latest), the very image that
 * runs now? Then there is nothing to pull. false when unsure (no registry answer): the pull decides.
 */
export async function runsNewestBuild(setup: Pick<SelfUpdateSetup, "target" | "next">): Promise<boolean> {
  if (setup.next.changed || setup.next.pinned) return false;
  const p = parseImageRef(setup.next.ref);
  const local = await setup.target.docker
    .getImage(setup.target.self.Image)
    .inspect()
    .catch(() => null);
  const auth = await registryAuthFor(setup.next.ref).catch(() => undefined);
  const creds = auth?.username && auth.password ? { username: auth.username, password: auth.password } : undefined;
  const remote = await getRemoteDigests(p.registry, p.repository, p.tag, local?.Architecture, creds).catch(() => null);
  if (!remote) return false;
  const running = setup.target.self.Image;
  const repoDigests = local?.RepoDigests ?? [];
  return (
    (!!remote.config && remote.config === running) ||
    (!!remote.manifest && (remote.manifest === running || repoDigests.some((d) => d.endsWith(`@${remote.manifest}`))))
  );
}

/** "You already run the newest edge build (edge-03f8789)." */
export function newestBuildMessage(tag: string): string {
  return `You already run the newest ${tag} build (${VERSION}). Nothing to update.`;
}

async function updaterContainer(docker: Docker): Promise<Docker.ContainerInspectInfo | null> {
  try {
    return await docker.getContainer(UPDATER_NAME).inspect();
  } catch {
    return null;
  }
}

export function channelOf(s: { selfUpdateChannel?: string | null } | null | undefined): Channel {
  const c = s?.selfUpdateChannel ?? "";
  return c === "stable" || c === "edge" ? c : "";
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
  const setup = await prepare(s?.latestRelease ?? "", channelOf(s));
  const { target, next } = setup;
  const docker = target.docker;

  const existing = await updaterContainer(docker);
  if (existing?.State.Running) throw new SelfUpdateError("An update is already running.", "busy");
  if (isRunning(prior) && existing?.State.Running) throw new SelfUpdateError("An update is already running.", "busy");

  // edge and latest: don't pull when the registry still has the image that runs
  if (await runsNewestBuild(setup)) throw new SelfUpdateError(newestBuildMessage(next.tag), "current");

  const auth = await registryAuthFor(next.ref);
  try {
    await pullImage(docker, next.ref, auth);
  } catch (err) {
    throw new SelfUpdateError(`Couldn't pull ${next.ref}: ${dockerErrorMessage(err)}`, "pull");
  }
  const pulled = await docker.getImage(next.ref).inspect();
  // Same image under a new tag (latest → 1.0.0 on the stable channel) still goes ahead, so the
  // container and the compose .env name the tag the channel follows from now on
  if (pulled.Id === target.self.Image && !next.changed) throw new SelfUpdateError(newestBuildMessage(next.tag), "current");

  // The updater runs the new image as root with the socket: check it is the one the tag stands for (verify.ts)
  let verified;
  try {
    verified = await verifyTarget(docker, splitRef(next.ref)?.repo ?? "", next, pulled, { auth });
  } catch (err) {
    const message = err instanceof VerifyError ? err.message : `Couldn't check ${next.ref}: ${(err as Error).message}`;
    await audit({
      actor: opts.actor,
      ip: opts.ip,
      action: "deploynow.update",
      outcome: "failure",
      message: `DeployNow didn't update to ${next.ref}: the image failed its check`,
      details: message,
    }).catch(() => {});
    await notify({
      event: "update.installed",
      ok: false,
      title: `DeployNow update to ${next.tag} blocked`,
      text: message,
      fields: { From: VERSION, To: next.ref },
    }).catch(() => {});
    throw new SelfUpdateError(message, "verify");
  }

  if (existing) await docker.getContainer(existing.Id).remove({ force: true }).catch(() => {});

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const status: SelfUpdateStatus = {
    id,
    state: "starting",
    fromVersion: VERSION,
    fromImage: target.self.Image,
    targetRef: next.ref,
    targetVersion: next.pinned ? next.tag.replace(/^v/, "") : "",
    targetDigest: verified.digest,
    verification: verified.note,
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
    targetImageId: pulled.Id,
    statusFile: file,
    dbFile: dbFile(),
    envFile: setup.envFile,
    envFileHost: setup.envFileHost,
    envTag: next.changed ? next.tag : "",
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
    message: `${opts.auto ? "Auto-update" : opts.actor?.email ?? "Someone"} started updating DeployNow ${VERSION} to ${next.pinned || next.changed ? next.tag : next.ref}`,
    details: [`Image: ${next.ref} (${verified.digest || pulled.Id})`, verified.note].filter(Boolean).join("\n"),
  });
  return status;
}

// ── What the Updates panel shows ─────────────────────────────────────────────

export interface SelfUpdateInfo {
  supported: boolean;
  reason: string; // why not, when unsupported
  image: string; // what runs now
  pinned: boolean; // the target is one exact release
  target: string; // the image Update now would move to ("" when there's nothing newer)
  installable: boolean;
  channel: Channel;
  auto: boolean;
  hour: number;
  status: SelfUpdateStatus | null;
}

type Support = Pick<SelfUpdateInfo, "supported" | "reason" | "image" | "pinned" | "target" | "installable">;
let cache: { at: number; key: string; value: Support } | null = null;

export function clearSelfUpdateCache() {
  cache = null;
}

export async function selfUpdateInfo(latestRelease: string): Promise<SelfUpdateInfo> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const channel = channelOf(s);
  const key = `${latestRelease}|${channel}`;
  let support = cache && cache.key === key && Date.now() - cache.at < 60_000 ? cache.value : null;
  if (!support) {
    try {
      const setup = await prepare(latestRelease, channel);
      // A moving tag (edge, latest) is offered only while the registry has a newer build behind it
      const newest = await runsNewestBuild(setup).catch(() => false);
      support = { supported: true, reason: newest ? newestBuildMessage(setup.next.tag) : "", image: setup.image, pinned: setup.next.pinned, target: setup.next.ref, installable: !newest };
    } catch (err) {
      const e = err as SelfUpdateError;
      // "You already run the newest release" still means it works here
      const current = e.code === "current";
      support = { supported: current, reason: e.message, image: "", pinned: false, target: "", installable: false };
      if (current) {
        const t = await findLocalTarget().catch(() => null);
        support.image = t?.self.Config.Image ?? "";
        support.pinned = channel === "stable" || (channel === "" && isPinnedTag(splitRef(support.image)?.tag ?? ""));
      }
    }
    cache = { at: Date.now(), key, value: support };
  }
  return { ...support, channel, auto: !!s?.selfUpdateAuto, hour: s?.selfUpdateHour ?? -1, status: currentStatus() };
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

  // The channel asks for another tag, a newer release, or (edge and other moving tags) a new image behind our tag
  const channel = channelOf(s);
  let key = "";
  if (channel) {
    const t = await findLocalTarget().catch(() => null);
    const next = t ? nextImageRef(t.self.Config.Image, s.latestRelease, channel) : null;
    const runningTag = t ? splitRef(t.self.Config.Image)?.tag ?? "" : "";
    if (next?.changed && !(next.pinned && isPinnedTag(runningTag) && compareVersions(next.tag, runningTag) <= 0)) {
      // A moving tag (edge) gets the build behind it in the key, so a build that rolled back
      // doesn't block the next one; without the registry, one try a day
      key = `tag:${next.tag}`;
      if (!next.pinned) {
        const p = parseImageRef(next.ref);
        const remote = await getRemoteDigests(p.registry, p.repository, p.tag).catch(() => null);
        key += remote?.manifest || remote?.config ? `@${remote.manifest || remote.config}` : `@${now.toISOString().slice(0, 10)}`;
      }
    }
  }
  if (!key && channel !== "edge" && s.latestRelease && parseVersion(VERSION) && compareVersions(s.latestRelease, VERSION) > 0) key = `release:${s.latestRelease}`;
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
