/**
 * The backup engine: runs one BackupRun (backup, prune, check, drill or restore).
 *
 * Endpoint data (volumes, bind paths, database dumps) is read by a restic helper
 * container on that endpoint, so nothing is copied through DeployNow. DeployNow's
 * own data is backed up with the local restic binary.
 *
 * Snapshots carry tags: dn-policy=<policy id>, dn-source=<source key> and, for
 * app volumes, dn-app=<application id>. Retention (forget) and prune run as a
 * separate job with the destination's delete-capable key, so the key used for
 * backups can be write-only.
 */
import fs from "fs";
import path from "path";
import type Docker from "dockerode";
import type { BackupDestination, BackupPolicy, BackupRepo, BackupRun, Endpoint } from "@prisma/client";
import { prisma } from "../prisma";
import { dataDir } from "../paths";
import { dockerFor } from "../endpoints";
import { notify } from "../notify";
import { audit } from "../audit";
import {
  FORBIDDEN_BINDS,
  RESTIC_IMAGE,
  type DbEngine,
  type Source,
  BackupConfigError,
  parseHook,
  parseSources,
  resticEnv,
  resticOptions,
  snapshotPath,
  sourceKey,
} from "./config";
import { execIn, runHelper } from "./helper";
import { containerRestic, ensureRepo, jsonSummary, lastError, listSnapshots, localRestic, tagValue, type ResticRunner, type Snapshot } from "./restic";

const MAX_LOG = 200_000;

type RunWith = BackupRun & { policy: (BackupPolicy & { endpoint: Endpoint | null; destination: BackupDestination }) | null };

export interface RestoreParams {
  snapshotId: string;
  /** same: back where it came from; volume: a (new) volume; path: a host path; container: a database container */
  target: "same" | "volume" | "path" | "container";
  endpointId?: string;
  name?: string;
  overwrite?: boolean;
}

class RunLog {
  private text = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private runId: string) {}
  line = (l: string) => {
    const clean = l.replace(/\u001b\[[0-9;]*m/g, "");
    // restic --json progress lines are noise in the log
    if (clean.startsWith('{"message_type":"status"')) return;
    this.text += `[${new Date().toISOString().slice(11, 19)}] ${clean}\n`;
    if (this.text.length > MAX_LOG) this.text = "…\n" + this.text.slice(-MAX_LOG);
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), 2000);
  };
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await prisma.backupRun.update({ where: { id: this.runId }, data: { log: this.text } }).catch(() => {});
  }
  get value() {
    return this.text;
  }
}

function hostName(endpoint: Endpoint | null) {
  return (endpoint ? endpoint.name : "deploynow").replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60) || "endpoint";
}

async function loadRepo(run: BackupRun) {
  const repo = await prisma.backupRepo.findUniqueOrThrow({ where: { id: run.repoId }, include: { destination: true } });
  const endpoint = repo.scope === "instance" ? null : await prisma.endpoint.findUnique({ where: { id: repo.scope } });
  if (repo.scope !== "instance" && !endpoint) throw new BackupConfigError("The endpoint for this repository was removed");
  return { repo, dest: repo.destination, endpoint };
}

function runnerFor(endpoint: Endpoint | null, dest: BackupDestination, repo: BackupRepo, prune = false): ResticRunner {
  const env = resticEnv(dest, repo, { prune });
  const opts = resticOptions(dest);
  const base = endpoint ? containerRestic(dockerFor(endpoint), env) : localRestic(env);
  // restic's global options (-o s3.region=…) go first
  return { local: base.local, run: (args, o) => base.run(o?.shell ? [] : [...opts, ...args], o) };
}

// ─── Database dumps ────────────────────────────────────────────────────────────

const DUMP_SCRIPTS: Record<DbEngine, string> = {
  postgres:
    'set -e; export PGPASSWORD="${POSTGRES_PASSWORD:-}"; U="${POSTGRES_USER:-postgres}"; ' +
    'if [ -n "$DN_DB" ]; then pg_dump -h 127.0.0.1 -U "$U" --clean --if-exists -d "$DN_DB" > /dump/dump.sql; ' +
    'else pg_dumpall -h 127.0.0.1 -U "$U" --clean --if-exists > /dump/dump.sql; fi',
  mysql:
    'set -e; P="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; D="$(command -v mariadb-dump || command -v mysqldump)"; ' +
    'if [ -n "$DN_DB" ]; then T="--databases $DN_DB"; else T="--all-databases"; fi; ' +
    '"$D" -h 127.0.0.1 -uroot ${P:+"-p$P"} --single-transaction --routines --events $T > /dump/dump.sql',
  mongo:
    'set -e; A=""; if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then A="--username=$MONGO_INITDB_ROOT_USERNAME --password=$MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase=admin"; fi; ' +
    'mongodump --host=127.0.0.1 $A ${DN_DB:+--db=$DN_DB} --archive=/dump/dump.archive --gzip',
  redis: 'set -e; redis-cli -h 127.0.0.1 ${REDIS_PASSWORD:+-a "$REDIS_PASSWORD"} --no-auth-warning --rdb /dump/dump.rdb',
};

const RESTORE_SCRIPTS: Partial<Record<DbEngine, string>> = {
  postgres:
    'set -e; export PGPASSWORD="${POSTGRES_PASSWORD:-}"; U="${POSTGRES_USER:-postgres}"; ' +
    'psql -h 127.0.0.1 -U "$U" -d "${DN_DB:-postgres}" -v ON_ERROR_STOP=0 -q -f /dump/dump.sql',
  mysql:
    'set -e; P="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; M="$(command -v mariadb || command -v mysql)"; ' +
    '"$M" -h 127.0.0.1 -uroot ${P:+"-p$P"} < /dump/dump.sql',
  mongo:
    'set -e; A=""; if [ -n "$MONGO_INITDB_ROOT_USERNAME" ]; then A="--username=$MONGO_INITDB_ROOT_USERNAME --password=$MONGO_INITDB_ROOT_PASSWORD --authenticationDatabase=admin"; fi; ' +
    'mongorestore --host=127.0.0.1 $A --drop --archive=/dump/dump.archive --gzip',
};

/** Run a script in a sidecar from the database container's own image, sharing its network, with /dump mounted. */
async function dbSidecar(docker: Docker, container: string, script: string, dumpVolume: string, database: string | undefined, log: (l: string) => void) {
  const info = await docker.getContainer(container).inspect().catch(() => null);
  if (!info) throw new Error(`Container ${container} not found`);
  if (!info.State.Running) throw new Error(`Container ${container} is not running`);
  const env: Record<string, string> = {};
  for (const kv of info.Config.Env ?? []) {
    const i = kv.indexOf("=");
    if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  if (database) env.DN_DB = database;
  const res = await runHelper(docker, {
    image: info.Config.Image,
    entrypoint: ["sh", "-c"],
    cmd: [script],
    env,
    user: "0:0",
    networkMode: `container:${info.Id}`,
    binds: [`${dumpVolume}:/dump`],
    timeoutMs: 6 * 3600_000,
    onLine: (l) => log(l),
  });
  if (res.code !== 0) throw new Error(`The database command failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`);
}

// ─── Backup ────────────────────────────────────────────────────────────────────

interface Expanded {
  source: Source;
  key: string;
  appId?: string;
}

/** Turn app sources into the volumes their containers use. */
async function expandSources(docker: Docker | null, sources: Source[], log: (l: string) => void): Promise<Expanded[]> {
  const out: Expanded[] = [];
  for (const s of sources) {
    if (s.type !== "app") {
      out.push({ source: s, key: sourceKey(s) });
      continue;
    }
    if (!docker) continue;
    const containers = await docker.listContainers({ all: true, filters: { label: [`deploynow.app=${s.applicationId}`] } });
    const vols = new Set<string>();
    for (const c of containers) for (const m of c.Mounts ?? []) if (m.Type === "volume" && m.Name) vols.add(m.Name);
    if (vols.size === 0) log(`App ${s.applicationId} has no volumes to back up`);
    for (const name of vols) {
      const v: Source = { type: "volume", name };
      if (!out.some((o) => o.key === sourceKey(v))) out.push({ source: v, key: sourceKey(v), appId: s.applicationId });
    }
  }
  return out;
}

/** Running containers that use any of the volumes or bind paths. */
async function containersUsing(docker: Docker, sources: Source[]): Promise<string[]> {
  const ids = new Set<string>();
  const running = await docker.listContainers({ filters: { status: ["running"] } });
  for (const c of running) {
    if (c.Labels?.["deploynow.helper"]) continue;
    for (const m of c.Mounts ?? []) {
      for (const s of sources) {
        if (s.type === "volume" && m.Type === "volume" && m.Name === s.name) ids.add(c.Id);
        if (s.type === "bind" && m.Type === "bind" && (m.Source === s.path || m.Source.startsWith(s.path + "/"))) ids.add(c.Id);
      }
    }
  }
  return [...ids];
}

async function stageInstance(log: (l: string) => void): Promise<string> {
  const dir = path.join(dataDir(), "backup-staging", "instance");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A consistent copy of the live SQLite database
  const dbFile = path.join(dir, "deployer.db");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
  log(`Copied the database (${fs.statSync(dbFile).size} bytes)`);
  const certs = path.join(dataDir(), "certs");
  if (fs.existsSync(certs)) fs.cpSync(certs, path.join(dir, "certs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "RESTORE.txt"),
    "Stop DeployNow, replace /data/deployer.db (and /data/certs) with these files, delete /data/deployer.db-wal and /data/deployer.db-shm if they exist, keep the same AUTH_SECRET, then start it again.\n",
  );
  return dir;
}

async function backupOne(r: ResticRunner, item: Expanded, tags: string[], host: string, docker: Docker | null, runId: string, log: (l: string) => void) {
  const s = item.source;
  const allTags = [...tags, `dn-source=${item.key}`, ...(item.appId ? [`dn-app=${item.appId}`] : []), ...(s.type === "db" ? [`dn-engine=${s.engine}`] : [])];
  const tagArgs = allTags.flatMap((t) => ["--tag", t]);
  let binds: string[] = [];
  let target: string;
  let dumpVolume: string | null = null;
  try {
    if (s.type === "instance") {
      target = await stageInstance(log);
    } else if (s.type === "volume") {
      if (docker) await docker.getVolume(s.name).inspect().catch(() => { throw new Error(`Volume ${s.name} not found`); });
      target = snapshotPath(s);
      binds = [`${s.name}:${target}:ro`];
    } else if (s.type === "bind") {
      target = snapshotPath(s);
      binds = [`${s.path}:${target}:ro`];
    } else if (s.type === "db") {
      if (!docker) throw new Error("No endpoint");
      dumpVolume = `deploynow-dump-${runId}-${s.container}`.slice(0, 120);
      await docker.createVolume({ Name: dumpVolume, Labels: { "deploynow.helper": "true" } });
      log(`Dumping ${s.engine} in ${s.container}${s.database ? ` (database ${s.database})` : ""}`);
      await dbSidecar(docker, s.container, s.command ? `set -e; ${s.command}` : DUMP_SCRIPTS[s.engine], dumpVolume, s.database, log);
      target = snapshotPath(s);
      binds = [`${dumpVolume}:${target}:ro`];
    } else {
      throw new Error("Unsupported source");
    }
    log(`Backing up ${item.key}`);
    const res = await r.run(["backup", "--json", "--host", host, ...tagArgs, target], { binds, onLine: (l) => (l.startsWith("{") ? undefined : log(l)) });
    const summary = jsonSummary<{ snapshot_id?: string; data_added?: number; total_files_processed?: number; total_bytes_processed?: number }>(res.stdout);
    // 3: some files could not be read; the snapshot exists but is incomplete
    if (res.code !== 0 && !(res.code === 3 && summary?.snapshot_id)) throw new Error(`restic backup failed: ${lastError(res)}`);
    if (res.code === 3) log("Warning: some files could not be read; see the log above");
    if (!summary?.snapshot_id) throw new Error("restic did not report a snapshot");
    log(`Snapshot ${summary.snapshot_id.slice(0, 8)}: ${summary.total_files_processed ?? 0} files, ${summary.total_bytes_processed ?? 0} bytes, ${summary.data_added ?? 0} new`);
    return { source: item.key, id: summary.snapshot_id, added: summary.data_added ?? 0 };
  } finally {
    if (dumpVolume && docker) await docker.getVolume(dumpVolume).remove({ force: true }).catch(() => {});
  }
}

async function runBackup(run: RunWith, log: RunLog) {
  const policy = run.policy;
  if (!policy) throw new BackupConfigError("The policy was removed");
  const { repo, dest, endpoint } = await loadRepo(run);
  const docker = endpoint ? dockerFor(endpoint) : null;
  const r = runnerFor(endpoint, dest, repo);
  if (await ensureRepo(r, log.line)) await prisma.backupRepo.update({ where: { id: repo.id }, data: { initializedAt: new Date() } });
  else if (!repo.initializedAt) await prisma.backupRepo.update({ where: { id: repo.id }, data: { initializedAt: new Date() } });

  const items = await expandSources(docker, parseSources(policy.sources), log.line);
  if (items.length === 0) throw new BackupConfigError("Nothing to back up");
  const pre = parseHook(policy.preHook);
  const post = parseHook(policy.postHook);
  const stopped: string[] = [];
  const results: { source: string; id: string; added: number }[] = [];
  const errors: string[] = [];
  try {
    if (pre && docker) {
      log.line(`Pre hook in ${pre.container}: ${pre.command}`);
      const h = await execIn(docker, pre.container, pre.command, { onLine: log.line, timeoutMs: 3600_000 });
      if (h.code !== 0) throw new Error(`The pre hook failed with exit code ${h.code}`);
    }
    if (policy.mode === "stop" && docker) {
      const ids = await containersUsing(docker, items.map((i) => i.source).filter((s) => s.type === "volume" || s.type === "bind"));
      for (const id of ids) {
        log.line(`Stopping ${id.slice(0, 12)} for a consistent copy`);
        await docker.getContainer(id).stop({ t: 30 }).catch((e) => log.line(`Could not stop ${id.slice(0, 12)}: ${e.message}`));
        stopped.push(id);
      }
    }
    const tags = [`dn-policy=${policy.id}`];
    for (const item of items) {
      try {
        results.push(await backupOne(r, item, tags, hostName(endpoint), docker, run.id, log.line));
      } catch (err) {
        const msg = `${item.key}: ${err instanceof Error ? err.message : String(err)}`;
        log.line(`Error: ${msg}`);
        errors.push(msg);
      }
      await prisma.backupRun.update({ where: { id: run.id }, data: { snapshots: JSON.stringify(results) } }).catch(() => {});
    }
  } finally {
    for (const id of stopped.reverse()) {
      log.line(`Starting ${id.slice(0, 12)} again`);
      await docker!.getContainer(id).start().catch((e) => log.line(`Could not start ${id.slice(0, 12)}: ${e.message}`));
    }
    if (post && docker) {
      log.line(`Post hook in ${post.container}: ${post.command}`);
      const h = await execIn(docker, post.container, post.command, { onLine: log.line }).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      if (h.code !== 0) errors.push(`The post hook failed with exit code ${h.code}`);
    }
  }
  const bytes = results.reduce((a, b) => a + b.added, 0);
  await prisma.backupRun.update({ where: { id: run.id }, data: { snapshots: JSON.stringify(results), bytes } });
  if (errors.length) throw new Error(errors.join("; "));
}

// ─── Retention, check ──────────────────────────────────────────────────────────

async function runPrune(run: RunWith, log: RunLog) {
  const policy = run.policy;
  if (!policy) throw new BackupConfigError("The policy was removed");
  const { repo, dest, endpoint } = await loadRepo(run);
  const r = runnerFor(endpoint, dest, repo, true);
  log.line(`Applying retention: ${policy.keepDaily} daily, ${policy.keepWeekly} weekly, ${policy.keepMonthly} monthly`);
  const forget = await r.run(
    ["forget", "--tag", `dn-policy=${policy.id}`, "--group-by", "tags", "--keep-daily", String(policy.keepDaily), "--keep-weekly", String(policy.keepWeekly), "--keep-monthly", String(policy.keepMonthly), "--keep-last", "1"],
    { onLine: log.line },
  );
  if (forget.code !== 0) throw new Error(`restic forget failed: ${lastError(forget)}${dest.pruneKeyId ? "" : " (the destination has no prune key; the backup key may not be allowed to delete)"}`);
  const prune = await r.run(["prune", "--max-unused", "10%"], { onLine: log.line });
  if (prune.code !== 0) {
    const hint = dest.objectLock ? " Objects still under Object Lock can't be deleted yet; they go once the lock expires." : "";
    throw new Error(`restic prune failed: ${lastError(prune)}.${hint}`);
  }
}

async function runCheck(run: RunWith, log: RunLog) {
  const { repo, dest, endpoint } = await loadRepo(run);
  const r = runnerFor(endpoint, dest, repo, true);
  log.line("Checking the repository and reading back 5% of the data");
  const res = await r.run(["check", "--read-data-subset=5%"], { onLine: log.line, timeoutMs: 12 * 3600_000 });
  const ok = res.code === 0;
  await prisma.backupRepo.update({ where: { id: repo.id }, data: { lastCheckAt: new Date(), lastCheckOk: ok } });
  if (!ok) throw new Error(`restic check found problems: ${lastError(res)}`);
}

// ─── Restore and drill ─────────────────────────────────────────────────────────

function parseSourceKey(key: string, snap: Snapshot): Source {
  if (key.startsWith("volume:")) return { type: "volume", name: key.slice(7) };
  if (key.startsWith("bind:")) return { type: "bind", path: key.slice(5) };
  if (key === "instance") return { type: "instance" };
  if (key.startsWith("db:")) {
    const [container, database] = key.slice(3).split("/");
    const engine = (tagValue(snap, "dn-engine") || "postgres") as DbEngine;
    return { type: "db", engine, container, ...(database ? { database } : {}) };
  }
  throw new BackupConfigError(`Unknown snapshot source ${key}`);
}

interface RestoreSummary {
  total_files?: number;
  files_restored?: number;
  total_bytes?: number;
  bytes_restored?: number;
}

/** restic restore of one snapshot's source path into whatever is mounted at /restore. */
async function resticRestore(r: ResticRunner, snap: Snapshot, bind: string | null, localTarget: string | null, del: boolean, log: (l: string) => void): Promise<RestoreSummary> {
  const src = snap.paths[0];
  const target = localTarget ?? "/restore";
  const res = await r.run(["restore", `${snap.id}:${src}`, "--target", target, "--json", ...(del ? ["--delete"] : [])], {
    binds: bind ? [`${bind}:/restore`] : [],
    onLine: (l) => (l.startsWith("{") ? undefined : log(l)),
  });
  if (res.code !== 0) throw new Error(`restic restore failed: ${lastError(res)}`);
  const s = jsonSummary<RestoreSummary>(res.stdout) ?? {};
  log(`Restored ${s.files_restored ?? "?"} of ${s.total_files ?? "?"} files (${s.bytes_restored ?? "?"} bytes)`);
  return s;
}

async function findSnapshot(r: ResticRunner, id: string): Promise<Snapshot> {
  if (!/^[0-9a-f]{8,64}$/.test(id)) throw new BackupConfigError("Invalid snapshot id");
  const snaps = await listSnapshots(r);
  const snap = snaps.find((s) => s.id === id || s.id.startsWith(id) || s.short_id === id);
  if (!snap) throw new BackupConfigError("Snapshot not found");
  return snap;
}

async function runRestore(run: RunWith, log: RunLog) {
  const params = JSON.parse(run.params || "{}") as RestoreParams;
  const { repo, dest, endpoint } = await loadRepo(run);
  const r = runnerFor(endpoint, dest, repo);
  const snap = await findSnapshot(r, params.snapshotId);
  const key = tagValue(snap, "dn-source");
  const source = parseSourceKey(key, snap);
  if (source.type === "instance") {
    throw new BackupConfigError("DeployNow's own data is restored offline with the recovery kit (see docs/backups.md)");
  }
  // The target endpoint (another endpoint reads the same repository)
  let targetEndpoint = endpoint!;
  if (params.endpointId && params.endpointId !== endpoint!.id) {
    const other = await prisma.endpoint.findUnique({ where: { id: params.endpointId } });
    if (!other) throw new BackupConfigError("Target endpoint not found");
    targetEndpoint = other;
  }
  const docker = dockerFor(targetEndpoint);
  const tr = runnerFor(targetEndpoint, dest, repo);
  log.line(`Restoring snapshot ${snap.short_id} (${key}, ${snap.time}) to ${targetEndpoint.name}`);

  if (source.type === "volume") {
    const name = params.target === "same" ? source.name : String(params.name ?? "").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(name)) throw new BackupConfigError("Give the volume a valid name");
    const exists = await docker.getVolume(name).inspect().then(() => true, () => false);
    if (exists && params.target !== "same" && !params.overwrite) throw new BackupConfigError(`Volume ${name} already exists; tick overwrite to restore into it`);
    if (!exists) await docker.createVolume({ Name: name, Labels: { "deploynow.restored-from": snap.short_id } });
    const stopped = exists ? await containersUsing(docker, [{ type: "volume", name }]) : [];
    try {
      for (const id of stopped) {
        log.line(`Stopping ${id.slice(0, 12)} while its volume is restored`);
        await docker.getContainer(id).stop({ t: 30 }).catch(() => {});
      }
      await resticRestore(tr, snap, name, null, exists, log.line);
    } finally {
      for (const id of stopped) await docker.getContainer(id).start().catch((e) => log.line(`Could not start ${id.slice(0, 12)}: ${e.message}`));
    }
    return;
  }
  if (source.type === "bind") {
    const p = params.target === "same" ? source.path : String(params.name ?? "").trim().replace(/\/+$/, "");
    if (!/^\/[a-zA-Z0-9_.@/ +-]+$/.test(p) || p.split("/").includes("..")) throw new BackupConfigError("Give an absolute path to restore to");
    if (FORBIDDEN_BINDS.includes(p)) throw new BackupConfigError(`Restoring into ${p} isn't allowed`);
    const stopped = await containersUsing(docker, [{ type: "bind", path: p }]);
    try {
      for (const id of stopped) await docker.getContainer(id).stop({ t: 30 }).catch(() => {});
      await resticRestore(tr, snap, p, null, params.target === "same" || !!params.overwrite, log.line);
    } finally {
      for (const id of stopped) await docker.getContainer(id).start().catch(() => {});
    }
    return;
  }
  if (source.type === "db") {
    const engine = (tagValue(snap, "dn-engine") || source.engine) as DbEngine;
    const script = RESTORE_SCRIPTS[engine];
    const container = params.target === "same" || !params.name ? source.container : String(params.name).trim();
    const scratch = `deploynow-restore-${run.id}`.slice(0, 120);
    await docker.createVolume({ Name: scratch, Labels: { "deploynow.helper": "true" } });
    try {
      await resticRestore(tr, snap, scratch, null, false, log.line);
      if (!script) {
        throw new BackupConfigError("Redis is restored as a file: restore the snapshot to a volume, then replace dump.rdb while Redis is stopped");
      }
      log.line(`Loading the dump into ${container}`);
      await dbSidecar(docker, container, script, scratch, source.database, log.line);
    } finally {
      await docker.getVolume(scratch).remove({ force: true }).catch(() => {});
    }
  }
}

/** Restore the latest snapshot of every source to scratch space and check it came back whole. */
async function runDrill(run: RunWith, log: RunLog) {
  const { repo, dest, endpoint } = await loadRepo(run);
  const r = runnerFor(endpoint, dest, repo);
  const snaps = await listSnapshots(r);
  const latest = new Map<string, Snapshot>();
  for (const s of snaps) {
    const key = tagValue(s, "dn-source");
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || prev.time < s.time) latest.set(key, s);
  }
  if (latest.size === 0) throw new Error("There are no snapshots to test yet");
  const problems: string[] = [];
  const docker = endpoint ? dockerFor(endpoint) : null;
  for (const [key, snap] of latest) {
    log.line(`Drill: restoring ${key} from ${snap.short_id} (${snap.time})`);
    const expectFiles = snap.summary?.total_files_processed;
    try {
      let summary: RestoreSummary;
      let checkOut = "";
      if (docker) {
        const scratch = `deploynow-drill-${run.id}-${latest.size > 1 ? [...latest.keys()].indexOf(key) : 0}`;
        await docker.createVolume({ Name: scratch, Labels: { "deploynow.helper": "true" } });
        try {
          summary = await resticRestore(r, snap, scratch, null, false, log.line);
          // Count what landed on disk, and the size of a database dump
          const res = await runHelper(docker, {
            image: RESTIC_IMAGE,
            entrypoint: ["sh", "-c"],
            cmd: ['echo "files=$(find /restore -type f | wc -l)"; for f in /restore/dump.*; do [ -f "$f" ] && echo "dump=$(wc -c < "$f")"; done; true'],
            binds: [`${scratch}:/restore:ro`],
          });
          checkOut = res.stdout;
        } finally {
          await docker.getVolume(scratch).remove({ force: true }).catch(() => {});
        }
      } else {
        const dir = path.join(dataDir(), "backup-staging", `drill-${run.id}`);
        fs.mkdirSync(dir, { recursive: true });
        try {
          summary = await resticRestore(r, snap, null, dir, false, log.line);
          const files = fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, String(f))).isFile());
          checkOut = `files=${files.length}\n`;
          const db = path.join(dir, "deployer.db");
          const header = fs.existsSync(db) ? fs.readFileSync(db).subarray(0, 16).toString("latin1") : "";
          if (!header.startsWith("SQLite format 3")) throw new Error("The restored database is not a valid SQLite file");
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
      const onDisk = Number(/files=(\d+)/.exec(checkOut)?.[1] ?? -1);
      const dump = /dump=(\d+)/.exec(checkOut);
      if (summary.total_files !== undefined && summary.files_restored !== undefined && summary.files_restored < summary.total_files) {
        throw new Error(`only ${summary.files_restored} of ${summary.total_files} files were restored`);
      }
      if (expectFiles !== undefined && onDisk >= 0 && onDisk < expectFiles) throw new Error(`${onDisk} files on disk, the snapshot has ${expectFiles}`);
      if (key.startsWith("db:") && (!dump || Number(dump[1]) === 0)) throw new Error("the database dump is missing or empty");
      log.line(`Drill: ${key} OK (${onDisk} files${dump ? `, dump ${dump[1]} bytes` : ""})`);
    } catch (err) {
      const msg = `${key}: ${err instanceof Error ? err.message : String(err)}`;
      log.line(`Drill failed: ${msg}`);
      problems.push(msg);
    }
  }
  await prisma.backupRepo.update({ where: { id: repo.id }, data: { lastDrillAt: new Date(), lastDrillOk: problems.length === 0 } });
  if (problems.length) throw new Error(problems.join("; "));
}

// ─── Entry point ───────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = { backup: "Backup", prune: "Retention and prune", check: "Repository check", drill: "Restore drill", restore: "Restore" };

/** Run one queued BackupRun to completion. Never throws. */
export async function executeRun(runId: string): Promise<BackupRun> {
  const run = (await prisma.backupRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: new Date() },
    include: { policy: { include: { endpoint: true, destination: true } } },
  })) as RunWith;
  const log = new RunLog(run.id);
  let error = "";
  try {
    if (run.kind === "backup") await runBackup(run, log);
    else if (run.kind === "prune") await runPrune(run, log);
    else if (run.kind === "check") await runCheck(run, log);
    else if (run.kind === "drill") await runDrill(run, log);
    else if (run.kind === "restore") await runRestore(run, log);
    else throw new Error(`Unknown run kind ${run.kind}`);
    log.line(`${KIND_LABEL[run.kind] ?? run.kind} finished`);
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    log.line(`Failed: ${error}`);
  }
  await log.flush();
  const ok = !error;
  const finished = await prisma.backupRun.update({
    where: { id: run.id },
    data: { status: ok ? "success" : "failed", error, finishedAt: new Date(), log: log.value },
  });
  if (run.policy && run.kind === "backup") {
    await prisma.backupPolicy.update({ where: { id: run.policy.id }, data: { lastRunAt: new Date(), lastStatus: ok ? "success" : "failed" } }).catch(() => {});
  }
  await report(finished, run).catch(() => {});
  return finished;
}

async function report(finished: BackupRun, run: RunWith) {
  const ok = finished.status === "success";
  const repo = await prisma.backupRepo.findUnique({ where: { id: run.repoId }, include: { destination: true } });
  const ep = repo && repo.scope !== "instance" ? await prisma.endpoint.findUnique({ where: { id: repo.scope } }) : null;
  const where = ep ? ep.name : "DeployNow";
  const what = run.policy ? `${run.policy.name} on ${where}` : where;
  const label = KIND_LABEL[run.kind] ?? run.kind;
  await audit({
    actor: run.actorEmail ? { id: "", email: run.actorEmail } : null,
    action: `backup.${run.kind}`,
    targetType: "backup",
    targetId: run.policyId ?? run.repoId,
    endpointId: ep?.id,
    outcome: ok ? "success" : "failure",
    message: `${label} of ${what} ${ok ? "succeeded" : "failed"}`,
    details: ok ? "" : finished.error,
  });
  // Successful prunes and checks are routine; everything else is worth a message
  if (ok && (run.kind === "prune" || run.kind === "check" || run.kind === "drill")) return;
  const event = run.kind === "restore" ? (ok ? "restore.success" : "restore.failure") : ok ? "backup.success" : "backup.failure";
  await notify({
    event,
    ok,
    title: `${label} of ${what} ${ok ? "succeeded" : "failed"}`,
    text: ok ? "" : finished.error,
    fields: { Destination: repo?.destination.name ?? "", Trigger: run.trigger },
  });
}
