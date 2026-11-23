/**
 * Backup destinations, sources and policies: validation and restic settings.
 */
import crypto from "crypto";
import { CronExpressionParser } from "cron-parser";
import type { BackupDestination, BackupRepo } from "@prisma/client";
import { decryptSecret } from "../secretsCrypto";

export const RESTIC_IMAGE = process.env.RESTIC_IMAGE || "restic/restic:0.18.1";
export const MODES = ["stop", "dump", "live"] as const;
export type Mode = (typeof MODES)[number];
export const DB_ENGINES = ["postgres", "mysql", "mongo", "redis"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];
export const PROVIDERS = ["r2", "s3", "b2", "other"] as const;

export class BackupConfigError extends Error {}

export type Source =
  | { type: "volume"; name: string }
  | { type: "bind"; path: string }
  | { type: "db"; engine: DbEngine; container: string; database?: string; command?: string }
  | { type: "app"; applicationId: string }
  | { type: "instance" };

const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const DB_RE = /^[a-zA-Z0-9_.$-]{1,128}$/;
// Bind paths: absolute, no .., no shell-special characters
const PATH_RE = /^\/[a-zA-Z0-9_.@/ +-]*$/;
export const FORBIDDEN_BINDS = ["/", "/proc", "/sys", "/dev", "/etc", "/root", "/boot", "/run", "/var/run"];

/** A stable key for a source, used as a restic tag and to match snapshots back to it. */
export function sourceKey(s: Source): string {
  switch (s.type) {
    case "volume":
      return `volume:${s.name}`;
    case "bind":
      return `bind:${s.path}`;
    case "db":
      return `db:${s.container}${s.database ? "/" + s.database : ""}`;
    case "app":
      return `app:${s.applicationId}`;
    case "instance":
      return "instance";
  }
}

/** The path a source has inside a snapshot. */
export function snapshotPath(s: Source): string {
  switch (s.type) {
    case "volume":
      return `/data/volume/${s.name}`;
    case "bind":
      return `/data/bind${s.path}`;
    case "db":
      return `/data/db/${s.container}`;
    case "instance":
      return "/data/instance";
    case "app":
      throw new BackupConfigError("An app source is backed up as its volumes");
  }
}

export function validateSources(raw: unknown, forInstance: boolean): Source[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BackupConfigError("Choose at least one thing to back up");
  if (raw.length > 50) throw new BackupConfigError("At most 50 sources per policy");
  const out: Source[] = [];
  for (const r of raw) {
    const s = (r ?? {}) as Record<string, unknown>;
    if (forInstance) {
      if (s.type !== "instance") throw new BackupConfigError("A DeployNow backup policy backs up DeployNow itself");
      out.push({ type: "instance" });
      continue;
    }
    switch (s.type) {
      case "volume": {
        const name = String(s.name ?? "").trim();
        if (!VOLUME_RE.test(name)) throw new BackupConfigError(`Invalid volume name: ${name || "(empty)"}`);
        out.push({ type: "volume", name });
        break;
      }
      case "bind": {
        const p = String(s.path ?? "").trim().replace(/\/+$/, "");
        if (FORBIDDEN_BINDS.includes(p || "/")) throw new BackupConfigError(`${p || "/"} can't be backed up as a bind path; pick a data directory`);
        if (!PATH_RE.test(p) || p.split("/").includes("..") || p.length > 500) throw new BackupConfigError(`Invalid path: ${p}`);
        out.push({ type: "bind", path: p });
        break;
      }
      case "db": {
        const engine = String(s.engine ?? "") as DbEngine;
        if (!DB_ENGINES.includes(engine)) throw new BackupConfigError("Database engine must be postgres, mysql, mongo or redis");
        const container = String(s.container ?? "").trim();
        if (!CONTAINER_RE.test(container)) throw new BackupConfigError(`Invalid container name: ${container || "(empty)"}`);
        const database = String(s.database ?? "").trim();
        if (database && !DB_RE.test(database)) throw new BackupConfigError(`Invalid database name: ${database}`);
        const command = String(s.command ?? "").trim().slice(0, 2000);
        out.push({ type: "db", engine, container, ...(database ? { database } : {}), ...(command ? { command } : {}) });
        break;
      }
      case "app": {
        const id = String(s.applicationId ?? "").trim();
        if (!/^c[a-z0-9]{20,30}$/.test(id)) throw new BackupConfigError("Invalid application");
        out.push({ type: "app", applicationId: id });
        break;
      }
      default:
        throw new BackupConfigError("Unknown source type");
    }
  }
  const keys = out.map(sourceKey);
  if (new Set(keys).size !== keys.length) throw new BackupConfigError("The same source is listed twice");
  return out;
}

export function parseSources(raw: string): Source[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Source[]) : [];
  } catch {
    return [];
  }
}

export interface Hook {
  container: string;
  command: string;
}

export function validateHook(raw: unknown): Hook | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  const container = String(h.container ?? "").trim();
  const command = String(h.command ?? "").trim();
  if (!container && !command) return null;
  if (!CONTAINER_RE.test(container)) throw new BackupConfigError("A hook needs a container name");
  if (!command || command.length > 2000) throw new BackupConfigError("A hook needs a command (up to 2000 characters)");
  return { container, command };
}

export function parseHook(raw: string): Hook | null {
  if (!raw) return null;
  try {
    return validateHook(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Next run of a cron schedule after `from`, or throws BackupConfigError. */
export function nextRun(schedule: string, from = new Date()): Date {
  const expr = schedule.trim();
  if (expr.split(/\s+/).length !== 5) throw new BackupConfigError("The schedule must be a 5-field cron expression, e.g. 0 3 * * *");
  try {
    return CronExpressionParser.parse(expr, { currentDate: from, tz: process.env.TZ || undefined }).next().toDate();
  } catch (err) {
    throw new BackupConfigError(`Invalid schedule: ${err instanceof Error ? err.message : "bad cron expression"}`);
  }
}

export function validateRetention(raw: Record<string, unknown>) {
  const n = (v: unknown, def: number, max: number) => {
    if (v === undefined || v === null || v === "") return def;
    const x = Number(v);
    if (!Number.isInteger(x) || x < 0 || x > max) throw new BackupConfigError(`Retention values must be whole numbers from 0 to ${max}`);
    return x;
  };
  const r = { keepDaily: n(raw.keepDaily, 7, 365), keepWeekly: n(raw.keepWeekly, 4, 520), keepMonthly: n(raw.keepMonthly, 6, 240) };
  if (r.keepDaily + r.keepWeekly + r.keepMonthly === 0) throw new BackupConfigError("Keep at least one snapshot");
  return r;
}

export function validateDestination(raw: Record<string, unknown>, existing?: BackupDestination) {
  const name = String(raw.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 80) throw new BackupConfigError("Give the destination a name");
  const provider = String(raw.provider ?? existing?.provider ?? "r2");
  if (!(PROVIDERS as readonly string[]).includes(provider)) throw new BackupConfigError("Unknown provider");
  let endpointUrl = String(raw.endpointUrl ?? existing?.endpointUrl ?? "").trim().replace(/\/+$/, "");
  if (provider === "r2" && /^[0-9a-f]{32}$/i.test(endpointUrl)) endpointUrl = `https://${endpointUrl}.r2.cloudflarestorage.com`;
  let u: URL;
  try {
    u = new URL(endpointUrl);
  } catch {
    throw new BackupConfigError("The endpoint must be a URL, e.g. https://<account id>.r2.cloudflarestorage.com");
  }
  const allowHttp = process.env.BACKUP_ALLOW_HTTP === "1";
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new BackupConfigError("The endpoint must use https");
  if (u.pathname !== "/" || u.search || u.username) throw new BackupConfigError("The endpoint is the bare host URL; put the bucket and folder in their own fields");
  const bucket = String(raw.bucket ?? existing?.bucket ?? "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new BackupConfigError("Invalid bucket name");
  const prefix = String(raw.prefix ?? existing?.prefix ?? "deploynow").trim().replace(/^\/+|\/+$/g, "");
  if (prefix && !/^[a-zA-Z0-9_.\-/]{1,200}$/.test(prefix)) throw new BackupConfigError("Invalid folder");
  const region = String(raw.region ?? existing?.region ?? (provider === "r2" ? "auto" : "us-east-1")).trim();
  if (!/^[a-z0-9-]{1,40}$/.test(region)) throw new BackupConfigError("Invalid region");
  const accessKeyId = String(raw.accessKeyId ?? existing?.accessKeyId ?? "").trim();
  if (!accessKeyId || accessKeyId.length > 200) throw new BackupConfigError("Enter the access key id");
  const secret = typeof raw.secretKey === "string" && raw.secretKey && raw.secretKey !== MASK ? raw.secretKey.trim() : null;
  if (!secret && !existing) throw new BackupConfigError("Enter the secret access key");
  const pruneKeyId = String(raw.pruneKeyId ?? existing?.pruneKeyId ?? "").trim().slice(0, 200);
  const pruneSecret = typeof raw.pruneSecretKey === "string" && raw.pruneSecretKey !== MASK ? raw.pruneSecretKey.trim() : null;
  if (pruneKeyId && !pruneSecret && !existing?.pruneSecretKey) throw new BackupConfigError("Enter the prune key's secret");
  return {
    name,
    provider,
    endpointUrl: u.origin,
    bucket,
    prefix,
    region,
    accessKeyId,
    secret,
    pruneKeyId,
    pruneSecret: pruneKeyId ? pruneSecret : "",
    objectLock: raw.objectLock !== undefined ? Boolean(raw.objectLock) : (existing?.objectLock ?? false),
  };
}

export const MASK = "••••••••";

export function newRepoPassword(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function repoUrl(dest: Pick<BackupDestination, "endpointUrl" | "bucket" | "prefix">, scope: string): string {
  const path = [dest.bucket, dest.prefix, scope].filter(Boolean).join("/");
  return `s3:${dest.endpointUrl}/${path}`;
}

/** restic environment for a repo; `prune` uses the delete-capable key when there is one. */
export function resticEnv(dest: BackupDestination, repo: BackupRepo, opts: { prune?: boolean } = {}): Record<string, string> {
  const usePrune = opts.prune && dest.pruneKeyId && dest.pruneSecretKey;
  const password = decryptSecret(repo.password);
  const secret = decryptSecret(usePrune ? dest.pruneSecretKey : dest.secretKey);
  if (!password || !secret) throw new BackupConfigError("Stored backup credentials can't be decrypted (was AUTH_SECRET changed?)");
  return {
    RESTIC_REPOSITORY: repoUrl(dest, repo.scope),
    RESTIC_PASSWORD: password,
    AWS_ACCESS_KEY_ID: usePrune ? dest.pruneKeyId : dest.accessKeyId,
    AWS_SECRET_ACCESS_KEY: secret,
    AWS_DEFAULT_REGION: dest.region,
    RESTIC_CACHE_DIR: "/tmp/restic-cache",
  };
}

export function resticOptions(dest: BackupDestination): string[] {
  return dest.region ? ["-o", `s3.region=${dest.region}`] : [];
}

/** The offline recovery kit: everything needed to restore without DeployNow, except the secret key. */
export function recoveryKit(dest: BackupDestination, repo: BackupRepo, scopeName: string): string {
  const password = decryptSecret(repo.password) ?? "";
  const url = repoUrl(dest, repo.scope);
  return [
    "DeployNow backup recovery kit",
    "=============================",
    "",
    `Repository for: ${scopeName}`,
    `Destination:    ${dest.name} (${dest.provider})`,
    `Repository:     ${url}`,
    `Password:       ${password}`,
    `Access key id:  ${dest.accessKeyId}`,
    "Secret key:     (not included; keep it in your password manager)",
    "",
    "Keep this offline. Without the password the backups can't be read, and DeployNow",
    "can't show it again.",
    "",
    "Restore without DeployNow (any machine with restic 0.17 or later):",
    "",
    `  export RESTIC_REPOSITORY='${url}'`,
    `  export RESTIC_PASSWORD='${password}'`,
    `  export AWS_ACCESS_KEY_ID='${dest.accessKeyId}'`,
    "  export AWS_SECRET_ACCESS_KEY='<secret key>'",
    "  restic snapshots",
    "  restic restore <snapshot id> --target ./restore",
    "",
    "Snapshots are tagged dn-source=<what>: volume:<name>, bind:<path>, db:<container> or",
    "instance. Database snapshots hold a dump file (dump.sql, dump.archive or dump.rdb).",
    "",
    `Created ${new Date().toISOString()}`,
  ].join("\n");
}
