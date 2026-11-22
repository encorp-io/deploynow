// DeployNow CLI: the parts that don't touch the terminal, so they can be tested.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOKEN_RE = /^dn_[A-Za-z0-9_-]{43}$/;
export const FINAL = new Set(["success", "failed", "cancelled"]);

export function configPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "deploynow", "config.json");
}

/** The URL and token: flags, then environment, then the saved config. */
export function loadConfig(flags = {}, env = process.env, file = configPath(env)) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* no config yet */
  }
  const url = String(flags.url || env.DEPLOYNOW_URL || saved.url || "").replace(/\/+$/, "");
  const token = String(flags.token || env.DEPLOYNOW_TOKEN || saved.token || "");
  return { url, token };
}

export function saveConfig(cfg, file = configPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Parse argv into positionals and --flags (--k v, --k=v, --bool). */
export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else if (a === "-h") flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function client({ url, token }, fetchImpl = globalThis.fetch) {
  if (!url) throw new ApiError(0, "No server set. Run: deploynow login --url https://deploynow.example.com --token dn_…");
  if (!/^https?:\/\//.test(url)) throw new ApiError(0, "The server URL must start with https://");
  if (!token) throw new ApiError(0, "No API token set. Create one under Account → API tokens, then run deploynow login.");
  return async function api(method, p, body) {
    const res = await fetchImpl(`${url}/api${p}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `The server answered ${res.status}`);
    return data;
  };
}

/** Find an app by id, name or project/env/name across the visible projects. */
export function findApp(projects, ref) {
  const apps = [];
  for (const p of projects) for (const e of p.environments) for (const a of e.apps) apps.push({ ...a, project: p.slug, env: e.slug, path: `${p.slug}/${e.slug}/${a.name}` });
  const hits = apps.filter((a) => a.id === ref || a.path === ref || a.name === ref || `${a.project}/${a.name}` === ref);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new ApiError(0, `"${ref}" matches ${hits.length} apps: ${hits.map((h) => h.path).join(", ")}. Use project/env/name or the id.`);
  throw new ApiError(0, `No app called "${ref}"`);
}

/** Render rows as an aligned table. */
export function table(rows, columns) {
  if (!rows.length) return "(none)";
  const cells = rows.map((r) => columns.map((c) => String(r[c] ?? "")));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
  return [line(columns.map((c) => c.toUpperCase())), ...cells.map(line)].join("\n");
}

/** Follow a deployment's log until it finishes. Returns the final deployment. */
export async function followDeployment(api, appId, depId, write, { interval = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let offset = 0;
  for (;;) {
    const d = await api("GET", `/apps/${appId}/deployments/${depId}?offset=${offset}`);
    if (d.log) write(d.log);
    offset = d.next ?? offset;
    if (FINAL.has(d.status)) return d;
    await sleep(interval);
  }
}

export const HELP = `deploynow — command-line client for DeployNow

Usage:
  deploynow login --url <https://…> --token <dn_…>   Save the server and token
  deploynow endpoints                                List endpoints
  deploynow apps                                     List apps (project/env/name)
  deploynow deploy <app> [--commit <sha>] [--no-follow]
                                                     Deploy and stream the log
  deploynow deployments <app>                        Recent deployments
  deploynow rollback <app> <deployment-id>           Roll back to a deployment
  deploynow logs <endpoint> <container> [--tail 200] Container logs
  deploynow backups                                  Backup policies and their last run
  deploynow backup <policy-id>                       Back up now
  deploynow tasks                                    Scheduled tasks
  deploynow run-task <task-id>                       Run a task now
  deploynow alerts                                   Active alerts
  deploynow api <METHOD> <path> [json]               Call any API route

The URL and token can also come from DEPLOYNOW_URL and DEPLOYNOW_TOKEN.
Add --json to any listing for machine-readable output.`;
