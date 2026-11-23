import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import { collectFamilies, render } from "@/lib/prometheus";

/**
 * Prometheus metrics. Scrape with an API token:
 *   authorization: { type: Bearer, credentials: dn_… }   metrics_path: /api/metrics
 */
export async function GET() {
  const gate = await requireUser("monitoring.view");
  if (!gate.ok) return gate.response;
  const { user } = gate;
  const body = render(
    await collectFamilies({
      endpoint: (endpointId) => can(user, "endpoint.view", { endpointId }),
      project: (projectId) => can(user, "project.view", { projectId }),
    }),
  );
  return new NextResponse(body, { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
}
