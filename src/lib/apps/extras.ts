/**
 * App settings that reference other records: a build server, a registry to
 * push to, and pull request previews.
 */
import type { Application } from "@prisma/client";
import { prisma } from "../prisma";
import { ConfigError, validateHost } from "./config";

type Existing = Pick<Application, "sourceType" | "endpointId" | "buildEndpointId" | "registryId" | "previewsEnabled" | "previewDomain" | "previewOfId"> | null | undefined;

export async function validateAppExtras(body: Record<string, unknown>, sourceType: string, endpointId: string, existing?: Existing) {
  const out: { buildEndpointId?: string | null; registryId?: string | null; previewsEnabled?: boolean; previewDomain?: string } = {};
  const has = (k: string) => body[k] !== undefined;

  if (has("registryId")) {
    const id = body.registryId ? String(body.registryId) : null;
    if (id && !(await prisma.registry.findUnique({ where: { id } }))) throw new ConfigError("That registry doesn't exist");
    out.registryId = id;
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
