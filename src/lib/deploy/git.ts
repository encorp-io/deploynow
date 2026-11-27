/**
 * Shallow checkout of one commit or branch into a build directory.
 * The GitHub token travels in git's environment (GIT_CONFIG_*), never on the
 * command line or in the remote URL, so it can't show up in ps or logs.
 */
import fs from "fs";
import path from "path";
import { runCommand } from "../docker/cliBridge";

export const BRANCH_RE = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
export const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** https only; no credentials, ports are fine. */
export function validateRepoUrl(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error("Enter the repository's https URL, e.g. https://github.com/org/app");
  }
  if (url.protocol !== "https:") throw new Error("Only https repository URLs are supported");
  if (url.username || url.password) throw new Error("Don't put credentials in the URL; set a GitHub token in Settings");
  if (!/^[\w.-]+$/.test(url.hostname)) throw new Error("Invalid repository host");
  if (!/^\/[\w.\/-]+$/.test(url.pathname) || url.pathname.includes("..")) throw new Error("Invalid repository path");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

/** Relative path inside the repository, no escaping it. */
export function validateRepoPath(raw: unknown, fallback: string): string {
  const v = (typeof raw === "string" ? raw.trim() : "") || fallback;
  const clean = v.replace(/^\.\/+/, "").replace(/\/+$/, "") || ".";
  if (clean.startsWith("/") || clean.split("/").includes("..") || !/^[\w./ -]+$/.test(clean)) {
    throw new Error(`Invalid path "${v}": use a path inside the repository`);
  }
  return clean;
}

/**
 * Hosts the Settings GitHub token may be sent to. Anything else (a GitLab URL, a
 * typo, a hostile host) is fetched anonymously, so the token can't leak to it.
 * GITHUB_HOSTS adds GitHub Enterprise hosts, comma separated.
 */
export function tokenAllowedFor(repoUrl: string): boolean {
  let host = "";
  try {
    host = new URL(repoUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const extra = (process.env.GITHUB_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return host === "github.com" || extra.includes(host);
}

export function gitEnv(repoUrl: string, token?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  };
  if (token && tokenAllowedFor(repoUrl)) {
    const host = new URL(repoUrl).origin;
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${host}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return env;
}

export interface CheckoutResult {
  sha: string;
  message: string;
}

export async function checkout(
  dir: string,
  repoUrl: string,
  ref: { branch: string; sha?: string },
  opts: { token?: string; log: (line: string) => void; signal?: AbortSignal },
): Promise<CheckoutResult> {
  if (!BRANCH_RE.test(ref.branch)) throw new Error("Invalid branch name");
  if (ref.sha && !SHA_RE.test(ref.sha)) throw new Error("Invalid commit");
  const env = gitEnv(repoUrl, opts.token);
  const run = (args: string[]) =>
    runCommand("git", args, { cwd: dir, env, onOutput: opts.log, signal: opts.signal, timeoutMs: 5 * 60_000 });

  await run(["init", "--quiet"]);
  await run(["remote", "add", "origin", repoUrl]);
  const target = ref.sha ?? `refs/heads/${ref.branch}`;
  await run(["fetch", "--depth", "1", "--no-tags", "--quiet", "origin", target]);
  await run(["-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD"]);
  if (await hasSubmodules(dir)) {
    await run(["submodule", "update", "--init", "--recursive", "--depth", "1"]);
  }
  assertNoEscapingLinks(dir);

  let sha = "";
  let message = "";
  await runCommand("git", ["log", "-1", "--format=%H%n%s"], {
    cwd: dir,
    env,
    onOutput: (l) => (sha ? (message ||= l) : (sha = l.trim())),
  });
  return { sha, message: message.slice(0, 300) };
}

/**
 * Refuse a checkout with symlinks that lead out of the repository. Compose and the
 * docker CLI run inside the DeployNow container and follow links, so a committed
 * `docker-compose.yml -> /proc/1/environ` or `env_file: ./x` with `x -> /data/…`
 * would read DeployNow's own secrets.
 */
export function assertNoEscapingLinks(root: string, maxEntries = 200_000): void {
  const realRoot = fs.realpathSync(root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  const stack = [realRoot];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > maxEntries) throw new Error(`The repository has more than ${maxEntries} files`);
      const full = path.join(dir, entry.name);
      if (dir === realRoot && entry.name === ".git") continue;
      if (entry.isSymbolicLink()) {
        const target = path.resolve(dir, fs.readlinkSync(full));
        let real = target;
        try {
          real = fs.realpathSync(full);
        } catch {
          // dangling: judge the link by where it points
        }
        if (!inside(target) || !inside(real)) {
          throw new Error(`${path.relative(realRoot, full)} is a link to outside the repository; DeployNow won't deploy it`);
        }
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

async function hasSubmodules(dir: string): Promise<boolean> {
  return fs.existsSync(path.join(dir, ".gitmodules"));
}
