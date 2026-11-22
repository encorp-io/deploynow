/**
 * The deploy pipeline against a real Docker daemon and a real SQLite database:
 * image app with an encrypted env secret, Dockerfile from Git, compose,
 * rollback, and a domain routed by the managed Traefik.
 *
 * Skipped when no daemon is reachable. Pulls busybox:1.37 if it's missing;
 * the Traefik case also needs traefik:v3.6 and free ports 80/443.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import Docker from "dockerode";

const SOCKET = "/var/run/docker.sock";
const docker = new Docker({ socketPath: SOCKET });
const BUSYBOX = "busybox:1.37";

/** True when the daemon answers and the image is present, pulling it if needed (CI runners start empty). */
async function ready(image: string) {
  if (!fs.existsSync(SOCKET)) return false;
  try {
    await docker.ping();
  } catch {
    return false;
  }
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    try {
      await new Promise<void>((resolve, reject) =>
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => (err ? reject(err) : docker.modem.followProgress(stream, (e) => (e ? reject(e) : resolve())))),
      );
      return true;
    } catch {
      return false;
    }
  }
}
const up = await ready(BUSYBOX);
const traefikUp = up && (await ready("traefik:v3.6"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-deploy-it-"));
const tag = `it${process.pid}`;

// Loaded after DATABASE_URL points at the test database
let prisma: typeof import("@/lib/prisma").prisma;
let runDeployment: typeof import("@/lib/deploy/runner").runDeployment;
let teardownApplication: typeof import("@/lib/deploy/runner").teardownApplication;
let readLog: typeof import("@/lib/deploy/log").readLog;
let parseEnvInput: typeof import("@/lib/apps/env").parseEnvInput;
let installProxy: typeof import("@/lib/deploy/proxy").installProxy;
let removeProxy: typeof import("@/lib/deploy/proxy").removeProxy;

let endpointId = "";
let environmentId = "";
const appIds: string[] = [];

async function newDeployment(applicationId: string, extra: Record<string, unknown> = {}) {
  return prisma.deployment.create({ data: { applicationId, trigger: "manual", ...extra } });
}

async function createApp(data: Record<string, unknown>) {
  const app = await prisma.application.create({ data: { environmentId, endpointId, restartPolicy: "no", ...data } as never });
  appIds.push(app.id);
  return app;
}

/** fetch() can't set Host, so use http.get */
function getWithHost(host: string): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: 80, path: "/", headers: { Host: host }, timeout: 3000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => req.destroy());
  });
}

async function envOf(containerId: string) {
  return (await docker.getContainer(containerId).inspect()).Config.Env;
}

describe.skipIf(!up)("deploy pipeline (real Docker)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = `file:${path.join(dir, "it.db")}`;
    process.env.DEPLOYNOW_DATA_DIR = dir;
    execSync("npx prisma db push --skip-generate", { env: { ...process.env }, stdio: "ignore" });
    ({ prisma } = await import("@/lib/prisma"));
    ({ runDeployment, teardownApplication } = await import("@/lib/deploy/runner"));
    ({ readLog } = await import("@/lib/deploy/log"));
    ({ parseEnvInput } = await import("@/lib/apps/env"));
    ({ installProxy, removeProxy } = await import("@/lib/deploy/proxy"));

    const ep = await prisma.endpoint.create({ data: { name: "local", type: "socket", host: SOCKET } });
    endpointId = ep.id;
    const project = await prisma.project.create({
      data: { name: `IT ${tag}`, slug: tag, environments: { create: { name: "production", slug: "production" } } },
      include: { environments: true },
    });
    environmentId = project.environments[0].id;
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    for (const id of appIds) {
      const app = await prisma.application.findUnique({ where: { id }, include: { endpoint: true } });
      if (app) await teardownApplication(app).catch(() => {});
    }
    for (const img of await docker.listImages({ filters: { reference: [`dn/${tag}*`] } })) {
      for (const t of img.RepoTags ?? []) await docker.getImage(t).remove({ force: true }).catch(() => {});
    }
    await docker.getNetwork(`dn-${tag}-production`).remove().catch(() => {});
    await prisma.$disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("deploys an image app with a plain and a secret env var, and masks the secret in the log", async () => {
    const env = JSON.stringify(
      parseEnvInput([
        { key: "GREETING", value: "hello", kind: "plain" },
        { key: "API_TOKEN", value: "s3cr3t-value-123", kind: "secret" },
      ]),
    );
    expect(env).not.toContain("s3cr3t-value-123");
    const app = await createApp({
      name: "web",
      slug: `${tag}-web`,
      sourceType: "image",
      image: BUSYBOX,
      command: `sh -c 'echo token=$API_TOKEN; exec sleep 600'`,
      env,
    });
    const dep = await newDeployment(app.id);
    const done = await runDeployment(dep.id, { settleMs: 1500 });
    const log = readLog(dep.id).text;
    expect(done.status, done.error + "\n" + log).toBe("success");
    expect(done.imageRef).toBeTruthy();
    expect(log).not.toContain("s3cr3t-value-123");

    const containerEnv = await envOf(done.containerIds);
    expect(containerEnv).toContain("GREETING=hello");
    expect(containerEnv).toContain("API_TOKEN=s3cr3t-value-123");
    const info = await docker.getContainer(done.containerIds).inspect();
    expect(info.Config.Labels["deploynow.app"]).toBe(app.id);
    expect(Object.keys(info.NetworkSettings.Networks)).toContain(`dn-${tag}-production`);

    // A second deployment replaces the container (start-first: no ports, no volumes)
    const dep2 = await newDeployment(app.id);
    const done2 = await runDeployment(dep2.id, { settleMs: 1500 });
    expect(done2.status, done2.error).toBe("success");
    expect(done2.containerIds).not.toBe(done.containerIds);
    await expect(docker.getContainer(done.containerIds).inspect()).rejects.toThrow();

    // Rollback runs the first deployment's env snapshot even after the secret changes
    await prisma.application.update({
      where: { id: app.id },
      data: { env: JSON.stringify(parseEnvInput([{ key: "GREETING", value: "changed" }, { key: "API_TOKEN", value: "other-token-456", kind: "secret" }])) },
    });
    const rb = await newDeployment(app.id, { trigger: "rollback", rollbackOfId: done.id });
    const rolled = await runDeployment(rb.id, { settleMs: 1500 });
    expect(rolled.status, rolled.error).toBe("success");
    const rolledEnv = await envOf(rolled.containerIds);
    expect(rolledEnv).toContain("GREETING=hello");
    expect(rolledEnv).toContain("API_TOKEN=s3cr3t-value-123");
  }, 120_000);

  it("fails cleanly and keeps the running container when the new one crashes", async () => {
    const app = await createApp({ name: "crashy", slug: `${tag}-crashy`, sourceType: "image", image: BUSYBOX, command: "sleep 600" });
    const ok = await runDeployment((await newDeployment(app.id)).id, { settleMs: 1000 });
    expect(ok.status, ok.error).toBe("success");
    await prisma.application.update({ where: { id: app.id }, data: { command: "sh -c 'echo boom; exit 3'" } });
    const bad = await runDeployment((await newDeployment(app.id)).id, { settleMs: 1000 });
    expect(bad.status).toBe("failed");
    expect(bad.error).toMatch(/exit code 3/);
    expect(readLog(bad.id).text).toContain("boom");
    const still = await docker.getContainer(ok.containerIds).inspect();
    expect(still.State.Running).toBe(true);
    const fresh = await prisma.application.findUnique({ where: { id: app.id } });
    expect(fresh?.status).toBe("running");
    expect(fresh?.currentDeploymentId).toBe(ok.id);
  }, 120_000);

  it("builds a Dockerfile from a Git repository", async () => {
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "app"), { recursive: true });
    fs.writeFileSync(path.join(repo, "app", "Dockerfile"), `FROM ${BUSYBOX}\nRUN echo built > /built.txt\nCMD ["sleep", "600"]\n`);
    const git = (args: string) => execSync(`git -c user.email=it@test -c user.name=it ${args}`, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init -q -b main");
    git("add .");
    git("commit -q -m 'first build'");
    const sha = git("rev-parse HEAD");

    const app = await createApp({
      name: "built",
      slug: `${tag}-built`,
      sourceType: "git-dockerfile",
      gitRepo: `file://${repo}`,
      gitBranch: "main",
      buildContext: "app",
      dockerfilePath: "app/Dockerfile",
    });
    const done = await runDeployment((await newDeployment(app.id)).id, { settleMs: 1000 });
    expect(done.status, done.error + "\n" + readLog(done.id).text).toBe("success");
    expect(done.commitSha).toBe(sha);
    expect(done.commitMessage).toBe("first build");
    expect(done.imageRef).toBe(`dn/${tag}-built:${done.id.slice(-10)}`);
    const img = await docker.getImage(done.imageRef).inspect();
    expect(img.Config.Labels?.["deploynow.app"]).toBe(app.id);
  }, 300_000);

  it("deploys an inline compose app, passing env vars for ${VAR} interpolation", async () => {
    const env = JSON.stringify(parseEnvInput([{ key: "DB_PASSWORD", value: "compose-secret-789", kind: "secret" }]));
    const compose = [
      "services:",
      "  api:",
      `    image: ${BUSYBOX}`,
      "    command: sleep 600",
      "    environment:",
      "      PASSWORD: ${DB_PASSWORD}",
      "  worker:",
      `    image: ${BUSYBOX}`,
      "    command: sleep 600",
      "    environment:",
      "      - DB_PASSWORD",
      "",
    ].join("\n");
    const app = await createApp({ name: "stack", slug: `${tag}-stack`, sourceType: "compose", composeInline: compose, env });
    const done = await runDeployment((await newDeployment(app.id)).id, { healthTimeoutMs: 60_000 });
    const log = readLog(done.id).text;
    expect(done.status, done.error + "\n" + log).toBe("success");
    expect(done.renderedCompose).not.toContain("compose-secret-789");
    expect(log).not.toContain("compose-secret-789");
    const ids = done.containerIds.split(",").filter(Boolean);
    expect(ids).toHaveLength(2);
    const envs = await Promise.all(ids.map(envOf));
    expect(envs.flat()).toContain("PASSWORD=compose-secret-789");
    expect(envs.flat()).toContain("DB_PASSWORD=compose-secret-789");
  }, 180_000);

  it.skipIf(!traefikUp)("routes a domain through the managed Traefik", async () => {
    try {
      await installProxy(docker, { email: "ops@example.com", network: "deploynow" });
    } catch (err) {
      if (/already in use/.test((err as Error).message)) return; // ports busy on this machine
      throw err;
    }
    try {
      await prisma.endpoint.update({ where: { id: endpointId }, data: { proxyMode: "managed", proxyNetwork: "deploynow" } });
      const app = await createApp({
        name: "site",
        slug: `${tag}-site`,
        sourceType: "image",
        image: BUSYBOX,
        command: `sh -c 'mkdir -p /www && echo hello-from-deploynow > /www/index.html && exec httpd -f -p 8080 -h /www'`,
        domains: { create: [{ host: `${tag}.example.test`, path: "/", containerPort: 8080, https: false }] },
      });
      const done = await runDeployment((await newDeployment(app.id)).id, { settleMs: 1000 });
      expect(done.status, done.error).toBe("success");
      let body = "";
      for (let i = 0; i < 30 && !body.includes("hello-from-deploynow"); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        body = await getWithHost(`${tag}.example.test`);
      }
      expect(body).toContain("hello-from-deploynow");
    } finally {
      await removeProxy(docker);
      await prisma.endpoint.update({ where: { id: endpointId }, data: { proxyMode: "none" } });
    }
  }, 120_000);
});
