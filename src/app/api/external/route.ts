import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import { dockerFor } from "@/lib/endpoints";
import { dockerErrorMessage, withTimeout } from "@/lib/docker/client";
import { groupExternal, type ExternalGroups } from "@/lib/externalContainers";
import { externalAllowed, type ExternalAllowed } from "@/lib/externalAccess";

interface EndpointExternal extends ExternalGroups {
  id: string;
  name: string;
  status: string;
  error: string | null;
  allowed: ExternalAllowed;
}

/** Containers DeployNow doesn't manage, per endpoint the caller can see: compose stacks and standalone containers. */
export async function GET() {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const endpoints = (await prisma.endpoint.findMany({ orderBy: { name: "asc" } })).filter((e) => can(gate.user, "container.inspect", { endpointId: e.id }));
  const apps = await prisma.application.findMany({ select: { id: true, slug: true, endpointId: true } });
  const appIds = new Set(apps.map((a) => a.id));

  const out: EndpointExternal[] = await Promise.all(
    endpoints.map(async (e) => {
      const base = { id: e.id, name: e.name, status: e.status, allowed: externalAllowed(gate.user, e.id) };
      if (e.status === "offline") return { ...base, error: e.lastError || "The endpoint is offline", stacks: [], standalone: [] };
      try {
        const list = await withTimeout(dockerFor(e).listContainers({ all: true }), 8_000, "Listing containers");
        return { ...base, error: null, ...groupExternal(list, appIds, new Map(apps.filter((a) => a.endpointId === e.id).map((a) => [a.slug, a.id]))) };
      } catch (err) {
        return { ...base, error: dockerErrorMessage(err), stacks: [], standalone: [] };
      }
    }),
  );
  return NextResponse.json({ endpoints: out });
}
