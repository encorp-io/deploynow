import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, readJson } from "@/lib/apiAuth";
import { validateEndpointInput } from "@/lib/endpoints";
import { testConnection } from "@/lib/endpointTest";
import { ENDPOINT_ID_RE } from "@/lib/endpointRoute";

/** POST /api/endpoints/test: try a connection without saving it. */
export async function POST(request: Request) {
  const gate = await requireUser("endpoint.manage");
  if (!gate.ok) return gate.response;

  const body = await readJson(request);
  // When editing, fall back to the stored keys and pinned host key
  const existing =
    typeof body.id === "string" && ENDPOINT_ID_RE.test(body.id)
      ? await prisma.endpoint.findUnique({ where: { id: body.id } })
      : null;

  const { data, error } = validateEndpointInput(body, existing ?? undefined);
  if (!data) return NextResponse.json({ ok: false, error }, { status: 400 });

  const pinned = existing && existing.host === data.host && existing.port === data.port ? existing.hostKeyFingerprint : "";
  return NextResponse.json(await testConnection(data, pinned));
}
