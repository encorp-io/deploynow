/**
 * Auto-update for every kind of app. Each poll cycle (lib/backgroundPoller.ts):
 *
 *   1. advanceRuns()   moves updates in flight along:
 *                        deploying  → the deployment finished: verify, or roll back if it failed
 *                        verifying  → a minute later the new containers must still be up
 *                                     (and healthy, when they have a health check)
 *                        rolling-back → the rollback finished
 *   2. checkApp()      for each app that is due, looks for something new:
 *                        Git apps       a new commit on the tracked branch (git ls-remote)
 *                        image apps     a new digest for the image tag
 *                        compose apps   a new digest for any image in the compose file
 *                                       (built services are skipped; Git compose apps get both checks)
 *                      and, inside the maintenance window, queues a deployment with the
 *                      "auto-update" trigger through the normal deploy pipeline.
 *
 * An update that was tried once (by its fingerprint: commit + digests) is not tried
 * again, so a broken release isn't redeployed and rolled back every few minutes.
 * GitHub push webhooks keep working alongside this; this is the no-webhook way.
 */
import os from "os";
import YAML from "yaml";
import type { Application, AutoUpdateRun, Deployment, Endpoint, Environment, Project } from "@prisma/client";
import { prisma } from "../prisma";
import { dockerFor } from "../endpoints";
import { registryDigests } from "../registryDigests";
import { isCurrent } from "../polling";
import { appPullContext, registryAuthFor } from "../registryAuth";
import { DeployBusyError, enqueueDeploy } from "../jobs";
import { BRANCH_RE, gitEnv } from "../deploy/git";
import { runCommand } from "../docker/cliBridge";
import { decryptSecret } from "../secretsCrypto";
import { readStoredEnv, resolveEnv } from "./env";
import { interpolate } from "../deploy/compose";
import { ConfigError } from "./config";
import { audit } from "../audit";
import { notify } from "../notify";
import { publicBaseUrl } from "../publicOrigin";

// ─── Settings ────────────────────────────────────────────────────────────────

export const CHECK_EVERY_MINUTES = [1, 5, 15, 30, 60, 360, 1440] as const;
/** How long the new containers must stay up after the deployment before the update counts as healthy. */
export const VERIFY_MS = 60_000;
const RECENT_RESTART_MS = 30_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface AutoUpdateSettings {
  autoUpdate: boolean;
  autoUpdateEvery: number;
  autoUpdateDays: string;
  autoUpdateFrom: string;
  autoUpdateTo: string;
  autoUpdateTimezone: string;
  autoUpdateRollback: boolean;
}

export const AUTO_UPDATE_KEYS = ["autoUpdate", "autoUpdateEvery", "autoUpdateDays", "autoUpdateFrom", "autoUpdateTo", "autoUpdateTimezone", "autoUpdateRollback"] as const;

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the auto-update fields of an app create/update body; fields left out
 * keep their existing value. `updatePolicy: "auto-digest"` (the old setting) turns it on.
 */
export function validateAutoUpdateInput(body: Record<string, unknown>, existing?: Partial<AutoUpdateSettings> | null): Partial<AutoUpdateSettings> {
  const out: Partial<AutoUpdateSettings> = {};
  const has = (k: string) => body[k] !== undefined;
  if (body.updatePolicy === "auto-digest" && !has("autoUpdate")) out.autoUpdate = true;
  if (has("autoUpdate")) out.autoUpdate = body.autoUpdate === true;
  if (has("autoUpdateEvery")) {
    const n = Number(body.autoUpdateEvery);
    if (!(CHECK_EVERY_MINUTES as readonly number[]).includes(n)) throw new ConfigError(`Check every ${CHECK_EVERY_MINUTES.join(", ")} minutes`);
    out.autoUpdateEvery = n;
  }
  if (has("autoUpdateDays")) {
    const raw = Array.isArray(body.autoUpdateDays) ? body.autoUpdateDays : String(body.autoUpdateDays ?? "").split(",");
    const days = [...new Set(raw.map((d) => String(d).trim()).filter(Boolean))].map(Number);
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ConfigError("Maintenance days are 0 (Sunday) to 6 (Saturday)");
    out.autoUpdateDays = days.length === 7 ? "" : days.sort().join(",");
  }
  for (const k of ["autoUpdateFrom", "autoUpdateTo"] as const) {
    if (!has(k)) continue;
    const v = String(body[k] ?? "").trim();
    if (v && !TIME_RE.test(v)) throw new ConfigError("Enter the maintenance window times as HH:MM, e.g. 02:00");
    out[k] = v;
  }
  const from = out.autoUpdateFrom ?? existing?.autoUpdateFrom ?? "";
  const to = out.autoUpdateTo ?? existing?.autoUpdateTo ?? "";
  if (!!from !== !!to) throw new ConfigError("Give the maintenance window both a start and an end time, or neither");
  if (from && from === to) throw new ConfigError("The maintenance window starts and ends at the same time");
  if (has("autoUpdateTimezone")) {
    const tz = String(body.autoUpdateTimezone ?? "").trim();
    if (tz && (tz.length > 64 || !validTimezone(tz))) throw new ConfigError(`Unknown time zone "${tz}" (use a name such as Europe/Sofia)`);
    out.autoUpdateTimezone = tz;
  }
  if (has("autoUpdateRollback")) out.autoUpdateRollback = body.autoUpdateRollback !== false;
  return out;
}

// ─── Maintenance window ──────────────────────────────────────────────────────

function localParts(now: Date, timezone: string): { day: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone || undefined, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Is `now` inside the app's maintenance window? A window that ends before it
 * starts (22:00–04:00) runs past midnight and belongs to the day it starts on.
 */
export function inWindow(now: Date, w: Pick<AutoUpdateSettings, "autoUpdateDays" | "autoUpdateFrom" | "autoUpdateTo" | "autoUpdateTimezone">): boolean {
  const days = w.autoUpdateDays ? w.autoUpdateDays.split(",").map(Number) : null;
  const { day, minutes } = localParts(now, w.autoUpdateTimezone);
  if (!w.autoUpdateFrom || !w.autoUpdateTo) return !days || days.includes(day);
  const from = toMinutes(w.autoUpdateFrom);
  const to = toMinutes(w.autoUpdateTo);
  if (from < to) return minutes >= from && minutes < to && (!days || days.includes(day));
  if (minutes >= from) return !days || days.includes(day);
  if (minutes < to) return !days || days.includes((day + 6) % 7);
  return false;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function describeWindow(w: Pick<AutoUpdateSettings, "autoUpdateDays" | "autoUpdateFrom" | "autoUpdateTo" | "autoUpdateTimezone">): string {
  const days = w.autoUpdateDays ? w.autoUpdateDays.split(",").map((d) => DAY_NAMES[Number(d)]).join(", ") : "every day";
  const hours = w.autoUpdateFrom ? `${w.autoUpdateFrom}–${w.autoUpdateTo}` : "any time";
  return `${days}, ${hours} (${w.autoUpdateTimezone || serverTimezone()})`;
}

export function serverTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ─── Finding updates ─────────────────────────────────────────────────────────

export { interpolate } from "../deploy/compose";

export interface ComposeImage {
  service: string;
  image: string;
}

/** Images of a compose file that come from a registry: built services and digest-pinned images are left out. */
export function composeImages(yaml: string, env: Record<string, string | undefined> = {}): ComposeImage[] {
  let doc: unknown;
  try {
    doc = YAML.parse(yaml, { maxAliasCount: 100 });
  } catch {
    return [];
  }
  const services = (doc as { services?: Record<string, { image?: unknown; build?: unknown }> })?.services;
  if (!services || typeof services !== "object") return [];
  const out: ComposeImage[] = [];
  for (const [service, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== "object" || svc.build !== undefined || typeof svc.image !== "string") continue;
    const image = svc.image.includes("$") ? interpolate(svc.image, env) : svc.image;
    if (!image || image.includes("@sha256:") || image.startsWith("dn/")) continue;
    out.push({ service, image });
  }
  return out;
}

export interface Change {
  kind: "commit" | "image";
  name: string;
  from: string;
  to: string;
}

export function fingerprintOf(changes: Change[]): string {
  return changes
    .map((c) => `${c.kind}:${c.name}=${c.to}`)
    .sort()
    .join(";");
}

export function summarize(changes: Change[]): string {
  return changes
    .map((c) => (c.kind === "commit" ? `new commit ${c.to.slice(0, 12)} on ${c.name}` : `${c.name}: new ${c.to.slice(0, 19)}…`))
    .join("; ");
}

async function githubToken(): Promise<string> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return s?.githubToken ? decryptSecret(s.githubToken) : "";
}

/** The commit a branch points to now, without cloning. */
export async function remoteBranchHead(repo: string, branch: string, token = ""): Promise<string> {
  if (!BRANCH_RE.test(branch)) throw new Error("Invalid branch name");
  const lines: string[] = [];
  await runCommand("git", ["ls-remote", "--heads", "--", repo, `refs/heads/${branch}`], {
    cwd: os.tmpdir(),
    env: gitEnv(repo, token),
    onOutput: (l) => lines.push(l),
    timeoutMs: 60_000,
  }).catch((err) => {
    const why = lines.filter((l) => !/^[0-9a-f]{40}\s/.test(l)).slice(-1)[0] || (err as Error).message;
    throw new Error(`Couldn't read ${branch} from the repository: ${why}`);
  });
  const hit = lines.map((l) => l.split(/\s+/)).find((p) => p[1] === `refs/heads/${branch}` && /^[0-9a-f]{40}$/.test(p[0]));
  if (!hit) throw new Error(`The branch ${branch} isn't in the repository`);
  return hit[0];
}

type CheckApp = Application & { endpoint: Endpoint; environment: Environment & { project: Project } };

export interface Finder {
  branchHead: (repo: string, branch: string) => Promise<string>;
  digests: (image: string, opts: { arch?: string; auth?: { username: string; password: string } }) => Promise<{ config: string; manifest: string } | null>;
}

const defaultFinder: Finder = {
  branchHead: async (repo, branch) => remoteBranchHead(repo, branch, await githubToken()),
  digests: (image, opts) => registryDigests(image, opts),
};

/** Running image of each compose service: ImageID, RepoDigests and architecture. */
async function runningServices(app: CheckApp): Promise<Map<string, { currentDigest: string; repoDigests: string; arch: string }>> {
  const docker = dockerFor(app.endpoint);
  const list = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${app.slug}`] } });
  const out = new Map<string, { currentDigest: string; repoDigests: string; arch: string }>();
  for (const c of list) {
    const svc = c.Labels?.["com.docker.compose.service"];
    if (!svc || out.has(svc)) continue;
    const info = await docker.getImage(c.ImageID).inspect().catch(() => null);
    out.set(svc, { currentDigest: c.ImageID, repoDigests: (info?.RepoDigests ?? []).join(","), arch: info?.Architecture || "amd64" });
  }
  return out;
}

/** What is new for an app compared with what its current deployment runs. */
export async function findChanges(app: CheckApp, current: Deployment, finder: Finder = defaultFinder): Promise<Change[]> {
  const changes: Change[] = [];
  const pullCtx = appPullContext(app);
  const isGit = app.sourceType === "git-dockerfile" || app.sourceType === "git-compose";
  const isCompose = app.sourceType === "compose" || app.sourceType === "git-compose";

  if (isGit) {
    const head = await finder.branchHead(app.gitRepo, app.gitBranch);
    if (current.commitSha && head !== current.commitSha) changes.push({ kind: "commit", name: app.gitBranch, from: current.commitSha, to: head });
  }

  if (app.sourceType === "image" && !app.image.includes("@sha256:") && current.imageDigest) {
    const auth = await registryAuthFor(app.image, pullCtx);
    const remote = await finder.digests(app.image, { auth });
    if (remote && current.imageDigest !== remote.manifest && current.imageDigest !== remote.config) {
      changes.push({ kind: "image", name: app.image, from: current.imageDigest, to: remote.manifest || remote.config });
    }
  }

  if (isCompose && current.renderedCompose) {
    const raw = current.renderedCompose;
    let env: Record<string, string | undefined> = {};
    // Only images written as ${VAR} need the app's values (secret and Vault ones included)
    if (/image:\s*["']?[^\n]*\$/.test(raw)) {
      const resolved = await resolveEnv(readStoredEnv(current.envSnapshot || app.env)).catch(() => null);
      env = Object.fromEntries((resolved?.vars ?? []).map((v) => [v.key, v.value]));
    }
    const images = composeImages(raw, env);
    if (images.length) {
      const running = await runningServices(app);
      const seen = new Map<string, { config: string; manifest: string } | null>();
      for (const { service, image } of images) {
        const local = running.get(service);
        if (!local) continue; // not running (a profile, scaled to 0): nothing to compare with
        const key = `${image}|${local.arch}`;
        if (!seen.has(key)) seen.set(key, await finder.digests(image, { arch: local.arch, auth: await registryAuthFor(image, pullCtx) }));
        const remote = seen.get(key);
        if (remote && !isCurrent(local, remote)) changes.push({ kind: "image", name: `${service} (${image})`, from: local.currentDigest, to: remote.manifest || remote.config });
      }
    }
  }
  return changes;
}

// ─── Checking and starting updates ───────────────────────────────────────────

export interface CheckResult {
  state: "up-to-date" | "queued" | "waiting" | "already-tried" | "busy" | "error" | "off";
  summary: string;
  runId?: string;
}

const appInclude = { endpoint: true, environment: { include: { project: true } } } as const;

function appLink(appId: string) {
  return publicBaseUrl() ? { link: `${publicBaseUrl()}/apps/${appId}` } : {};
}

function appTitle(app: CheckApp) {
  return `${app.environment.project.name} / ${app.name} (${app.environment.name})`;
}

/** Is the app due for a check now? */
export function isDue(app: Pick<Application, "autoUpdateEvery" | "autoUpdateCheckedAt" | "autoUpdateDays" | "autoUpdateFrom" | "autoUpdateTo" | "autoUpdateTimezone">, now = new Date()): boolean {
  if (!app.autoUpdateCheckedAt) return true;
  // A little slack so a 1-minute setting doesn't miss every other poll
  if (now.getTime() - app.autoUpdateCheckedAt.getTime() >= app.autoUpdateEvery * 60_000 - 10_000) return true;
  // The window just opened: look now rather than at the next interval, which may already be past it
  return !inWindow(app.autoUpdateCheckedAt, app) && inWindow(now, app);
}

/**
 * Look for an update for one app and start it when allowed. `force` ignores the
 * interval (Check now), never the maintenance window.
 */
export async function checkApp(appId: string, opts: { now?: Date; finder?: Finder } = {}): Promise<CheckResult> {
  const now = opts.now ?? new Date();
  const app = (await prisma.application.findUnique({ where: { id: appId }, include: appInclude })) as CheckApp | null;
  if (!app || !app.autoUpdate) return { state: "off", summary: "Auto-update is off" };
  const record = (data: Partial<Application>) => prisma.application.update({ where: { id: app.id }, data: { autoUpdateCheckedAt: now, ...data } });

  if (!app.currentDeploymentId || app.status === "stopped") {
    await record({ autoUpdatePending: "", autoUpdateError: "" });
    return { state: "up-to-date", summary: "Deploy the app once; auto-update starts from its current deployment" };
  }
  const inFlight = await prisma.autoUpdateRun.findFirst({ where: { applicationId: app.id, status: { in: ["deploying", "verifying", "rolling-back"] } } });
  const busy = inFlight ?? (await prisma.deployment.findFirst({ where: { applicationId: app.id, status: { in: ["queued", "running"] } } }));
  if (busy) return { state: "busy", summary: "A deployment of this app is in progress" };

  const current = await prisma.deployment.findUnique({ where: { id: app.currentDeploymentId } });
  if (!current) return { state: "up-to-date", summary: "" };

  let changes: Change[];
  try {
    changes = await findChanges(app, current, opts.finder);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : "Check failed").slice(0, 500);
    if (msg !== app.autoUpdateError) {
      await audit({ action: "app.auto_update_check", outcome: "failure", message: `Auto-update check of ${app.name} failed: ${msg}`, targetType: "application", targetId: app.id, endpointId: app.endpointId });
    }
    await record({ autoUpdateError: msg });
    return { state: "error", summary: msg };
  }

  if (!changes.length) {
    await record({ autoUpdatePending: "", autoUpdateError: "" });
    return { state: "up-to-date", summary: "Up to date" };
  }
  const fingerprint = fingerprintOf(changes);
  const summary = summarize(changes);

  if (fingerprint === app.autoUpdateSkip) {
    const last = await prisma.autoUpdateRun.findFirst({ where: { applicationId: app.id, fingerprint }, orderBy: { createdAt: "desc" } });
    const why = last?.status === "success" ? "it was deployed, but the app still differs (did the pull fail?)" : `the last try ${last?.status === "rolled-back" ? "was rolled back" : "failed"}`;
    const pending = `${summary}. Not tried again: ${why}. Deploy by hand to retry.`;
    await record({ autoUpdatePending: pending.slice(0, 1000), autoUpdateError: "" });
    return { state: "already-tried", summary: pending };
  }

  if (!inWindow(now, app)) {
    const pending = `${summary}. Waiting for the maintenance window (${describeWindow(app)}).`;
    if (!app.autoUpdatePending.startsWith(summary)) {
      await audit({ action: "app.auto_update_available", message: `Update found for ${app.name}, waiting for the maintenance window`, targetType: "application", targetId: app.id, endpointId: app.endpointId, details: summary });
    }
    await record({ autoUpdatePending: pending.slice(0, 1000), autoUpdateError: "" });
    return { state: "waiting", summary: pending };
  }

  const commit = changes.find((c) => c.kind === "commit");
  let deployment: Deployment;
  try {
    deployment = await enqueueDeploy(app.id, {
      trigger: "auto-update",
      // Git apps deploy exactly the commit that was checked (also when only images changed)
      ...(app.sourceType.startsWith("git-") ? { commitSha: commit?.to ?? current.commitSha } : {}),
    });
  } catch (err) {
    if (err instanceof DeployBusyError) return { state: "busy", summary: err.message };
    throw err;
  }
  const run = await prisma.autoUpdateRun.create({
    data: { applicationId: app.id, fingerprint, summary: summary.slice(0, 1000), changes: JSON.stringify(changes), deploymentId: deployment.id, previousDeploymentId: current.id },
  });
  await record({ autoUpdatePending: "", autoUpdateError: "", autoUpdateSkip: fingerprint });
  await audit({ action: "app.auto_update", message: `Auto-update of ${app.name} started`, targetType: "application", targetId: app.id, endpointId: app.endpointId, details: summary });
  return { state: "queued", summary, runId: run.id };
}

// ─── Following updates in flight ─────────────────────────────────────────────

export interface Verifier {
  /** null when healthy, else why not */
  check: (app: CheckApp, deployment: Deployment) => Promise<string | null>;
}

/** The deployment's containers must be running (or have exited cleanly), not restarting, and healthy if they have a health check. */
export async function containersHealthy(app: CheckApp, deployment: Deployment): Promise<string | null> {
  const now = Date.now();
  const ids = deployment.containerIds.split(",").filter(Boolean);
  if (!ids.length) return null;
  const docker = dockerFor(app.endpoint);
  const problems: string[] = [];
  for (const id of ids) {
    const info = await docker.getContainer(id).inspect().catch(() => null);
    if (!info) {
      problems.push(`container ${id.slice(0, 12)} is gone`);
      continue;
    }
    const name = info.Config?.Labels?.["com.docker.compose.service"] || info.Name?.replace(/^\//, "") || id.slice(0, 12);
    const st = info.State;
    // A restart during start-up is fine if it has stayed up since; one in the last 30 seconds isn't
    const upFor = st.StartedAt ? now - new Date(st.StartedAt).getTime() : Infinity;
    if (st.Restarting || ((info.RestartCount ?? 0) > 0 && st.Running && upFor < RECENT_RESTART_MS)) problems.push(`${name} keeps restarting`);
    else if (st.Health?.Status === "unhealthy") problems.push(`${name} is unhealthy`);
    else if (!st.Running && st.ExitCode !== 0) problems.push(`${name} exited with code ${st.ExitCode}`);
    else if (!st.Running && st.Status !== "exited") problems.push(`${name} is ${st.Status}`);
  }
  return problems.length ? problems.join(", ") : null;
}

async function finish(run: AutoUpdateRun, app: CheckApp, status: string, error = "") {
  await prisma.autoUpdateRun.update({ where: { id: run.id }, data: { status, error: error.slice(0, 2000), finishedAt: new Date() } });
  const ok = status === "success";
  const messages: Record<string, string> = {
    success: "was installed",
    "rolled-back": "failed and was rolled back",
    "rollback-failed": "failed, and the rollback failed too",
    failed: "failed; the previous version kept running",
    cancelled: "was cancelled",
    superseded: "was replaced by a newer deployment",
  };
  await audit({
    action: "app.auto_update",
    outcome: ok ? "success" : "failure",
    message: `Auto-update of ${app.name} ${messages[status] ?? status}`,
    targetType: "application",
    targetId: app.id,
    endpointId: app.endpointId,
    details: [run.summary, error].filter(Boolean).join(" — "),
  });
  if (status === "cancelled" || status === "superseded") return;
  await notify({
    event: ok ? "autoupdate.success" : "autoupdate.failure",
    ok,
    title: `Auto-update of ${appTitle(app)} ${messages[status] ?? status}`,
    text: ok ? run.summary : [error, run.summary].filter(Boolean).join("\n"),
    ...appLink(app.id),
    fields: { Endpoint: app.endpoint.name, Changes: run.summary },
  });
}

/** A deployment other than the update and the one before it is current: a person (or a push) deployed meanwhile. */
function superseded(app: CheckApp, run: AutoUpdateRun): boolean {
  return !!app.currentDeploymentId && app.currentDeploymentId !== run.deploymentId && app.currentDeploymentId !== run.previousDeploymentId;
}

async function startRollback(run: AutoUpdateRun, app: CheckApp, why: string) {
  if (!app.autoUpdateRollback || !run.previousDeploymentId) {
    await finish(run, app, "failed", `${why}${app.autoUpdateRollback ? "" : " (automatic rollback is off)"}`);
    return;
  }
  try {
    const rb = await enqueueDeploy(app.id, { trigger: "rollback", rollbackOfId: run.previousDeploymentId });
    await prisma.autoUpdateRun.update({ where: { id: run.id }, data: { status: "rolling-back", rollbackDeploymentId: rb.id, error: why.slice(0, 2000) } });
  } catch (err) {
    await finish(run, app, "rollback-failed", `${why}; the rollback couldn't start: ${(err as Error).message}`);
  }
}

/** Move every update in flight one step further. */
export async function advanceRuns(opts: { now?: Date; verifier?: Verifier; verifyMs?: number } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const verify = opts.verifier?.check ?? containersHealthy;
  const verifyMs = opts.verifyMs ?? VERIFY_MS;
  const runs = await prisma.autoUpdateRun.findMany({ where: { status: { in: ["deploying", "verifying", "rolling-back"] } } });
  for (const run of runs) {
    try {
      const app = (await prisma.application.findUnique({ where: { id: run.applicationId }, include: appInclude })) as CheckApp | null;
      if (!app) continue;
      if (run.status === "rolling-back") {
        const rb = await prisma.deployment.findUnique({ where: { id: run.rollbackDeploymentId } });
        if (rb && (rb.status === "queued" || rb.status === "running")) continue;
        if (rb?.status === "success") await finish(run, app, "rolled-back", run.error);
        else await finish(run, app, "rollback-failed", `${run.error}; rollback: ${rb?.error || rb?.status || "missing"}`);
        continue;
      }
      const dep = await prisma.deployment.findUnique({ where: { id: run.deploymentId } });
      if (!dep) {
        await finish(run, app, "failed", "The deployment was removed");
        continue;
      }
      if (run.status === "deploying") {
        if (dep.status === "queued" || dep.status === "running") continue;
        if (dep.status === "cancelled") {
          await finish(run, app, "cancelled", "The deployment was cancelled");
        } else if (dep.status === "failed" && superseded(app, run)) {
          await finish(run, app, "superseded", "A newer deployment replaced it; not rolled back");
        } else if (dep.status === "failed") {
          // Image and Dockerfile apps keep the old container when the new one doesn't come up;
          // compose may have replaced some services already, so roll those back
          if (app.sourceType === "image" || app.sourceType === "git-dockerfile") await finish(run, app, "failed", dep.error);
          else await startRollback(run, app, dep.error || "The deployment failed");
        } else {
          const base = dep.finishedAt ?? now;
          await prisma.autoUpdateRun.update({ where: { id: run.id }, data: { status: "verifying", verifyAfter: new Date(base.getTime() + verifyMs) } });
        }
        continue;
      }
      // verifying
      if (run.verifyAfter && run.verifyAfter > now) continue;
      // Someone deployed again in the meantime: their deployment is what runs now, don't undo it
      if (app.currentDeploymentId !== run.deploymentId) {
        await finish(run, app, "superseded", "A newer deployment replaced it before the health check");
        continue;
      }
      const problem = await verify(app, dep);
      if (!problem) await finish(run, app, "success");
      else await startRollback(run, app, `Unhealthy after the update: ${problem}`);
    } catch (err) {
      console.error(`[auto-update] Run ${run.id} failed:`, err instanceof Error ? err.message : "unknown error");
    }
  }
}

/** One poll cycle: follow updates in flight, then check the apps that are due. */
export async function runAutoUpdates(opts: { now?: Date; finder?: Finder; verifier?: Verifier; verifyMs?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  await advanceRuns(opts);
  const apps = await prisma.application.findMany({
    where: { autoUpdate: true, previewOfId: null, currentDeploymentId: { not: null }, status: { in: ["running", "failed"] } },
  });
  let queued = 0;
  for (const app of apps) {
    if (!isDue(app, now)) continue;
    try {
      const r = await checkApp(app.id, { now, finder: opts.finder });
      if (r.state === "queued") queued++;
    } catch (err) {
      console.error(`[auto-update] Check of ${app.name} failed:`, err instanceof Error ? err.message : "unknown error");
    }
  }
  return queued;
}

/** Kept for older imports: image apps are now one case of runAutoUpdates. */
export const checkAppImageUpdates = runAutoUpdates;

export function serializeRun(r: AutoUpdateRun) {
  let changes: Change[] = [];
  try {
    changes = JSON.parse(r.changes);
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    status: r.status,
    summary: r.summary,
    changes,
    error: r.error,
    deploymentId: r.deploymentId,
    rollbackDeploymentId: r.rollbackDeploymentId,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  };
}
