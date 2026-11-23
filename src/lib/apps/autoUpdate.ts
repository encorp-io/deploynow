/**
 * Image apps with the "auto-digest" policy redeploy when their tag points to
 * a new digest in the registry (the v1 auto-update, per application).
 */
import { prisma } from "../prisma";
import { getRemoteDigests } from "../ghcr";
import { parseImageRef } from "../imageRef";
import { appPullContext, registryAuthFor } from "../registryAuth";
import { DeployBusyError, enqueueDeploy } from "../jobs";

export async function checkAppImageUpdates(): Promise<number> {
  const apps = await prisma.application.findMany({
    where: { sourceType: "image", updatePolicy: "auto-digest", status: "running", currentDeploymentId: { not: null } },
    include: { environment: { select: { projectId: true } } },
  });
  let queued = 0;
  for (const app of apps) {
    if (app.image.includes("@sha256:")) continue;
    try {
      const busy = await prisma.deployment.findFirst({ where: { applicationId: app.id, status: { in: ["queued", "running"] } } });
      if (busy) continue;
      const current = await prisma.deployment.findUnique({ where: { id: app.currentDeploymentId! } });
      if (!current?.imageDigest) continue;
      const ref = parseImageRef(app.image);
      // Same login the deploy pulls with, so private images and personal or project logins work
      const auth = ref.registry === "ghcr.io" || ref.registry === "docker.io" ? await registryAuthFor(app.image, appPullContext(app)) : undefined;
      const remote = await getRemoteDigests(ref.registry, ref.repository, ref.tag, undefined, auth);
      if (!remote) continue;
      if (current.imageDigest === remote.manifest || current.imageDigest === remote.config) continue;
      await enqueueDeploy(app.id, { trigger: "digest" });
      queued++;
    } catch (err) {
      if (err instanceof DeployBusyError) continue;
      console.error(`[deploy] Digest check failed for ${app.name}:`, err instanceof Error ? err.message : "unknown error");
    }
  }
  return queued;
}
