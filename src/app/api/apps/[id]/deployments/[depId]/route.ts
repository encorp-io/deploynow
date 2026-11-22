import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { appGate, ID_RE, notFound, serializeDeployment } from "@/lib/apps/access";
import { readLog } from "@/lib/deploy/log";
import { cancelDeployment, DeployBusyError, enqueueDeploy } from "@/lib/jobs";
import { can } from "@/lib/rbac";

type Params = { params: Promise<{ id: string; depId: string }> };

async function load(appId: string, depId: string) {
  if (!ID_RE.test(depId)) return null;
  const dep = await prisma.deployment.findUnique({ where: { id: depId } });
  return dep && dep.applicationId === appId ? dep : null;
}

/** The deployment and its log from ?offset= (bytes); poll with the returned `next`. */
export async function GET(request: Request, { params }: Params) {
  const { id, depId } = await params;
  const gate = await appGate(id, "project.view");
  if (!gate.ok) return gate.response;
  const dep = await load(id, depId);
  if (!dep) return notFound("Deployment");
  const offset = Math.max(0, Number(new URL(request.url).searchParams.get("offset")) || 0);
  const log = can(gate.user, "app.logs", { projectId: gate.app.environment.projectId }) ? readLog(dep.id, offset) : { text: "", next: 0 };
  return NextResponse.json({ ...serializeDeployment(dep), log: log.text, next: log.next });
}

/** {action: "cancel" | "rollback" | "redeploy"} */
export async function POST(request: Request, { params }: Params) {
  const { id, depId } = await params;
  const gate = await appGate(id, "app.deploy");
  if (!gate.ok) return gate.response;
  const { app, user } = gate;
  const dep = await load(id, depId);
  if (!dep) return notFound("Deployment");
  const body = await readJson(request);
  const actor = { id: user.id, email: user.email };
  const ip = clientIp(request);

  if (body.action === "cancel") {
    const r = await cancelDeployment(dep.id);
    await audit({ actor, ip, action: "app.deploy_cancel", message: `${user.email} cancelled a deployment of ${app.name}`, targetType: "application", targetId: id, endpointId: app.endpointId });
    return NextResponse.json({ result: r });
  }
  if (body.action === "rollback" || body.action === "redeploy") {
    if (dep.status !== "success") return NextResponse.json({ error: "Only a successful deployment can be rolled back to" }, { status: 400 });
    try {
      const next = await enqueueDeploy(id, {
        trigger: body.action === "rollback" ? "rollback" : "redeploy",
        rollbackOfId: dep.id,
        commitSha: dep.commitSha || undefined,
        commitMessage: dep.commitMessage,
        actor,
      });
      await audit({ actor, ip, action: "app.rollback_queued", message: `${user.email} rolled ${app.name} back to deployment ${dep.id.slice(-8)}`, targetType: "application", targetId: id, endpointId: app.endpointId });
      return NextResponse.json(serializeDeployment(next), { status: 202 });
    } catch (err) {
      if (err instanceof DeployBusyError) return NextResponse.json({ error: err.message }, { status: 409 });
      throw err;
    }
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
