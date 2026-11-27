/**
 * "Is there an update for this app?" for every deployed app, whether or not
 * auto-update is on. Runs from the background poller about once an hour per app
 * (and on Check now), and stores what it found on the app for the app page.
 *
 * It reports two kinds of updates:
 *   - the same thing, newer: a tag that now points to a new digest, or a new
 *     commit on a Git app's branch (what auto-update deploys, see autoUpdate.ts)
 *   - a newer tag: the app runs a pinned tag (4.55, 17-alpine, v1.2.3, sha-82e99af)
 *     and the registry has a newer one. Deploying again doesn't pick that up; the
 *     image (or the variable it comes from) has to change, so it is shown, never
 *     deployed automatically.
 */
import type { Deployment } from "@prisma/client";
import { prisma } from "../prisma";
import { dockerFor } from "../endpoints";
import { parseImageRef } from "../imageRef";
import { isCurrent } from "../polling";
import { registryTags, remoteImageInfo, type RemoteImageInfo } from "../registryDigests";
import { appPullContext, registryAuthFor } from "../registryAuth";
import { readStoredEnv, resolveEnv } from "./env";
import { audit } from "../audit";
import { notify } from "../notify";
import { publicBaseUrl } from "../publicOrigin";
import { composeImages, findChanges, runningServices, type Change, type CheckApp, type Finder, type RunningImage } from "./autoUpdate";

/** Minutes between two checks of the same app. */
export const UPDATE_CHECK_MINUTES = 60;

// ─── Newer tags ──────────────────────────────────────────────────────────────

interface Version {
  prefix: string;
  nums: number[];
  suffix: string;
}

/** "v1.2.3-alpine" → { prefix: "v", nums: [1, 2, 3], suffix: "-alpine" }; null for tags that aren't versions. */
export function parseVersionTag(tag: string): Version | null {
  const m = /^(v?)(\d+(?:\.\d+)*)([-_+][\w.+-]*)?$/i.exec(tag);
  if (!m) return null;
  const nums = m[2].split(".").map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  return { prefix: m[1].toLowerCase(), nums, suffix: m[3] ?? "" };
}

function compareNums(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Newer tags of the same shape as `tag`: same prefix, same number of parts and
 * the same suffix, so 4.55 → 4.56, 17-alpine → 18-alpine and v1.2.3 → v1.3.0,
 * never 4.55 → 4.56-rc1 or 17-alpine → 17.2-bookworm.
 * `minor` is the newest with the same major version, `major` the newest overall
 * when that is a new major version.
 */
export function newerVersionTags(tag: string, tags: string[]): { minor?: string; major?: string } {
  const cur = parseVersionTag(tag);
  if (!cur) return {};
  let minor: { tag: string; v: Version } | null = null;
  let major: { tag: string; v: Version } | null = null;
  for (const t of tags) {
    const v = parseVersionTag(t);
    if (!v || v.prefix !== cur.prefix || v.suffix !== cur.suffix || v.nums.length !== cur.nums.length) continue;
    if (compareNums(v.nums, cur.nums) <= 0) continue;
    if (v.nums[0] === cur.nums[0]) {
      if (!minor || compareNums(v.nums, minor.v.nums) > 0) minor = { tag: t, v };
    } else if (!major || compareNums(v.nums, major.v.nums) > 0) {
      major = { tag: t, v };
    }
  }
  return { ...(minor ? { minor: minor.tag } : {}), ...(major ? { major: major.tag } : {}) };
}

/** "sha-82e99af" → { prefix: "sha-", hex: "82e99af" }: a tag naming the commit it was built from. */
export function parseCommitTag(tag: string): { prefix: string; hex: string } | null {
  const m = /^(sha-|git-|commit-)?([0-9a-f]{7,40})$/i.exec(tag);
  if (!m) return null;
  // Plain digits are versions or dates (20241105), not commits
  if (!m[1] && !/[a-f]/i.test(m[2])) return null;
  return { prefix: m[1] ?? "", hex: m[2] };
}

/** Tags that follow the newest build, in the order they are tried. */
export const MOVING_TAGS = ["latest", "main", "master"];

export interface TagUpdate {
  /** Compose service, "" for an image app */
  service: string;
  /** The image as it runs now */
  image: string;
  from: string;
  to: string;
  kind: "minor" | "major" | "build";
  /** For a build: the moving tag that points to the newer build */
  via?: string;
  /** The compose variable the image comes from, when it is one */
  variable?: string;
}

export interface TagFinder {
  tags: (image: string, auth?: { username: string; password: string }) => Promise<string[]>;
  info: (image: string, opts: { arch?: string; auth?: { username: string; password: string } }) => Promise<RemoteImageInfo | null>;
}

const defaultTagFinder: TagFinder = {
  tags: (image, auth) => registryTags(image, { auth }),
  info: (image, opts) => remoteImageInfo(image, opts),
};

/** The same image with another tag: "ghcr.io/acme/web:sha-1" + "main" → "ghcr.io/acme/web:main". */
export function withTag(image: string, tag: string): string {
  const name = image.replace(/@sha256:[0-9a-f]+$/, "");
  const at = name.lastIndexOf(":");
  return `${at > name.lastIndexOf("/") ? name.slice(0, at) : name}:${tag}`;
}

/**
 * Newer tags for one running image. A version tag gets the newest tag of the same
 * shape; a commit tag gets the build a moving tag (latest, main, master) points to,
 * when that is newer than what runs, named by its own commit tag when the registry has one.
 */
export async function newerTagsFor(
  image: string,
  local: Pick<RunningImage, "currentDigest" | "repoDigests" | "arch" | "created">,
  auth: { username: string; password: string } | undefined,
  finder: TagFinder = defaultTagFinder,
): Promise<Omit<TagUpdate, "service" | "variable">[]> {
  const tag = parseImageRef(image).tag;
  const version = parseVersionTag(tag);
  const commit = version ? null : parseCommitTag(tag);
  if (!version && !commit) return [];
  const tags = await finder.tags(image, auth);
  if (version) {
    const { minor, major } = newerVersionTags(tag, tags);
    return [
      ...(minor ? [{ image, from: tag, to: minor, kind: "minor" as const }] : []),
      ...(major ? [{ image, from: tag, to: major, kind: "major" as const }] : []),
    ];
  }
  if (!commit) return [];
  // Try each moving tag: a stale `latest` mustn't hide an actively updated `main`
  for (const moving of MOVING_TAGS.filter((t) => tags.includes(t))) {
    const remote = await finder.info(withTag(image, moving), { arch: local.arch, auth });
    if (!remote || isCurrent(local, remote)) continue;
    // Only a build that is newer than the running one: a moving tag can also point back
    const remoteAt = Date.parse(remote.created);
    const localAt = Date.parse(local.created);
    if (!Number.isFinite(remoteAt) || (Number.isFinite(localAt) && remoteAt <= localAt)) continue;
    const rev = /^[0-9a-f]{7,40}$/i.test(remote.revision) ? remote.revision.toLowerCase() : "";
    const named = rev ? `${commit.prefix}${rev.slice(0, commit.hex.length)}` : "";
    if (named && named.toLowerCase() === tag.toLowerCase()) continue;
    const to = named && tags.includes(named) ? named : moving;
    return [{ image, from: tag, to, kind: "build", via: moving }];
  }
  return [];
}

// ─── Checking an app ─────────────────────────────────────────────────────────

export interface UpdateInfo {
  /** A new digest for a tag the app runs, or a new commit: deploying again applies it */
  changes: Change[];
  /** A newer tag than the one the app runs: the image has to change first */
  tags: TagUpdate[];
}

export function parseUpdateInfo(raw: string): UpdateInfo {
  try {
    const v = JSON.parse(raw || "{}") as Partial<UpdateInfo>;
    return { changes: Array.isArray(v.changes) ? v.changes : [], tags: Array.isArray(v.tags) ? v.tags : [] };
  } catch {
    return { changes: [], tags: [] };
  }
}

function fingerprint(info: UpdateInfo): string {
  return [...info.changes.map((c) => `${c.kind}:${c.name}=${c.to}`), ...info.tags.map((t) => `tag:${t.service}:${t.image}=${t.to}`)].sort().join(";");
}

export function describeUpdates(info: UpdateInfo): string {
  const parts = [
    ...info.changes.map((c) => (c.kind === "commit" ? `new commit ${c.to.slice(0, 12)} on ${c.name}` : `${c.name}: new image for the same tag`)),
    ...info.tags.map((t) => {
      const who = t.service ? `${t.service}: ` : "";
      const what = t.kind === "build" ? `newer build ${t.to}${t.to !== t.via ? ` (on :${t.via})` : ""}` : `${t.to}${t.kind === "major" ? " (new major version)" : ""}`;
      return `${who}${t.from} → ${what}`;
    }),
  ];
  return parts.join("; ");
}

const appInclude = { endpoint: true, environment: { include: { project: true } } } as const;

/** The running container of an image app's current deployment. */
async function runningImageApp(app: CheckApp, current: Deployment): Promise<RunningImage | null> {
  const docker = dockerFor(app.endpoint);
  const list = await docker.listContainers({ all: true, filters: { label: [`deploynow.deployment=${current.id}`] } });
  const c = list.find((x) => x.State === "running") ?? list[0];
  if (!c) return null;
  const info = await docker.getImage(c.ImageID).inspect().catch(() => null);
  return { currentDigest: c.ImageID, repoDigests: (info?.RepoDigests ?? []).join(","), arch: info?.Architecture || "amd64", created: info?.Created ?? "" };
}

/** Newer tags for every registry image the app runs. */
export async function findTagUpdates(app: CheckApp, current: Deployment, finder: TagFinder = defaultTagFinder): Promise<TagUpdate[]> {
  const pullCtx = appPullContext(app);
  const out: TagUpdate[] = [];
  const authFor = async (image: string) => {
    const a = await registryAuthFor(image, pullCtx);
    return a?.username ? { username: a.username, password: a.password ?? "" } : undefined;
  };

  if (app.sourceType === "image") {
    if (!app.image || app.image.includes("@sha256:")) return [];
    const local = await runningImageApp(app, current);
    if (!local) return [];
    for (const t of await newerTagsFor(app.image, local, await authFor(app.image), finder)) out.push({ ...t, service: "" });
    return out;
  }

  if ((app.sourceType === "compose" || app.sourceType === "git-compose") && current.renderedCompose) {
    const raw = current.renderedCompose;
    let env: Record<string, string | undefined> = {};
    if (/image:\s*["']?[^\n]*\$/.test(raw)) {
      const resolved = await resolveEnv(readStoredEnv(current.envSnapshot || app.env)).catch(() => null);
      env = Object.fromEntries((resolved?.vars ?? []).map((v) => [v.key, v.value]));
    }
    const images = composeImages(raw, env);
    if (!images.length) return [];
    const running = await runningServices(app);
    const seen = new Map<string, Omit<TagUpdate, "service" | "variable">[]>();
    for (const { service, image, variable } of images) {
      const local = running.get(service);
      if (!local) continue;
      const key = `${image}|${local.currentDigest}`;
      if (!seen.has(key)) seen.set(key, await newerTagsFor(image, local, await authFor(image), finder));
      for (const t of seen.get(key) ?? []) out.push({ ...t, service, ...(variable ? { variable } : {}) });
    }
  }
  return out;
}

export interface UpdateCheckResult {
  info: UpdateInfo;
  summary: string;
  error?: string;
}

/** Look for updates of one app and store what was found. Never deploys anything. */
export async function checkAppUpdates(appId: string, opts: { now?: Date; finder?: Finder; tagFinder?: TagFinder } = {}): Promise<UpdateCheckResult> {
  const now = opts.now ?? new Date();
  const app = (await prisma.application.findUnique({ where: { id: appId }, include: appInclude })) as CheckApp | null;
  const empty: UpdateInfo = { changes: [], tags: [] };
  if (!app) return { info: empty, summary: "" };
  const record = (data: { updateInfo?: string; updateError?: string }) =>
    prisma.application.update({ where: { id: app.id }, data: { updateCheckedAt: now, ...data } });

  const current = app.currentDeploymentId && app.status !== "stopped" ? await prisma.deployment.findUnique({ where: { id: app.currentDeploymentId } }) : null;
  if (!current) {
    await record({ updateInfo: "", updateError: "" });
    return { info: empty, summary: "" };
  }

  // Both checks run; one failing (say, a tag list the registry won't give out) doesn't hide the other
  const errors: string[] = [];
  const before = parseUpdateInfo(app.updateInfo);
  // A sub-check that fails keeps what it found last time; one that succeeds replaces it
  const changes = await findChanges(app, current, opts.finder).catch((err) => {
    errors.push(err instanceof Error ? err.message : "check failed");
    return before.changes;
  });
  const tags = await findTagUpdates(app, current, opts.tagFinder).catch((err) => {
    errors.push(err instanceof Error ? err.message : "tag check failed");
    return before.tags;
  });
  const info: UpdateInfo = { changes, tags };
  const error = [...new Set(errors)].join("; ").slice(0, 500);
  const summary = describeUpdates(info);
  const found = changes.length || tags.length;
  await record({ updateInfo: found ? JSON.stringify(info) : "", updateError: error });

  if (found && fingerprint(info) !== fingerprint(before)) {
    const title = `${app.environment.project.name} / ${app.name} (${app.environment.name})`;
    await audit({ action: "app.update_available", message: `Update available for ${app.name}`, targetType: "application", targetId: app.id, endpointId: app.endpointId, details: summary.slice(0, 1000) });
    // Auto-update deploys new digests itself and sends its own notice; tell people about the rest
    if (!app.autoUpdate || tags.length) {
      await notify({
        event: "app.update_available",
        ok: true,
        title: `Update available for ${title}`,
        text: summary.slice(0, 1000),
        ...(publicBaseUrl() ? { link: `${publicBaseUrl()}/apps/${app.id}` } : {}),
        fields: { Endpoint: app.endpoint.name },
      }).catch(() => {});
    }
  }
  return { info, summary, ...(error ? { error } : {}) };
}

/** Is the app due for an update check? */
export function updateCheckDue(app: { updateCheckedAt: Date | null }, now = new Date()): boolean {
  return !app.updateCheckedAt || now.getTime() - app.updateCheckedAt.getTime() >= UPDATE_CHECK_MINUTES * 60_000 - 10_000;
}

/** Check every deployed app that is due (background poller). */
export async function runUpdateChecks(opts: { now?: Date; finder?: Finder; tagFinder?: TagFinder } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const apps = await prisma.application.findMany({
    where: { previewOfId: null, currentDeploymentId: { not: null }, status: { in: ["running", "failed"] } },
    select: { id: true, name: true, updateCheckedAt: true },
  });
  for (const app of apps) {
    if (!updateCheckDue(app, now)) continue;
    try {
      await checkAppUpdates(app.id, { ...opts, now });
    } catch (err) {
      console.error(`[updates] Check of ${app.name} failed:`, err instanceof Error ? err.message : "unknown error");
    }
  }
}
