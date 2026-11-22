/** Shared gate for /api/endpoints/[id]/… route handlers. */
import { NextResponse } from "next/server";
import type Docker from "dockerode";
import type { Endpoint } from "@prisma/client";
import { requireUser, type CurrentUser } from "./apiAuth";
import { prisma } from "./prisma";
import { dockerFor } from "./endpoints";
import { dockerErrorMessage, dockerStatusCode } from "./docker/client";
import type { Permission } from "./rbac";

export const ENDPOINT_ID_RE = /^c[a-z0-9]{24}$/;
// Container, image, volume and network ids/names Docker accepts
export const DOCKER_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,254}$/;

type Ctx = { user: CurrentUser; endpoint: Endpoint; docker: Docker };

export async function endpointGate(
  id: string,
  permission: Permission,
): Promise<{ ok: true; ctx: Ctx } | { ok: false; response: NextResponse }> {
  if (!ENDPOINT_ID_RE.test(id)) {
    return { ok: false, response: NextResponse.json({ error: "Invalid endpoint id" }, { status: 400 }) };
  }
  const gate = await requireUser(permission, { endpointId: id });
  if (!gate.ok) return gate;
  const endpoint = await prisma.endpoint.findUnique({ where: { id } });
  if (!endpoint) return { ok: false, response: NextResponse.json({ error: "Endpoint not found" }, { status: 404 }) };
  return { ok: true, ctx: { user: gate.user, endpoint, docker: dockerFor(endpoint) } };
}

export function validRef(ref: string): boolean {
  return DOCKER_REF_RE.test(ref) && !ref.includes("..");
}

/** Turn a Docker error into a JSON response with a sensible status. */
export function dockerError(err: unknown): NextResponse {
  const status = dockerStatusCode(err);
  const code = status && status >= 400 && status < 500 ? status : 502;
  return NextResponse.json({ error: dockerErrorMessage(err) }, { status: code });
}
