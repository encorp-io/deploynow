/**
 * App settings that reference other records: a build server, a registry to
 * push to, and pull request previews.
 */
import type { Application } from "@prisma/client";
import { prisma } from "../prisma";
import { ConfigError, validateHost } from "./config";
import { canUseRegistry, normalizeRegistryHost, type Actor } from "../registryAuth";
import { parseImageRef } from "../imageRef";

type Existing = Pick<Application, "sourceType" | "endpointId" | "buildEndpointId" | "registryId" | "pullRegistryId" | "image" | "previewsEnabled" | "previewDomain" | "previewOfId"> | null | undefined;

/** Who is saving, and the project the app is in: registry logins are checked against both. */
export interface ExtrasContext {
  actor: Actor;
  projectId: string;
}

async function usableRegistry(raw: unknown, ctx: ExtrasContext, current: string | null | undefined) {
  const id = raw ? String(raw) : null;
  if (!id || id === current) return id; // unchanged: keep it even if someone else picked it
  const r = await prisma.registry.findUnique({ where: { id } });
  if (!r || !canUseRegistry(ctx.actor, r, ctx.projectId)) throw new ConfigError("That registry login doesn't exist, or this app can't use it");
  return id;
}

export async function validateAppExtras(body: Record<string, unknown>, sourceType: string, endpointId: string, ctx: ExtrasContext, existing?: Existing) {
  const out: { buildEndpointId?: string | null; registryId?: string | null; pullRegistryId?: string | null; previewsEnabled?: boolean; previewDomain?: string } = {};
  const has = (k: string) => body[k] !== undefined;

  if (has("registryId")) out.registryId = await usableRegistry(body.registryId, ctx, existing?.registryId);
  if (has("pullRegistryId")) {
    out.pullRegistryId = await usableRegistry(body.pullRegistryId, ctx, existing?.pullRegistryId);
    const image = typeof body.image === "string" ? body.image : existing?.image;
    if (out.pullRegistryId && sourceType === "image" && image) {
      const r = await prisma.registry.findUniqueOrThrow({ where: { id: out.pullRegistryId } });
      const host = normalizeRegistryHost(parseImageRef(image).registry);
      if (r.host !== host) throw new ConfigError(`The image is on ${host}, but ${r.name} is a login for ${r.host}`);
    }
  }
  if (has("buildEndpointId")) {
    const id = body.buildEndpointId && body.buildEndpointId !== endpointId ? String(body.buildEndpointId) : null;
    if (id && !(await prisma.endpoint.findUnique({ where: { id } }))) throw new ConfigError("That build server doesn't exist");
    out.buildEndpointId = id;
  }
  const buildEndpointId = has("buildEndpointId") ? out.buildEndpointId : existing?.buildEndpointId;
  const registryId = has("registryId") ? out.registryId : existing?.registryId;
  if (buildEndpointId) {
    if (sourceType !== "git-dockerfile") throw new ConfigError("A separate build server is for Dockerfile apps");
    const reg = registryId ? await prisma.registry.findUnique({ where: { id: registryId } }) : null;
    if (!reg?.namespace) throw new ConfigError("Building on another endpoint needs a registry with a push namespace, so the target can pull the image");
  }

  if (has("previewsEnabled") || has("previewDomain")) {
    const enabled = has("previewsEnabled") ? body.previewsEnabled === true : !!existing?.previewsEnabled;
    let domain = has("previewDomain") ? String(body.previewDomain ?? "").trim().toLowerCase() : (existing?.previewDomain ?? "");
    if (domain) domain = validateHost(domain);
    if (enabled) {
      if (existing?.previewOfId) throw new ConfigError("A preview can't have previews of its own");
      if (sourceType !== "git-dockerfile" && sourceType !== "git-compose") throw new ConfigError("Pull request previews are for apps built from Git");
      if (!domain) throw new ConfigError("Enter the preview domain, e.g. preview.example.com (with *.preview.example.com pointing at the server)");
    }
    out.previewsEnabled = enabled;
    out.previewDomain = domain;
  }
  return out;
}
