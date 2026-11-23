/**
 * The deploy pipeline. Runs inside the job worker, one deployment at a time
 * per application.
 *
 *   fetch     pull the image, or check out the commit
 *   env       decrypt secret env vars, read Vault references; mask them in logs
 *   build     docker build (Dockerfile apps) or docker compose build
 *   start     new container next to the old one, wait healthy, remove old;
 *             or docker compose up --wait
 *   record    digest, commit, env snapshot, containers; notify
 */
import fs from "fs";
import os from "os";
import path from "path";
import type Docker from "dockerode";
import type { Application, Deployment, Domain, Endpoint, Environment, Project } from "@prisma/client";
import { prisma } from "../prisma";
import { dockerFor, toConnection } from "../endpoints";
import { dockerErrorMessage } from "../docker/client";
import { pullImage } from "../docker/recreate";
import { allRegistryLogins, appPullContext, registryAuthFor, registryById, type PullContext } from "../registryAuth";
import { withDockerCli, runCommand, type RegistryLogin } from "../docker/cliBridge";
import { decryptSecret } from "../secretsCrypto";
import { audit } from "../audit";
import { notify } from "../notify";
import { makeMasker, readStoredEnv, resolveEnv } from "../apps/env";
import { parsePorts, parseVolumes, splitCommand, traefikLabels } from "../apps/config";
import { checkout } from "./git";
import { createLogger, type DeployLogger } from "./log";
import { deployContainer, oldContainers } from "./container";
import { renderCompose, stripBuild } from "./compose";
import { ensureNetwork } from "./proxy";

type FullApp = Application & {
  endpoint: Endpoint;
  environment: Environment & { project: Project };
  domains: Domain[];
};

export const KEEP_IMAGES = 5;

export function appNetworkName(app: { environment: Environment & { project: Project } }) {
  return `dn-${app.environment.project.slug}-${app.environment.slug}`.slice(0, 63);
}

async function githubToken(): Promise<string> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return s?.githubToken ? decryptSecret(s.githubToken) : "";
}

async function registryLogins(ctx: PullContext): Promise<RegistryLogin[]> {
  return allRegistryLogins(ctx);
}

function insideDir(root: string, rel: string): string {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`${rel} points outside the repository`);
  return full;
}

/** Digest-pinned reference for the image the daemon now has, if it came from a registry. */
async function pinnedRef(docker: Docker, image: string): Promise<{ ref: string; digest: string }> {
  try {
    const info = await docker.getImage(image).inspect();
    const repo = image.replace(/@sha256:[0-9a-f]+$/, "").replace(/:[\w.-]+$/, "");
    const match = (info.RepoDigests ?? []).find((d) => d.startsWith(`${repo}@`)) ?? info.RepoDigests?.[0];
    if (match) return { ref: match, digest: match.split("@")[1] };
    return { ref: image, digest: info.Id };
  } catch {
    return { ref: image, digest: "" };
  }
}

async function pruneImages(docker: Docker, app: FullApp, log: DeployLogger, extraRepo = "") {
  const keep = await prisma.deployment.findMany({
    where: { applicationId: app.id, status: "success" },
    orderBy: { createdAt: "desc" },
    take: KEEP_IMAGES,
    select: { id: true },
  });
  const keepTags = new Set(keep.map((d) => d.id.slice(-10)));
  try {
    const images = await docker.listImages({ filters: { reference: [`dn/${app.slug}:*`, `dn/${app.slug}-*:*`, ...(extraRepo ? [`${extraRepo}:*`] : [])] } });
    for (const img of images) {
      for (const tag of img.RepoTags ?? []) {
        const t = tag.split(":").pop() ?? "";
        if (keepTags.has(t)) continue;
        await docker.getImage(tag).remove({ noprune: false }).then(
          () => log(`Removed old image ${tag}`),
          () => {},
        );
      }
    }
  } catch {
    /* best effort */
  }
}

export interface RunContext {
  signal?: AbortSignal;
  /** test hooks */
  healthTimeoutMs?: number;
  settleMs?: number;
}

export async function runDeployment(deploymentId: string, ctx: RunContext = {}): Promise<Deployment> {
  const dep = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!dep) throw new Error("Deployment not found");
  if (dep.status !== "queued") return dep;

  const app = (await prisma.application.findUnique({
    where: { id: dep.applicationId },
    include: { endpoint: true, environment: { include: { project: true } }, domains: true },
  })) as FullApp | null;
  if (!app) throw new Error("Application not found");

  const log = createLogger(dep.id);
  await prisma.deployment.update({ where: { id: dep.id }, data: { status: "running", startedAt: new Date() } });
  await prisma.application.update({ where: { id: app.id }, data: { status: "deploying" } });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-build-"));
  const result: Partial<Deployment> = {};
  let ok = false;
  let pushRepo = "";

  try {
    const rollbackOf = dep.rollbackOfId ? await prisma.deployment.findUnique({ where: { id: dep.rollbackOfId } }) : null;
    if (dep.rollbackOfId && !rollbackOf) throw new Error("The deployment to roll back to no longer exists");
    const docker = dockerFor(app.endpoint);
    log(`${rollbackOf ? `Rolling back to deployment ${rollbackOf.id.slice(-8)}` : `Deploying ${app.name}`} on ${app.endpoint.name}`);

    // ── Fetch ────────────────────────────────────────────────────────────────
    let repoDir = "";
    if (app.sourceType === "git-dockerfile" || app.sourceType === "git-compose") {
      const sha = rollbackOf?.commitSha || dep.commitSha || undefined;
      log(`Fetching ${app.gitRepo} ${sha ? sha.slice(0, 12) : app.gitBranch}`);
      repoDir = path.join(workDir, "src");
      fs.mkdirSync(repoDir);
      const c = await checkout(repoDir, app.gitRepo, { branch: app.gitBranch, sha }, { token: await githubToken(), log, signal: ctx.signal });
      result.commitSha = c.sha;
      result.commitMessage = c.message;
      log(`Checked out ${c.sha.slice(0, 12)} ${c.message}`);
    }

    let composeText = "";
    if (app.sourceType === "compose") composeText = app.composeInline;
    if (app.sourceType === "git-compose") {
      const file = insideDir(repoDir, app.composePath);
      if (!fs.existsSync(file)) throw new Error(`${app.composePath} isn't in the repository`);
      composeText = fs.readFileSync(file, "utf8");
    }

    // ── Environment ──────────────────────────────────────────────────────────
    // A rollback runs with the env the earlier deployment had
    const envJson = rollbackOf ? rollbackOf.envSnapshot : app.env;
    result.envSnapshot = envJson;
    const stored = readStoredEnv(envJson);
    const env = await resolveEnv(stored);
    // Registry passwords never go to the log either, even if a tool echoes them
    const pullCtx = appPullContext(app);
    const logins = await allRegistryLogins(pullCtx);
    log.setMask(makeMasker([...env.sensitive, ...logins.map((l) => l.password)]));
    const counts = { secret: stored.filter((e) => e.kind === "secret").length, vault: stored.filter((e) => e.kind === "vault").length };
    if (stored.length) log(`${stored.length} environment variable${stored.length === 1 ? "" : "s"} (${counts.secret} secret, ${counts.vault} from Vault)`);
    const envMap: Record<string, string | undefined> = Object.fromEntries(env.vars.map((v) => [v.key, v.value]));

    // ── Proxy ────────────────────────────────────────────────────────────────
    const proxyNetwork = app.endpoint.proxyMode === "none" ? null : app.endpoint.proxyNetwork;
    if (app.domains.length && !proxyNetwork) throw new Error("This app has domains, but the endpoint has no edge proxy. Set one up on the endpoint page.");
    if (proxyNetwork && app.domains.length) {
      if (app.endpoint.proxyMode === "managed") await ensureNetwork(docker, proxyNetwork);
      else await docker.getNetwork(proxyNetwork).inspect().catch(() => {
        throw new Error(`The proxy network ${proxyNetwork} doesn't exist on ${app.endpoint.name}`);
      });
    }


    if (app.sourceType === "image" || app.sourceType === "git-dockerfile") {
      // ── Image or build ─────────────────────────────────────────────────────
      let image: string;
      if (app.sourceType === "image") {
        image = rollbackOf?.imageRef || app.image;
        log(`Pulling ${image}`);
        try {
          await pullImage(docker, image, await registryAuthFor(image, pullCtx));
        } catch (err) {
          // Registry down or rate-limited: a rollback or redeploy can still use the local copy
          const local = await docker.getImage(image).inspect().then(() => true, () => false);
          if (!local) throw err;
          log(`Pull failed (${dockerErrorMessage(err)}); using the copy already on ${app.endpoint.name}`);
        }
        const pin = await pinnedRef(docker, image);
        result.imageRef = pin.ref;
        result.imageDigest = pin.digest;
        image = pin.ref;
      } else if (rollbackOf) {
        image = rollbackOf.imageRef;
        try {
          await docker.getImage(image).inspect();
        } catch {
          // Built and pushed elsewhere: the registry may still have it
          if (image.startsWith("dn/")) throw new Error(`The image ${image} from that deployment was removed; only the last ${KEEP_IMAGES} builds are kept`);
          log(`Pulling ${image}`);
          await pullImage(docker, image, await registryAuthFor(image, pullCtx));
        }
        result.imageRef = image;
        result.imageDigest = rollbackOf.imageDigest;
      } else {
        // Optionally build on a separate build server and push to a registry; the target pulls it
        const registry = await registryById(app.registryId);
        const buildEndpoint = app.buildEndpointId && app.buildEndpointId !== app.endpointId ? await prisma.endpoint.findUnique({ where: { id: app.buildEndpointId } }) : null;
        if (app.buildEndpointId && app.buildEndpointId !== app.endpointId && !buildEndpoint) throw new Error("The build server for this app was removed; pick another one in the app settings");
        if (buildEndpoint && !registry?.namespace) throw new Error("Building on another endpoint needs a registry with a push namespace (Settings → Container registries)");
        pushRepo = registry?.namespace ? `${registry.namespace}/${app.slug}` : "";
        image = pushRepo ? `${pushRepo}:${dep.id.slice(-10)}` : `dn/${app.slug}:${dep.id.slice(-10)}`;
        const context = insideDir(repoDir, app.buildContext);
        const dockerfile = insideDir(repoDir, app.dockerfilePath);
        if (!fs.existsSync(dockerfile)) throw new Error(`${app.dockerfilePath} isn't in the repository`);
        const args = ["build", "--progress=plain", "-t", image, "-f", dockerfile, "--label", `deploynow.app=${app.id}`, "--label", `deploynow.deployment=${dep.id}`];
        args.push(context);
        const builder = buildEndpoint ?? app.endpoint;
        log(`Building ${image}${buildEndpoint ? ` on ${buildEndpoint.name}` : ""}`);
        await withDockerCli(toConnection(builder), await registryLogins(pullCtx), async (cli) => {
          await runCommand("docker", args, { cwd: repoDir, env: cli.env, onOutput: log, signal: ctx.signal, timeoutMs: 30 * 60_000 });
          if (pushRepo) {
            log(`Pushing ${image} to ${registry!.name}`);
            await runCommand("docker", ["push", image], { cwd: repoDir, env: cli.env, onOutput: log, signal: ctx.signal, timeoutMs: 30 * 60_000 });
          }
        });
        if (buildEndpoint) {
          // The build server doesn't need to keep it (removed before the pull, in case both are one daemon)
          await dockerFor(buildEndpoint).getImage(image).remove().catch(() => {});
          log(`Pulling ${image} on ${app.endpoint.name}`);
          await pullImage(docker, image, await registryAuthFor(image, pullCtx));
        }
        const info = await docker.getImage(image).inspect();
        result.imageRef = image;
        result.imageDigest = info.Id;
      }

      const network = appNetworkName(app);
      await ensureNetwork(docker, network, { "deploynow.project": app.environment.projectId });
      const containerId = await deployContainer(
        docker,
        {
          appId: app.id,
          slug: app.slug,
          deploymentId: dep.id,
          image,
          env: env.vars.map((v) => `${v.key}=${v.value}`),
          labels: proxyNetwork ? traefikLabels(app.slug, app.domains, proxyNetwork) : {},
          cmd: app.command ? splitCommand(app.command) : undefined,
          ports: parsePorts(app.ports),
          volumes: parseVolumes(app.volumes),
          restartPolicy: app.restartPolicy,
          appNetwork: network,
          proxyNetwork: app.domains.length ? proxyNetwork : null,
        },
        log,
        { healthTimeoutMs: ctx.healthTimeoutMs, settleMs: ctx.settleMs, signal: ctx.signal },
      );
      result.containerIds = containerId;
    } else {
      // ── Compose ────────────────────────────────────────────────────────────
      const composeDir = app.sourceType === "git-compose" ? path.dirname(insideDir(repoDir, app.composePath)) : workDir;
      let rendered: string;
      if (rollbackOf) {
        rendered = stripBuild(rollbackOf.renderedCompose);
      } else {
        rendered = renderCompose({
          compose: composeText,
          appId: app.id,
          slug: app.slug,
          deploymentId: dep.id,
          domains: app.domains,
          proxyNetwork,
        }).yaml;
      }
      result.renderedCompose = rendered;
      const file = path.join(composeDir, ".deploynow-compose.yml");
      fs.writeFileSync(file, rendered, { mode: 0o600 });

      const base = ["compose", "--progress", "plain", "-p", app.slug, "-f", file];
      await withDockerCli(toConnection(app.endpoint), await registryLogins(pullCtx), async (cli) => {
        const run = (args: string[], timeoutMs = 30 * 60_000) =>
          runCommand("docker", [...base, ...args], { cwd: composeDir, env: { ...envMap, ...cli.env }, onOutput: log, signal: ctx.signal, timeoutMs });
        if (!rollbackOf) {
          log("Pulling images");
          await run(["pull", "--ignore-buildable", "--ignore-pull-failures", "--quiet"]);
          log("Building");
          await run(["build"]);
        }
        log("Starting services");
        await run(["up", "-d", "--remove-orphans", "--no-build", "--wait", "--wait-timeout", String(Math.round((ctx.healthTimeoutMs ?? 300_000) / 1000))], 15 * 60_000);
      });
      const list = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${app.slug}`] } });
      result.containerIds = list.map((c) => c.Id).join(",");
    }

    await pruneImages(docker, app, log, pushRepo);
    ok = true;
    log("Deployment finished");
  } catch (err) {
    const msg = err instanceof Error ? err.message : dockerErrorMessage(err);
    result.error = msg.slice(0, 2000);
    log(`Deployment failed: ${msg}`);
  } finally {
    log.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const cancelled = ctx.signal?.aborted;
  const finished = await prisma.deployment.update({
    where: { id: dep.id },
    data: { ...result, status: ok ? "success" : cancelled ? "cancelled" : "failed", finishedAt: new Date() },
  });
  await prisma.application.update({
    where: { id: app.id },
    data: ok ? { status: "running", currentDeploymentId: dep.id } : { status: app.currentDeploymentId ? "running" : "failed" },
  });

  const verb = dep.trigger === "rollback" ? "Rollback" : "Deploy";
  await audit({
    actor: dep.startedById ? { id: dep.startedById, email: dep.startedByEmail } : null,
    action: dep.trigger === "rollback" ? "app.rollback" : "app.deploy",
    targetType: "application",
    targetId: app.id,
    endpointId: app.endpointId,
    outcome: ok ? "success" : "failure",
    message: `${verb} of ${app.name} ${ok ? "succeeded" : cancelled ? "was cancelled" : "failed"}`,
    details: ok ? [finished.imageRef, finished.commitSha.slice(0, 12)].filter(Boolean).join(" ") : finished.error,
  });
  await notify({
    event: ok ? "deploy.success" : "deploy.failure",
    ok,
    title: `${verb} of ${app.environment.project.name} / ${app.name} (${app.environment.name}) ${ok ? "succeeded" : "failed"}`,
    text: ok ? "" : finished.error,
    fields: {
      Endpoint: app.endpoint.name,
      Trigger: dep.trigger,
      ...(finished.commitSha ? { Commit: `${finished.commitSha.slice(0, 12)} ${finished.commitMessage}`.trim() } : {}),
      ...(finished.imageRef ? { Image: finished.imageRef } : {}),
    },
  });
  return finished;
}

/** Stop and remove everything an application runs on its endpoint. */
export async function teardownApplication(app: FullApp | (Application & { endpoint: Endpoint })): Promise<void> {
  const docker = dockerFor(app.endpoint);
  if (app.sourceType === "compose" || app.sourceType === "git-compose") {
    const list = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${app.slug}`] } });
    for (const c of list) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
  }
  for (const c of await oldContainers(docker, app.id, "")) await docker.getContainer(c.Id).remove({ force: true }).catch(() => {});
}
