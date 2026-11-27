/**
 * Auto-update of a compose app against a real Docker daemon and a local
 * registry: a new image is pushed under the same tag, the update fails, and
 * the rollback brings back the exact image that ran before (pinned by digest),
 * not whatever the tag points to now.
 *
 * Skipped when no daemon is reachable or registry:2 / busybox:1.37 can't be pulled.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import Docker from "dockerode";

vi.mock("@/lib/notify", () => ({ notify: vi.fn(async () => {}) }));

const SOCKET = "/var/run/docker.sock";
const docker = new Docker({ socketPath: SOCKET });
const BUSYBOX = "busybox:1.37";

async function ready(image: string) {
  if (!fs.existsSync(SOCKET)) return false;
  try {
    await docker.ping();
    await docker.getImage(image).inspect().catch(async () => {
      await new Promise<void>((resolve, reject) =>
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => (err ? reject(err) : docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())))),
      );
    });
    return true;
  } catch {
    return false;
  }
}
const up = (await ready(BUSYBOX)) && (await ready("registry:2"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-autoupdate-it-"));
const tag = `au${process.pid}`;
const PORT = 15000 + (process.pid % 1000);
const REG = `localhost:${PORT}`;
const IMAGE = `${REG}/${tag}/web:stable`;
const sh = (cmd: string) => execSync(cmd, { stdio: "pipe" }).toString();

/** Build an image whose default command is `cmd`, push it as IMAGE, return its manifest digest. */
function pushVersion(version: string, cmd: string): string {
  const ctx = fs.mkdtempSync(path.join(dir, "ctx-"));
  fs.writeFileSync(path.join(ctx, "Dockerfile"), `FROM ${BUSYBOX}\nRUN echo ${version} > /version\nCMD ${JSON.stringify(["sh", "-c", cmd])}\n`);
  sh(`docker build -q -t ${IMAGE} ${ctx}`);
  const out = sh(`docker push ${IMAGE}`);
  const m = /digest: (sha256:[0-9a-f]{64})/.exec(out);
  if (!m) throw new Error(`no digest in push output: ${out}`);
  return m[1];
}

let prisma: typeof import("@/lib/prisma").prisma;
let runDeployment: typeof import("@/lib/deploy/runner").runDeployment;
let teardownApplication: typeof import("@/lib/deploy/runner").teardownApplication;
let au: typeof import("@/lib/apps/autoUpdate");
let appId = "";

describe.skipIf(!up)("compose auto-update with rollback (real Docker)", () => {
  beforeAll(async () => {
    sh(`docker run -d --rm --name ${tag}-registry -p ${PORT}:5000 registry:2`);
    for (let i = 0; i < 30; i++) {
      if (await fetch(`http://${REG}/v2/`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    process.env.DATABASE_URL = `file:${path.join(dir, "it.db")}`;
    process.env.DEPLOYNOW_DATA_DIR = dir;
    execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
    ({ prisma } = await import("@/lib/prisma"));
    ({ runDeployment, teardownApplication } = await import("@/lib/deploy/runner"));
    au = await import("@/lib/apps/autoUpdate");
  }, 120_000);

  afterAll(async () => {
    if (prisma && appId) {
      const app = await prisma.application.findUnique({ where: { id: appId }, include: { endpoint: true } });
      if (app) await teardownApplication(app).catch(() => {});
      await prisma.$disconnect();
    }
    execSync(`docker rm -f ${tag}-registry`, { stdio: "ignore" });
    for (const img of await docker.listImages({ filters: { reference: [`${REG}/${tag}/*`] } })) {
      await docker.getImage(img.Id).remove({ force: true }).catch(() => {});
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("updates, notices the broken release and rolls back to the pinned digest", async () => {
    const v1 = pushVersion("v1", "sleep 3600");

    const ep = await prisma.endpoint.create({ data: { name: "local", type: "socket", host: SOCKET, status: "online" } });
    const project = await prisma.project.create({ data: { name: `IT ${tag}`, slug: tag, environments: { create: { name: "production", slug: "production" } } }, include: { environments: true } });
    // The image comes from an env var, as many compose files write it
    const compose = "services:\n  web:\n    image: ${WEB_IMAGE}\n";
    const env = JSON.stringify([{ key: "WEB_IMAGE", kind: "plain", value: IMAGE }]);
    const app = await prisma.application.create({
      data: { environmentId: project.environments[0].id, endpointId: ep.id, name: "web", slug: `${tag}-web`, sourceType: "compose", composeInline: compose, env, restartPolicy: "no", autoUpdate: true },
    });
    appId = app.id;

    // First deployment by hand
    const first = await prisma.deployment.create({ data: { applicationId: app.id, trigger: "manual" } });
    const done = await runDeployment(first.id, { healthTimeoutMs: 30_000 });
    expect(done.status).toBe("success");
    expect(JSON.parse(done.serviceImages)).toEqual({ web: `${REG}/${tag}/web@${v1}` });

    // Nothing new yet. The finder reads the local registry over http (the real one refuses localhost)
    const finder = {
      branchHead: async () => "",
      digests: async (image: string) => {
        const repo = image.slice(REG.length + 1).replace(/:[\w.-]+$/, "");
        const res = await fetch(`http://${REG}/v2/${repo}/manifests/stable`, { method: "HEAD", headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json" } });
        const d = res.headers.get("docker-content-digest") ?? "";
        return { config: d, manifest: d };
      },
    };
    expect((await au.checkApp(app.id, { finder })).state).toBe("up-to-date");

    // A broken release under the same tag: exits right away
    pushVersion("v2", "exit 3");
    const r = await au.checkApp(app.id, { finder });
    expect(r.state).toBe("queued");
    const upd = await prisma.deployment.findFirstOrThrow({ where: { applicationId: app.id, trigger: "auto-update" } });
    const failed = await runDeployment(upd.id, { healthTimeoutMs: 20_000 });
    expect(failed.status).toBe("failed");

    // The failed compose update is rolled back
    await au.advanceRuns();
    const run = await prisma.autoUpdateRun.findFirstOrThrow({ where: { applicationId: app.id } });
    expect(run.status).toBe("rolling-back");
    const rb = await runDeployment(run.rollbackDeploymentId, { healthTimeoutMs: 30_000 });
    expect(rb.status).toBe("success");
    // It ran v1 by digest, but records the tag so auto-update keeps following it
    expect(rb.renderedCompose).toContain("image: ${WEB_IMAGE}");
    expect(JSON.parse(rb.serviceImages)).toEqual({ web: `${REG}/${tag}/web@${v1}` });
    await au.advanceRuns();
    expect((await prisma.autoUpdateRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("rolled-back");

    // v1 runs again, though the tag points to v2
    const list = await docker.listContainers({ filters: { label: [`com.docker.compose.project=${app.slug}`] } });
    expect(list).toHaveLength(1);
    const info = await docker.getImage(list[0].ImageID).inspect();
    expect(info.RepoDigests).toContain(`${REG}/${tag}/web@${v1}`);

    // And the broken release isn't tried again
    expect((await au.checkApp(app.id, { finder })).state).toBe("already-tried");

    // A fixed release is tried, passes the real health check and stays
    const v3 = pushVersion("v3", "sleep 3600");
    expect((await au.checkApp(app.id, { finder })).state).toBe("queued");
    const good = await prisma.deployment.findFirstOrThrow({ where: { applicationId: app.id, trigger: "auto-update", status: "queued" } });
    expect((await runDeployment(good.id, { healthTimeoutMs: 30_000 })).status).toBe("success");
    await au.advanceRuns({ verifyMs: 0 });
    await au.advanceRuns({ verifyMs: 0 });
    const ok = await prisma.autoUpdateRun.findFirstOrThrow({ where: { applicationId: app.id, deploymentId: good.id } });
    expect(ok.status).toBe("success");
    const now = await docker.listContainers({ filters: { label: [`com.docker.compose.project=${app.slug}`] } });
    expect((await docker.getImage(now[0].ImageID).inspect()).RepoDigests).toContain(`${REG}/${tag}/web@${v3}`);
    expect((await au.checkApp(app.id, { finder })).state).toBe("up-to-date");
  }, 240_000);
});
