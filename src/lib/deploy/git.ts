/**
 * Shallow checkout of one commit or branch into a build directory.
 * The GitHub token travels in git's environment (GIT_CONFIG_*), never on the
 * command line or in the remote URL, so it can't show up in ps or logs.
 */
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

export function gitEnv(repoUrl: string, token?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: "/tmp",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  };
  if (token) {
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

  let sha = "";
  let message = "";
  await runCommand("git", ["log", "-1", "--format=%H%n%s"], {
    cwd: dir,
    env,
    onOutput: (l) => (sha ? (message ||= l) : (sha = l.trim())),
  });
  return { sha, message: message.slice(0, 300) };
}

async function hasSubmodules(dir: string): Promise<boolean> {
  const fs = await import("fs");
  const path = await import("path");
  return fs.existsSync(path.join(dir, ".gitmodules"));
}
