/**
 * New DeployNow releases. Every 12 hours DeployNow reads the repository's GitHub
 * releases (no account, no data about the instance beyond the User-Agent
 * "DeployNow/<version>"), remembers the newest one, shows it to admins and
 * sends one "update.available" notification per release.
 *
 * Off with Settings → Updates, or DEPLOYNOW_UPDATE_CHECK=off.
 */
import { prisma } from "./prisma";
import { VERSION } from "./version";
import { notify } from "./notify";
import { publicBaseUrl } from "./publicOrigin";

export const RELEASES_URL = process.env.DEPLOYNOW_RELEASES_URL || "https://api.github.com/repos/encorp-io/deploynow/releases?per_page=20";
const EVERY_MS = 12 * 3600_000;
const FIRST_AFTER_MS = 60_000;
const MAX_NOTES = 4000;

type Semver = [number, number, number, string];

export function parseVersion(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""] : null;
}

/** >0 when a is newer than b. A pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3].localeCompare(y[3], undefined, { numeric: true });
}

export function checkEnabledByEnv(): boolean {
  return String(process.env.DEPLOYNOW_UPDATE_CHECK ?? "").toLowerCase() !== "off";
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * The newest release that applies to this version: stable releases only, unless
 * this is itself a pre-release (then pre-releases count too).
 */
export function pickLatest(releases: GithubRelease[], current = VERSION): { version: string; url: string; notes: string } | null {
  const wantPre = !!parseVersion(current)?.[3];
  let best: { version: string; url: string; notes: string } | null = null;
  for (const r of releases) {
    if (!r || r.draft || (r.prerelease && !wantPre) || !r.tag_name) continue;
    const version = r.tag_name.replace(/^v/, "");
    if (!parseVersion(version)) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, url: typeof r.html_url === "string" && r.html_url.startsWith("https://github.com/") ? r.html_url : "", notes: (r.body ?? "").slice(0, MAX_NOTES) };
    }
  }
  return best;
}

export interface UpdateStatus {
  current: string;
  latest: string;
  url: string;
  notes: string;
  available: boolean;
  enabled: boolean;
  checkedAt: Date | null;
}

export async function updateStatus(): Promise<UpdateStatus> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const latest = s?.latestRelease ?? "";
  return {
    current: VERSION,
    latest,
    url: s?.latestReleaseUrl ?? "",
    notes: s?.latestReleaseNotes ?? "",
    available: !!latest && !!parseVersion(VERSION) && compareVersions(latest, VERSION) > 0,
    enabled: checkEnabledByEnv() && (s?.releaseCheck ?? true),
    checkedAt: s?.releaseCheckedAt ?? null,
  };
}

/** Ask GitHub for releases now. Throws on network or API errors. */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<UpdateStatus> {
  const res = await fetchImpl(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `DeployNow/${VERSION}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const list = (await res.json()) as GithubRelease[];
  const latest = pickLatest(Array.isArray(list) ? list : []);
  const data = {
    releaseCheckedAt: new Date(),
    ...(latest ? { latestRelease: latest.version, latestReleaseUrl: latest.url, latestReleaseNotes: latest.notes } : {}),
  };
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: data, create: { id: "singleton", ...data } });

  const status = await updateStatus();
  if (status.available && s.releaseNotified !== status.latest) {
    await prisma.settings.update({ where: { id: "singleton" }, data: { releaseNotified: status.latest } });
    const base = publicBaseUrl() ?? "";
    await notify({
      event: "update.available",
      ok: true,
      title: `DeployNow ${status.latest} is available`,
      text: `You run ${status.current}. See what changed and how to upgrade.`,
      link: status.url || (base ? `${base}/settings?section=updates` : undefined),
      fields: { Current: status.current, New: status.latest },
    });
  }
  return status;
}

interface CheckerState {
  timer: ReturnType<typeof setTimeout> | null;
}
const g = globalThis as unknown as { __deploynowUpdates?: CheckerState };
const state: CheckerState = (g.__deploynowUpdates ??= { timer: null });

export function startUpdateChecker() {
  if (state.timer || !checkEnabledByEnv() || process.env.NODE_ENV === "test") return;
  const run = async () => {
    try {
      const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
      if (s?.releaseCheck ?? true) await checkForUpdate();
    } catch (err) {
      console.warn("[deployer] Release check failed:", err instanceof Error ? err.message : err);
    } finally {
      state.timer = setTimeout(run, EVERY_MS);
      state.timer.unref?.();
    }
  };
  state.timer = setTimeout(run, FIRST_AFTER_MS);
  state.timer.unref?.();
}
