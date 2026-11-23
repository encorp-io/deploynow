/**
 * Backups end to end: real Docker, real restic (helper container and local
 * binary), an in-memory S3 server and a real Postgres. Backs up a volume, a bind
 * path and a database dump, runs the restore drill (the phase 3 gate), restores
 * each kind of source, applies retention, checks the repository and backs up
 * DeployNow itself.
 *
 * Skipped when Go or the Docker daemon isn't available.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

const SOCKET = "/var/run/docker.sock";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-backup-it-"));
const PG_IMAGE = process.env.IT_PG_IMAGE || (process.env.CI ? "postgres:16-alpine" : "mirror.gcr.io/library/postgres:16-alpine");
const BUSYBOX = process.env.IT_BUSYBOX || (process.env.CI ? "busybox:1.37" : "mirror.gcr.io/library/busybox:1.37");
const RESTIC = "restic/restic:0.18.1";

function hasGo() {
  try {
    execSync("go version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
async function dockerUp() {
  if (!fs.existsSync(SOCKET)) return false;
  const Docker = (await import("dockerode")).default;
  try {
    await new Docker({ socketPath: SOCKET }).ping();
    return true;
  } catch {
    return false;
  }
}
const ready = hasGo() && (await dockerUp());

type DockerT = import("dockerode");
let docker: DockerT;
let prisma: typeof import("@/lib/prisma").prisma;
let worker: typeof import("@/lib/backup/worker");
let s3: ChildProcess | null = null;
let endpointId = "";
let destinationId = "";
const suffix = Math.random().toString(36).slice(2, 8);
const VOL = `dn-it-vol-${suffix}`;
const PG = `dn-it-pg-${suffix}`;
const BIND = path.join(dir, "bind-data");
const created = { volumes: [VOL] as string[], containers: [PG] as string[] };

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

async function pull(image: string) {
  try {
    await docker.getImage(image).inspect();
  } catch {
    const stream = await docker.pull(image);
    await new Promise((res, rej) => docker.modem.followProgress(stream, (e: Error | null) => (e ? rej(e) : res(null))));
  }
}

async function sh(image: string, cmd: string, binds: string[] = []): Promise<string> {
  const { runHelper } = await import("@/lib/backup/helper");
  const r = await runHelper(docker, { image, entrypoint: ["sh", "-c"], cmd: [cmd], binds });
  if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
  return r.stdout.trim();
}

async function psql(sql: string): Promise<string> {
  const { execIn } = await import("@/lib/backup/helper");
  const r = await execIn(docker, PG, `psql -U postgres -d app -tAc "${sql}"`);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

async function run(kind: string, repoId: string, extra: { policyId?: string; params?: unknown } = {}) {
  const r = await worker.enqueueRun({ kind, repoId, trigger: "manual", ...extra });
  await worker.drainBackups(240_000);
  return prisma.backupRun.findUniqueOrThrow({ where: { id: r.id } });
}

describe.skipIf(!ready)("backups (real Docker, restic, S3 and Postgres)", () => {
  let policyId = "";
  let repoId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = `file:${path.join(dir, "it.db")}`;
    process.env.DEPLOYNOW_DATA_DIR = dir;
    process.env.BACKUP_ALLOW_HTTP = "1";
    execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
    const Docker = (await import("dockerode")).default;
    docker = new Docker({ socketPath: SOCKET });
    await Promise.all([pull(PG_IMAGE), pull(BUSYBOX), pull(RESTIC)]);

    // Local S3, reachable from helper containers through the bridge gateway
    const s3Bin = path.join(dir, "fakes3");
    execSync(`go build -o ${s3Bin} .`, { cwd: path.join(process.cwd(), "tests/helpers/fakes3"), stdio: "ignore" });
    const port = await freePort();
    s3 = spawn(s3Bin, ["-addr", `0.0.0.0:${port}`], { stdio: "ignore" });
    const gateway = (await docker.getNetwork("bridge").inspect()).IPAM?.Config?.[0]?.Gateway ?? "172.17.0.1";

    // The local restic binary, for DeployNow's own data
    const c = await docker.createContainer({ Image: RESTIC });
    const tar = path.join(dir, "restic.tar");
    const stream = await c.getArchive({ path: "/usr/bin/restic" });
    await new Promise((res, rej) => stream.pipe(fs.createWriteStream(tar)).on("finish", res).on("error", rej));
    await c.remove();
    execSync(`tar -xf ${tar} -C ${dir}`);
    process.env.RESTIC_BIN = path.join(dir, "restic");

    // Data: a volume with files, a bind directory and a Postgres database
    await docker.createVolume({ Name: VOL });
    await sh(BUSYBOX, "mkdir -p /v/sub && echo hello > /v/a.txt && echo world > /v/sub/b.txt && head -c 200000 /dev/urandom > /v/blob.bin", [`${VOL}:/v`]);
    fs.mkdirSync(BIND, { recursive: true });
    fs.writeFileSync(path.join(BIND, "config.yml"), "answer: 42\n");
    const pg = await docker.createContainer({ name: PG, Image: PG_IMAGE, Env: ["POSTGRES_PASSWORD=secret", "POSTGRES_DB=app"] });
    await pg.start();
    const { execIn } = await import("@/lib/backup/helper");
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const r = await execIn(docker, PG, "pg_isready -U postgres -h 127.0.0.1 && psql -U postgres -d app -c 'select 1'");
      if (r.code === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await psql("create table notes(id int primary key, body text); insert into notes values (1,'first'),(2,'second')");

    ({ prisma } = await import("@/lib/prisma"));
    worker = await import("@/lib/backup/worker");
    const { encryptSecret } = await import("@/lib/secretsCrypto");
    endpointId = (await prisma.endpoint.create({ data: { name: "local-it", type: "socket", host: SOCKET, status: "online" } })).id;
    destinationId = (
      await prisma.backupDestination.create({
        data: { name: "it-s3", provider: "other", endpointUrl: `http://${gateway}:${port}`, bucket: "backups", prefix: "it", region: "us-east-1", accessKeyId: "AKIA", secretKey: encryptSecret("secret") },
      })
    ).id;
    const { repo } = await worker.getOrCreateRepo(destinationId, endpointId);
    repoId = repo.id;
    policyId = (
      await prisma.backupPolicy.create({
        data: {
          name: "everything",
          endpointId,
          destinationId,
          mode: "stop",
          sources: JSON.stringify([{ type: "volume", name: VOL }, { type: "bind", path: BIND }, { type: "db", engine: "postgres", container: PG, database: "app" }]),
        },
      })
    ).id;
  }, 300_000);

  afterAll(async () => {
    if (docker) {
      for (const c of created.containers) await docker.getContainer(c).remove({ force: true }).catch(() => {});
      for (const v of created.volumes) await docker.getVolume(v).remove({ force: true }).catch(() => {});
    }
    s3?.kill();
    if (prisma) await prisma.$disconnect();
    // Restores run as root in a helper container, so on CI the restored files aren't ours to delete
    try {
      execSync(`docker run --rm -v ${dir}:/d ${BUSYBOX} sh -c 'rm -rf /d/* /d/.[!.]*'`, { stdio: "ignore", timeout: 60_000 });
    } catch {
      /* fall through */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("backs up a volume, a bind path and a database dump", async () => {
    const r = await run("backup", repoId, { policyId });
    expect(r.error).toBe("");
    expect(r.status).toBe("success");
    const snaps = JSON.parse(r.snapshots) as { source: string; id: string }[];
    expect(snaps.map((s) => s.source).sort()).toEqual([`bind:${BIND}`, `db:${PG}/app`, `volume:${VOL}`].sort());
    const repo = await prisma.backupRepo.findUniqueOrThrow({ where: { id: repoId } });
    expect(repo.initializedAt).not.toBeNull();
    // stop mode: Postgres doesn't use the volume, so it kept running
    expect((await docker.getContainer(PG).inspect()).State.Running).toBe(true);
  }, 240_000);

  it("passes the restore drill", async () => {
    const r = await run("drill", repoId);
    expect(r.error).toBe("");
    expect(r.status).toBe("success");
    expect(r.log).toMatch(/Drill: volume:.* OK/);
    expect(r.log).toMatch(/Drill: db:.* OK .*dump \d+ bytes/);
    const repo = await prisma.backupRepo.findUniqueOrThrow({ where: { id: repoId } });
    expect(repo.lastDrillOk).toBe(true);
  }, 240_000);

  async function snapshotFor(prefix: string) {
    const r = await prisma.backupRun.findFirstOrThrow({ where: { kind: "backup", status: "success" }, orderBy: { createdAt: "desc" } });
    return (JSON.parse(r.snapshots) as { source: string; id: string }[]).find((s) => s.source.startsWith(prefix))!.id;
  }

  it("restores a volume into a new volume", async () => {
    const target = `${VOL}-copy`;
    created.volumes.push(target);
    const r = await run("restore", repoId, { params: { snapshotId: await snapshotFor("volume:"), target: "volume", name: target } });
    expect(r.error).toBe("");
    expect(await sh(BUSYBOX, "cat /v/a.txt /v/sub/b.txt && wc -c < /v/blob.bin", [`${target}:/v:ro`])).toBe("hello\nworld\n200000");
  }, 120_000);

  it("restores a volume in place, removing files that weren't in the snapshot", async () => {
    await sh(BUSYBOX, "rm /v/a.txt && echo stray > /v/new.txt", [`${VOL}:/v`]);
    const r = await run("restore", repoId, { params: { snapshotId: await snapshotFor("volume:"), target: "same" } });
    expect(r.error).toBe("");
    expect(await sh(BUSYBOX, "cat /v/a.txt; ls /v", [`${VOL}:/v:ro`])).toBe("hello\na.txt\nblob.bin\nsub");
  }, 120_000);

  it("restores a database dump into the running database", async () => {
    await psql("delete from notes where id = 2; insert into notes values (3,'later')");
    const r = await run("restore", repoId, { params: { snapshotId: await snapshotFor("db:"), target: "same" } });
    expect(r.error).toBe("");
    expect(await psql("select string_agg(body, ',' order by id) from notes")).toBe("first,second");
  }, 120_000);

  it("restores a bind path to another directory", async () => {
    const to = path.join(dir, "bind-restored");
    const r = await run("restore", repoId, { params: { snapshotId: await snapshotFor("bind:"), target: "path", name: to } });
    expect(r.error).toBe("");
    expect(fs.readFileSync(path.join(to, "config.yml"), "utf8")).toBe("answer: 42\n");
  }, 120_000);

  it("applies retention and prunes, then checks the repository", async () => {
    await run("backup", repoId, { policyId });
    await prisma.backupPolicy.update({ where: { id: policyId }, data: { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 } });
    const p = await run("prune", repoId, { policyId });
    expect(p.error).toBe("");
    expect(p.log).toMatch(/remove \d+ snapshots|snapshots? removed|keep 1 snapshots/i);
    const c = await run("check", repoId);
    expect(c.error).toBe("");
    expect((await prisma.backupRepo.findUniqueOrThrow({ where: { id: repoId } })).lastCheckOk).toBe(true);
  }, 240_000);

  it("reports a clear error for a missing container", async () => {
    const bad = await prisma.backupPolicy.create({
      data: { name: "bad", endpointId, destinationId, sources: JSON.stringify([{ type: "db", engine: "postgres", container: "no-such-container" }]) },
    });
    const r = await run("backup", repoId, { policyId: bad.id });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/no-such-container not found/);
  }, 120_000);

  it("backs up DeployNow itself with the local restic and drills it", async () => {
    const { repo } = await worker.getOrCreateRepo(destinationId, "instance");
    const pol = await prisma.backupPolicy.create({ data: { name: "deploynow", destinationId, sources: JSON.stringify([{ type: "instance" }]) } });
    const b = await run("backup", repo.id, { policyId: pol.id });
    expect(b.error).toBe("");
    const d = await run("drill", repo.id);
    expect(d.error).toBe("");
    expect(d.log).toMatch(/Drill: instance OK/);
  }, 180_000);
});
