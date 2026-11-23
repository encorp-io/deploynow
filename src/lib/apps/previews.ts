/**
 * Pull request previews. When a PR opens (or gets new commits) on an app with
 * previews on, DeployNow deploys a copy of the app from the PR's branch at
 * pr-<number>.<previewDomain>. When the PR closes, the copy is removed.
 *
 * Only pull requests from the same repository get a preview: a fork's PR
 * would otherwise run someone else's Dockerfile on your server.
 */
import crypto from "crypto";
import type { Application } from "@prisma/client";
import { prisma } from "../prisma";
import { encryptSecret } from "../secretsCrypto";
import { audit } from "../audit";
import { enqueueDeploy, DeployBusyError } from "../jobs";
import { teardownApplication } from "../deploy/runner";
import { removeLog } from "../deploy/log";
import { BRANCH_RE, SHA_RE } from "../deploy/git";

export interface PullRequestEvent {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    title?: string;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
    base?: { ref?: string; repo?: { full_name?: string } };
  };
}

export function previewSlug(parentSlug: string, n: number): string {
  const suffix = `-pr-${n}`;
  return parentSlug.slice(0, 42 - suffix.length).replace(/-+$/, "") + suffix;
}

export function previewHost(domain: string, n: number): string {
  return `pr-${n}.${domain}`;
}

export type PreviewResult = { ok: true; ignored?: string; previewId?: string; deploymentId?: string; removed?: boolean };

export async function handlePullRequest(parent: Application, ev: PullRequestEvent): Promise<PreviewResult> {
  if (!parent.previewsEnabled || !parent.previewDomain) return { ok: true, ignored: "previews are off for this app" };
  if (parent.previewOfId) return { ok: true, ignored: "this app is itself a preview" };
  const pr = ev.pull_request;
  const n = Number(ev.number ?? pr?.number);
  if (!pr || !Number.isInteger(n) || n < 1) return { ok: true, ignored: "no pull request" };
  if (pr.base?.ref !== parent.gitBranch) return { ok: true, ignored: `not a pull request into ${parent.gitBranch}` };

  const existing = await prisma.application.findFirst({ where: { previewOfId: parent.id, prNumber: n }, include: { endpoint: true } });

  if (ev.action === "closed") {
    if (!existing) return { ok: true, ignored: "no preview to remove" };
    await removePreview(existing);
    await audit({ action: "app.preview_removed", message: `PR #${n} closed; removed the preview of ${parent.name}`, targetType: "application", targetId: parent.id, endpointId: parent.endpointId });
    return { ok: true, removed: true, previewId: existing.id };
  }
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(ev.action ?? "")) return { ok: true, ignored: `action ${ev.action}` };

  const headRepo = pr.head?.repo?.full_name;
  if (!headRepo || headRepo !== pr.base?.repo?.full_name) return { ok: true, ignored: "pull requests from forks don't get previews" };
  const sha = pr.head?.sha ?? "";
  const branch = pr.head?.ref ?? "";
  if (!SHA_RE.test(sha) || !BRANCH_RE.test(branch)) return { ok: true, ignored: "no usable head commit or branch" };

  let preview = existing;
  if (!preview) {
    const parentFull = await prisma.application.findUniqueOrThrow({ where: { id: parent.id }, include: { domains: true } });
    const slug = previewSlug(parent.slug, n);
    if (await prisma.application.findUnique({ where: { endpointId_slug: { endpointId: parent.endpointId, slug } } })) {
      return { ok: true, ignored: `an app named ${slug} already exists on the endpoint` };
    }
    const route = parentFull.domains.find((d) => !d.redirectTo);
    preview = await prisma.application.create({
      data: {
        environmentId: parent.environmentId,
        endpointId: parent.endpointId,
        name: `${parent.name} PR #${n}`.slice(0, 64),
        slug,
        sourceType: parent.sourceType,
        gitRepo: parent.gitRepo,
        gitBranch: branch,
        buildContext: parent.buildContext,
        dockerfilePath: parent.dockerfilePath,
        composePath: parent.composePath,
        env: parent.env,
        command: parent.command,
        restartPolicy: "unless-stopped",
        // No host ports or volumes: they would clash with (or share data with) the real app
        ports: "[]",
        volumes: "[]",
        updatePolicy: "manual",
        buildEndpointId: parent.buildEndpointId,
        registryId: parent.registryId,
        pullRegistryId: parent.pullRegistryId,
        previewOfId: parent.id,
        prNumber: n,
        webhookSecret: encryptSecret(crypto.randomBytes(24).toString("hex")),
        domains: route
          ? { create: [{ host: previewHost(parent.previewDomain, n), path: "/", containerPort: route.containerPort, service: route.service, https: route.https, basicAuth: route.basicAuth }] }
          : undefined,
      },
      include: { endpoint: true },
    });
    await audit({ action: "app.preview_created", message: `PR #${n} opened; created a preview of ${parent.name}${route ? ` at ${previewHost(parent.previewDomain, n)}` : ""}`, targetType: "application", targetId: preview.id, endpointId: parent.endpointId });
  } else if (preview.gitBranch !== branch) {
    preview = await prisma.application.update({ where: { id: preview.id }, data: { gitBranch: branch }, include: { endpoint: true } });
  }

  try {
    const dep = await enqueueDeploy(preview.id, { trigger: "preview", commitSha: sha, commitMessage: (pr.title ?? "").slice(0, 200) });
    return { ok: true, previewId: preview.id, deploymentId: dep.id };
  } catch (err) {
    if (err instanceof DeployBusyError) return { ok: true, previewId: preview.id, ignored: "a deployment is already queued" };
    throw err;
  }
}

export async function removePreview(preview: Application & { endpoint: import("@prisma/client").Endpoint }) {
  await teardownApplication(preview).catch((err) => console.error(`[previews] teardown of ${preview.slug} failed:`, err));
  const deps = await prisma.deployment.findMany({ where: { applicationId: preview.id }, select: { id: true } });
  await prisma.application.delete({ where: { id: preview.id } });
  deps.forEach((d) => removeLog(d.id));
}
