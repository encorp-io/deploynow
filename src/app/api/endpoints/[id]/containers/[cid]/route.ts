import { NextResponse } from "next/server";
import { endpointGate, dockerError, validRef } from "@/lib/endpointRoute";
import { readJson, requireStepUp } from "@/lib/apiAuth";
import { can } from "@/lib/rbac";
import { audit, clientIp } from "@/lib/audit";

type Params = { params: Promise<{ id: string; cid: string }> };

const ACTIONS = ["start", "stop", "restart", "pause", "unpause", "kill"] as const;
type Action = (typeof ACTIONS)[number];

export async function GET(_req: Request, { params }: Params) {
  const { id, cid } = await params;
  if (!validRef(cid)) return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  const gate = await endpointGate(id, "container.inspect");
  if (!gate.ok) return gate.response;
  const { docker, user } = gate.ctx;

  try {
    const i = await docker.getContainer(cid).inspect();
    const showEnv = can(user, "container.env", { endpointId: id });
    return NextResponse.json({
      id: i.Id,
      name: i.Name.replace(/^\//, ""),
      image: i.Config.Image,
      imageId: i.Image,
      created: i.Created,
      state: {
        status: i.State.Status,
        running: i.State.Running,
        startedAt: i.State.StartedAt,
        finishedAt: i.State.FinishedAt,
        exitCode: i.State.ExitCode,
        health: i.State.Health?.Status ?? null,
        restartCount: i.RestartCount,
      },
      cmd: [...(i.Config.Entrypoint ?? []), ...(i.Config.Cmd ?? [])].join(" "),
      restartPolicy: i.HostConfig.RestartPolicy?.Name ?? "no",
      tty: i.Config.Tty,
      // Env values can hold secrets: viewers see the names only
      env: (i.Config.Env ?? []).map((e) => {
        const idx = e.indexOf("=");
        const key = idx === -1 ? e : e.slice(0, idx);
        return { key, value: showEnv ? e.slice(idx + 1) : null };
      }),
      envHidden: !showEnv,
      ports: Object.entries(i.NetworkSettings?.Ports ?? {}).map(([port, bindings]) => ({
        container: port,
        host: (bindings ?? []).map((b) => `${b.HostIp || "0.0.0.0"}:${b.HostPort}`),
      })),
      mounts: (i.Mounts ?? []).map((m) => ({
        type: m.Type,
        source: m.Type === "volume" ? m.Name : m.Source,
        destination: m.Destination,
        readOnly: !m.RW,
      })),
      networks: Object.entries(i.NetworkSettings?.Networks ?? {}).map(([name, n]) => ({
        name,
        ip: n.IPAddress,
        aliases: n.Aliases ?? [],
      })),
      labels: i.Config.Labels ?? {},
    });
  } catch (err) {
    return dockerError(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  const { id, cid } = await params;
  if (!validRef(cid)) return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  const gate = await endpointGate(id, "container.control");
  if (!gate.ok) return gate.response;
  const { docker, user, endpoint } = gate.ctx;

  const { action } = await readJson(request);
  if (!ACTIONS.includes(action as Action)) {
    return NextResponse.json({ error: `Action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });
  }

  const c = docker.getContainer(cid);
  try {
    const name = (await c.inspect()).Name.replace(/^\//, "");
    switch (action as Action) {
      case "start": await c.start(); break;
      case "stop": await c.stop({ t: 10 }); break;
      case "restart": await c.restart({ t: 10 }); break;
      case "pause": await c.pause(); break;
      case "unpause": await c.unpause(); break;
      case "kill": await c.kill(); break;
    }
    await audit({
      actor: { id: user.id, email: user.email },
      ip: clientIp(request),
      action: `container.${action}`,
      message: `${user.email} ran ${action} on ${name} (${endpoint.name})`,
      targetType: "container",
      targetId: cid,
      endpointId: id,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return dockerError(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { id, cid } = await params;
  if (!validRef(cid)) return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  const gate = await endpointGate(id, "container.remove");
  if (!gate.ok) return gate.response;
  const { docker, user, endpoint } = gate.ctx;

  const stepUp = requireStepUp(user);
  if (stepUp) return stepUp;

  const url = new URL(request.url);
  const removeVolumes = url.searchParams.get("volumes") === "1";
  try {
    const c = docker.getContainer(cid);
    const name = (await c.inspect()).Name.replace(/^\//, "");
    await c.remove({ force: true, v: removeVolumes });
    await audit({
      actor: { id: user.id, email: user.email },
      ip: clientIp(request),
      action: "container.remove",
      message: `${user.email} removed container ${name} (${endpoint.name})${removeVolumes ? " with its anonymous volumes" : ""}`,
      targetType: "container",
      targetId: cid,
      endpointId: id,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    return dockerError(err);
  }
}
