/**
 * GitHub push webhook: POST /api/webhooks/github/<appId>
 * Public (GitHub has no session); authenticated by the X-Hub-Signature-256
 * HMAC with the app's webhook secret.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit, clientIp } from "@/lib/audit";
import { ID_RE } from "@/lib/apps/access";
import { decryptSecret } from "@/lib/secretsCrypto";
import { DeployBusyError, enqueueDeploy } from "@/lib/jobs";
import { SHA_RE } from "@/lib/deploy/git";
import { verifySignature } from "@/lib/deploy/webhook";

type Params = { params: Promise<{ appId: string }> };

const MAX_BODY = 5 * 1024 * 1024;

export async function POST(request: Request, { params }: Params) {
  const { appId } = await params;
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  // Same answer for unknown apps and bad signatures, so app ids can't be probed
  const denied = () => NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  if (!ID_RE.test(appId)) return denied();
  const app = await prisma.application.findUnique({ where: { id: appId } });
  if (!app || !verifySignature(decryptSecret(app.webhookSecret), raw, request.headers.get("x-hub-signature-256"))) return denied();

  const event = request.headers.get("x-github-event");
  if (event === "ping") return NextResponse.json({ ok: true, message: "pong" });
  if (event !== "push") return NextResponse.json({ ok: true, ignored: `event ${event}` });

  let payload: { ref?: string; after?: string; deleted?: boolean; head_commit?: { message?: string } | null };
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (app.updatePolicy !== "on-push") return NextResponse.json({ ok: true, ignored: "auto-deploy on push is off for this app" });
  if (payload.deleted || payload.ref !== `refs/heads/${app.gitBranch}`) return NextResponse.json({ ok: true, ignored: `not ${app.gitBranch}` });
  const sha = payload.after ?? "";
  if (!SHA_RE.test(sha) || /^0+$/.test(sha)) return NextResponse.json({ ok: true, ignored: "no commit" });

  try {
    const dep = await enqueueDeploy(app.id, { trigger: "push", commitSha: sha, commitMessage: payload.head_commit?.message?.split("\n")[0] ?? "" });
    await audit({ action: "app.deploy_queued", message: `Push to ${app.gitBranch} (${sha.slice(0, 12)}) started a deployment of ${app.name}`, targetType: "application", targetId: app.id, endpointId: app.endpointId, ip: clientIp(request) });
    return NextResponse.json({ ok: true, deploymentId: dep.id }, { status: 202 });
  } catch (err) {
    if (err instanceof DeployBusyError) return NextResponse.json({ ok: true, ignored: "a deployment is already queued" });
    throw err;
  }
}
