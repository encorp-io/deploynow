/** What the backup API returns, and the actions it takes. */
import type { BackupDestination, BackupPolicy, BackupRepo, BackupRun } from "@prisma/client";
import { prisma } from "../prisma";
import { dockerFor } from "../endpoints";
import { encryptSecret } from "../secretsCrypto";
import {
  BackupConfigError,
  MASK,
  MODES,
  nextRun,
  parseHook,
  parseSources,
  recoveryKit,
  repoUrl,
  resticEnv,
  resticOptions,
  validateDestination,
  validateHook,
  validateRetention,
  validateSources,
} from "./config";
import { containerRestic, lastError, listSnapshots, localRestic, tagValue } from "./restic";
import { getOrCreateRepo } from "./worker";

export function serializeDestination(d: BackupDestination) {
  return {
    id: d.id,
    name: d.name,
    provider: d.provider,
    endpointUrl: d.endpointUrl,
    bucket: d.bucket,
    prefix: d.prefix,
    region: d.region,
    accessKeyId: d.accessKeyId,
    secretKey: d.secretKey ? MASK : "",
    pruneKeyId: d.pruneKeyId,
    pruneSecretKey: d.pruneSecretKey ? MASK : "",
    objectLock: d.objectLock,
    createdAt: d.createdAt,
  };
}

export function serializePolicy(p: BackupPolicy & { endpoint?: { name: string } | null; destination?: { name: string } }) {
  return {
    id: p.id,
    name: p.name,
    endpointId: p.endpointId,
    endpointName: p.endpointId ? (p.endpoint?.name ?? "") : "DeployNow",
    destinationId: p.destinationId,
    destinationName: p.destination?.name ?? "",
    sources: parseSources(p.sources),
    mode: p.mode,
    preHook: parseHook(p.preHook),
    postHook: parseHook(p.postHook),
    schedule: p.schedule,
    keepDaily: p.keepDaily,
    keepWeekly: p.keepWeekly,
    keepMonthly: p.keepMonthly,
    enabled: p.enabled,
    nextRunAt: p.nextRunAt,
    lastRunAt: p.lastRunAt,
    lastStatus: p.lastStatus,
  };
}

export function serializeRun(r: BackupRun, withLog = false) {
  return {
    id: r.id,
    policyId: r.policyId,
    repoId: r.repoId,
    kind: r.kind,
    status: r.status,
    trigger: r.trigger,
    params: r.params ? JSON.parse(r.params) : null,
    snapshots: r.snapshots ? JSON.parse(r.snapshots) : [],
    bytes: r.bytes,
    error: r.error,
    actorEmail: r.actorEmail,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    createdAt: r.createdAt,
    ...(withLog ? { log: r.log } : {}),
  };
}

export async function serializeRepo(r: BackupRepo & { destination: BackupDestination }) {
  const ep = r.scope === "instance" ? null : await prisma.endpoint.findUnique({ where: { id: r.scope }, select: { name: true } });
  return {
    id: r.id,
    scope: r.scope,
    scopeName: r.scope === "instance" ? "DeployNow" : (ep?.name ?? "(removed endpoint)"),
    destinationId: r.destinationId,
    destinationName: r.destination.name,
    url: repoUrl(r.destination, r.scope),
    initializedAt: r.initializedAt,
    kitAvailable: !r.kitShownAt,
    lastCheckAt: r.lastCheckAt,
    lastCheckOk: r.lastCheckOk,
    lastDrillAt: r.lastDrillAt,
    lastDrillOk: r.lastDrillOk,
  };
}

// ─── Destinations ──────────────────────────────────────────────────────────────

export async function saveDestination(raw: Record<string, unknown>, existing?: BackupDestination) {
  const v = validateDestination(raw, existing);
  const data = {
    name: v.name,
    provider: v.provider,
    endpointUrl: v.endpointUrl,
    bucket: v.bucket,
    prefix: v.prefix,
    region: v.region,
    accessKeyId: v.accessKeyId,
    pruneKeyId: v.pruneKeyId,
    objectLock: v.objectLock,
    ...(v.secret ? { secretKey: encryptSecret(v.secret) } : {}),
    ...(v.pruneSecret ? { pruneSecretKey: encryptSecret(v.pruneSecret) } : !v.pruneKeyId ? { pruneSecretKey: "" } : {}),
  };
  if (existing) {
    const moved = existing.endpointUrl !== v.endpointUrl || existing.bucket !== v.bucket || existing.prefix !== v.prefix;
    if (moved && (await prisma.backupRepo.count({ where: { destinationId: existing.id, initializedAt: { not: null } } }))) {
      throw new BackupConfigError("This destination already holds backups; its endpoint, bucket and folder can't change. Add a new destination instead.");
    }
    return prisma.backupDestination.update({ where: { id: existing.id }, data });
  }
  return prisma.backupDestination.create({ data: { ...data, secretKey: encryptSecret(v.secret!) } });
}

/** Check the credentials reach the bucket (restic reports "no repository" when they do). */
export async function testDestination(d: BackupDestination): Promise<{ ok: boolean; message: string }> {
  const fake = { id: "", destinationId: d.id, scope: "connection-test", password: encryptSecret("connection-test") } as BackupRepo;
  const env = resticEnv(d, fake);
  const local = localRestic(env);
  let res;
  try {
    res = await local.run([...resticOptions(d), "cat", "config", "--quiet", "--no-lock"], { timeoutMs: 30_000 });
  } catch (err) {
    // No local restic (development): try through the first local socket endpoint
    const ep = await prisma.endpoint.findFirst({ where: { type: "socket", status: "online" } });
    if (!ep) return { ok: false, message: err instanceof Error ? err.message : "restic is not available" };
    res = await containerRestic(dockerFor(ep), env).run([...resticOptions(d), "cat", "config", "--quiet", "--no-lock"], { timeoutMs: 60_000 });
  }
  if (res.code === 10 || /does not exist/i.test(res.stderr)) return { ok: true, message: "Connected: the bucket is reachable and the credentials work" };
  if (res.code === 0) return { ok: true, message: "Connected" };
  return { ok: false, message: lastError(res) };
}

// ─── Policies ──────────────────────────────────────────────────────────────────

export async function savePolicy(raw: Record<string, unknown>, existing?: BackupPolicy) {
  const name = String(raw.name ?? existing?.name ?? "").trim();
  if (!name || name.length > 80) throw new BackupConfigError("Give the policy a name");
  const endpointId = existing ? existing.endpointId : raw.endpointId ? String(raw.endpointId) : null;
  if (endpointId && !(await prisma.endpoint.findUnique({ where: { id: endpointId } }))) throw new BackupConfigError("Endpoint not found");
  const destinationId = String(raw.destinationId ?? existing?.destinationId ?? "");
  if (!(await prisma.backupDestination.findUnique({ where: { id: destinationId } }))) throw new BackupConfigError("Choose a destination");
  if (existing && destinationId !== existing.destinationId) throw new BackupConfigError("A policy's destination can't change; create a new policy");
  const sources = validateSources(raw.sources ?? parseSources(existing?.sources ?? "[]"), !endpointId);
  const mode = String(raw.mode ?? existing?.mode ?? "live");
  if (!(MODES as readonly string[]).includes(mode)) throw new BackupConfigError("Consistency must be stop, dump or live");
  const pre = raw.preHook !== undefined ? validateHook(raw.preHook) : parseHook(existing?.preHook ?? "");
  const post = raw.postHook !== undefined ? validateHook(raw.postHook) : parseHook(existing?.postHook ?? "");
  if (!endpointId && (pre || post)) throw new BackupConfigError("Hooks run in containers, so they don't apply to DeployNow's own backup");
  const schedule = String(raw.schedule ?? existing?.schedule ?? "0 3 * * *").trim();
  const next = nextRun(schedule);
  const retention = validateRetention({ keepDaily: raw.keepDaily ?? existing?.keepDaily, keepWeekly: raw.keepWeekly ?? existing?.keepWeekly, keepMonthly: raw.keepMonthly ?? existing?.keepMonthly });
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : (existing?.enabled ?? true);
  const data = {
    name,
    sources: JSON.stringify(sources),
    mode,
    preHook: pre ? JSON.stringify(pre) : "",
    postHook: post ? JSON.stringify(post) : "",
    schedule,
    ...retention,
    enabled,
    nextRunAt: enabled ? next : null,
  };
  const { repo, created } = await getOrCreateRepo(destinationId, endpointId ?? "instance");
  const policy = existing
    ? await prisma.backupPolicy.update({ where: { id: existing.id }, data, include: { endpoint: true, destination: true } })
    : await prisma.backupPolicy.create({ data: { ...data, endpointId, destinationId }, include: { endpoint: true, destination: true } });
  return { policy, repo, repoCreated: created };
}

/** The recovery kit, once. */
export async function takeKit(repoId: string): Promise<string> {
  const repo = await prisma.backupRepo.findUniqueOrThrow({ where: { id: repoId }, include: { destination: true } });
  const claimed = await prisma.backupRepo.updateMany({ where: { id: repoId, kitShownAt: null }, data: { kitShownAt: new Date() } });
  if (claimed.count !== 1) throw new BackupConfigError("The recovery kit was already shown and can't be shown again");
  const name = repo.scope === "instance" ? "DeployNow" : ((await prisma.endpoint.findUnique({ where: { id: repo.scope } }))?.name ?? repo.scope);
  return recoveryKit(repo.destination, repo, name);
}

export async function snapshotsFor(repoId: string) {
  const repo = await prisma.backupRepo.findUniqueOrThrow({ where: { id: repoId }, include: { destination: true } });
  if (!repo.initializedAt) return [];
  const env = resticEnv(repo.destination, repo);
  const ep = repo.scope === "instance" ? null : await prisma.endpoint.findUnique({ where: { id: repo.scope } });
  const base = ep ? containerRestic(dockerFor(ep), env) : localRestic(env);
  const r = { local: base.local, run: (args: string[], o?: Parameters<typeof base.run>[1]) => base.run([...resticOptions(repo.destination), "--no-lock", ...args], o) };
  const snaps = await listSnapshots(r);
  const policies = new Map((await prisma.backupPolicy.findMany({ select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  return snaps
    .map((s) => ({
      id: s.id,
      shortId: s.short_id,
      time: s.time,
      host: s.hostname,
      source: tagValue(s, "dn-source"),
      policyId: tagValue(s, "dn-policy"),
      policyName: policies.get(tagValue(s, "dn-policy")) ?? "",
      appId: tagValue(s, "dn-app"),
      files: s.summary?.total_files_processed ?? null,
      bytes: s.summary?.total_bytes_processed ?? null,
    }))
    .sort((a, b) => (a.time < b.time ? 1 : -1));
}
