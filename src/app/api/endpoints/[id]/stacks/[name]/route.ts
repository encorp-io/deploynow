import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { endpointGate, dockerError } from "@/lib/endpointRoute";
import { readJson } from "@/lib/apiAuth";
import { withTimeout } from "@/lib/docker/client";
import { audit, clientIp } from "@/lib/audit";
import { groupExternal, pickGroup, STACK_RE, STANDALONE } from "@/lib/externalContainers";
import { externalAllowed } from "@/lib/externalAccess";
import { containerKind, protectionAllows } from "@/lib/containerProtection";

type Params = { params: Promise<{ id: string; name: string }> };

const ACTIONS = ["start", "stop", "restart"] as const;
type Action = (typeof ACTIONS)[number];

function validStack(name: string) {
  return name === STANDALONE || STACK_RE.test(name);
}

async function load(id: string, name: string, permission: "container.inspect" | "container.control") {
  const gate = await endpointGate(id, permission);
  if (!gate.ok) return gate;
  const apps = await prisma.application.findMany({ where: { endpointId: id }, select: { id: true, slug: true } });
  const list = await withTimeout(gate.ctx.docker.listContainers({ all: true }), 20_000, "Listing containers");
  const groups = groupExternal(list, new Set(apps.map((a) => a.id)), new Map(apps.map((a) => [a.slug, a.id])));
  return { ...gate, groups, containers: pickGroup(groups, name) };
}

/** One external compose stack (or the standalone containers) on an endpoint. */
export async function GET(_req: Request, { params }: Params) {
  const { id, name } = await params;
  if (!validStack(name)) return NextResponse.json({ error: "Invalid stack name" }, { status: 400 });
  try {
    const res = await load(id, name, "container.inspect");
    if (!res.ok) return res.response;
    if (!res.containers) return NextResponse.json({ error: "That stack has no containers left on this endpoint" }, { status: 404 });
    const stack = name === STANDALONE ? null : res.groups.stacks.find((s) => s.name === name)!;
    return NextResponse.json({
      endpoint: { id: res.ctx.endpoint.id, name: res.ctx.endpoint.name },
      name,
      standalone: name === STANDALONE,
      workingDir: stack?.workingDir ?? null,
      configFiles: stack?.configFiles ?? null,
      appId: stack?.appId ?? null,
      containers: res.containers,
      allowed: { ...externalAllowed(res.ctx.user, id), adopt: !!stack && !stack.appId && !stack.containers.some((c) => c.leftover) && externalAllowed(res.ctx.user, id).adopt },
    });
  } catch (err) {
    return dockerError(err);
  }
}

/** Start, stop or restart every container of a compose stack. */
export async function POST(request: Request, { params }: Params) {
  const { id, name } = await params;
  if (name === STANDALONE || !STACK_RE.test(name)) return NextResponse.json({ error: "Invalid stack name" }, { status: 400 });
  const { action } = await readJson(request);
  if (!ACTIONS.includes(action as Action)) return NextResponse.json({ error: `Action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });
  try {
    const res = await load(id, name, "container.control");
    if (!res.ok) return res.response;
    if (!res.containers?.length) return NextResponse.json({ error: "That stack has no containers left on this endpoint" }, { status: 404 });
    const { docker, user, endpoint } = res.ctx;
    const failed: string[] = [];
    let done = 0;
    for (const row of res.containers) {
      const c = docker.getContainer(row.id);
      try {
        const info = await c.inspect();
        // groupExternal already left out DeployNow's own containers; check again on the live inspect
        if (!protectionAllows(user, id, containerKind(info), "control")) {
          failed.push(`${row.name}: protected`);
          continue;
        }
        if (action === "start" && !info.State.Running) await c.start();
        else if (action === "stop" && info.State.Running) await c.stop({ t: 10 });
        else if (action === "restart") await c.restart({ t: 10 });
        done++;
      } catch (err) {
        failed.push(`${row.name}: ${(err as Error).message}`);
      }
    }
    await audit({
      actor: { id: user.id, email: user.email },
      ip: clientIp(request),
      action: `stack.${action}`,
      message: `${user.email} ran ${action} on stack ${name} (${endpoint.name}): ${done} of ${res.containers.length} containers`,
      targetType: "stack",
      targetId: name,
      endpointId: id,
      outcome: failed.length ? "failure" : "success",
      details: failed.join("; ").slice(0, 2000) || undefined,
    });
    if (failed.length) return NextResponse.json({ error: `Could not ${action} ${failed.join(", ")}`, done }, { status: 502 });
    return NextResponse.json({ success: true, done });
  } catch (err) {
    return dockerError(err);
  }
}
