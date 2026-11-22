import { NextResponse } from "next/server";
import { readJson } from "@/lib/apiAuth";
import { clientIp, audit } from "@/lib/audit";
import { appGate, serializeDeployment } from "@/lib/apps/access";
import { DeployBusyError, enqueueDeploy } from "@/lib/jobs";
import { SHA_RE } from "@/lib/deploy/git";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const gate = await appGate(id, "app.deploy");
  if (!gate.ok) return gate.response;
  const { app, user } = gate;
  const body = await readJson(request);
  const commitSha = typeof body.commitSha === "string" && body.commitSha.trim() ? body.commitSha.trim() : undefined;
  if (commitSha && (!SHA_RE.test(commitSha) || !app.gitRepo)) return NextResponse.json({ error: "Invalid commit" }, { status: 400 });
  try {
    const dep = await enqueueDeploy(id, { trigger: "manual", commitSha, actor: { id: user.id, email: user.email } });
    await audit({ actor: { id: user.id, email: user.email }, ip: clientIp(request), action: "app.deploy_queued", message: `${user.email} started a deployment of ${app.name}`, targetType: "application", targetId: id, endpointId: app.endpointId });
    return NextResponse.json(serializeDeployment(dep), { status: 202 });
  } catch (err) {
    if (err instanceof DeployBusyError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
