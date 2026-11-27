import { NextResponse } from "next/server";
import { endpointGate, dockerError, validRef, containerGuard } from "@/lib/endpointRoute";
import { readJson } from "@/lib/apiAuth";
import { issueExecTicket, ALLOWED_SHELLS } from "@/lib/execTicket";

/**
 * POST …/exec { shell } → { ticket, wsUrl }
 * The browser opens `${wsUrl}?ticket=…` within 30 seconds.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = await params;
  if (!validRef(cid)) return NextResponse.json({ error: "Invalid container id" }, { status: 400 });
  const gate = await endpointGate(id, "container.exec");
  if (!gate.ok) return gate.response;
  const { user, docker } = gate.ctx;

  const body = await readJson(request);
  const shell = typeof body.shell === "string" ? body.shell : "/bin/sh";
  if (!(ALLOWED_SHELLS as readonly string[]).includes(shell)) {
    return NextResponse.json({ error: `Shell must be one of ${ALLOWED_SHELLS.join(", ")}` }, { status: 400 });
  }

  try {
    const info = await docker.getContainer(cid).inspect();
    const guard = containerGuard(user, id, info, "exec");
    if (guard.response) return guard.response;
    if (!info.State.Running) return NextResponse.json({ error: "The container is not running" }, { status: 409 });
    const ticket = issueExecTicket({
      uid: user.id,
      email: user.email,
      sid: user.sid,
      endpointId: id,
      containerId: info.Id,
      shell,
    });
    return NextResponse.json({ ticket, wsUrl: process.env.WS_PUBLIC_PATH || "/ws/exec" });
  } catch (err) {
    return dockerError(err);
  }
}
