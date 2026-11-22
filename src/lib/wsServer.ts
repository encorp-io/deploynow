/**
 * WebSocket server for interactive container consoles.
 *
 * Next.js route handlers can't upgrade to WebSockets, so this listens on a
 * loopback port (WS_PORT, default 3002) and nginx forwards /ws/ to it.
 *
 * Protocol: the client sends JSON text frames, {"t":"i","d":"<input>"} for
 * keystrokes and {"t":"r","c":<cols>,"r":<rows>} for resizes; the server sends
 * raw terminal output as binary frames.
 */
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { redeemExecTicket, ALLOWED_SHELLS } from "./execTicket";
import { prisma } from "./prisma";
import { can } from "./rbac";
import { dockerFor } from "./endpoints";
import { audit } from "./audit";
import { dockerErrorMessage } from "./docker/client";

let server: WebSocketServer | null = null;

/** Accept the browser only if it came from our own origin. */
export function originAllowed(req: Pick<IncomingMessage, "headers">): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients still need a valid ticket
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function handleConnection(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url ?? "", "http://localhost");
  const ticket = redeemExecTicket(url.searchParams.get("ticket") ?? "");
  if (!ticket || !originAllowed(req) || !(ALLOWED_SHELLS as readonly string[]).includes(ticket.shell)) {
    ws.close(4401, "Unauthorized");
    return;
  }

  // Re-check the session and permission at connect time
  const [session, user, endpoint] = await Promise.all([
    prisma.session.findUnique({ where: { id: ticket.sid } }),
    prisma.user.findUnique({ where: { id: ticket.uid }, include: { roleBindings: true } }),
    prisma.endpoint.findUnique({ where: { id: ticket.endpointId } }),
  ]);
  if (!session || session.revokedAt || session.expiresAt < new Date() || !user || user.disabledAt || !endpoint) {
    ws.close(4401, "Unauthorized");
    return;
  }
  if (!can({ role: user.role, bindings: user.roleBindings }, "container.exec", { endpointId: endpoint.id })) {
    ws.close(4403, "Forbidden");
    return;
  }

  const ip = ((req.headers["x-forwarded-for"] as string) || "").split(",")[0].trim();
  const actor = { id: user.id, email: user.email };
  const started = Date.now();
  let stream: Duplex | null = null;

  try {
    const container = dockerFor(endpoint).getContainer(ticket.containerId);
    const exec = await container.exec({
      Cmd: [ticket.shell],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ["TERM=xterm-256color"],
    });
    stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as Duplex;

    await audit({
      actor,
      ip,
      action: "container.exec",
      message: `${user.email} opened a console (${ticket.shell}) in ${ticket.containerId.slice(0, 12)} on ${endpoint.name}`,
      targetType: "container",
      targetId: ticket.containerId,
      endpointId: endpoint.id,
    });

    stream.on("data", (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    stream.on("end", () => ws.close(1000, "Session ended"));
    stream.on("error", () => ws.close(1011, "Stream error"));

    ws.on("message", (raw) => {
      let msg: { t?: string; d?: string; c?: number; r?: number };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === "i" && typeof msg.d === "string") stream?.write(msg.d);
      if (msg.t === "r" && Number.isInteger(msg.c) && Number.isInteger(msg.r)) {
        exec.resize({ w: Math.min(500, msg.c!), h: Math.min(200, msg.r!) }).catch(() => {});
      }
    });
  } catch (err) {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(`\r\nCould not start a shell: ${dockerErrorMessage(err)}\r\n`));
    ws.close(1011, "Exec failed");
    return;
  }

  ws.on("close", () => {
    stream?.end();
    audit({
      actor,
      ip,
      action: "container.exec_end",
      message: `${user.email} closed the console in ${ticket.containerId.slice(0, 12)} after ${Math.round((Date.now() - started) / 1000)}s`,
      targetType: "container",
      targetId: ticket.containerId,
      endpointId: endpoint.id,
    });
  });
}

export function startWsServer(port = Number(process.env.WS_PORT || 3002), host = process.env.WS_HOST || "127.0.0.1") {
  if (server) return server;
  server = new WebSocketServer({ port, host, path: "/ws/exec", maxPayload: 64 * 1024 });
  server.on("connection", (ws, req) => {
    handleConnection(ws, req).catch(() => ws.close(1011, "Internal error"));
  });
  server.on("error", (err) => console.error("[ws] server error:", err.message));
  console.log(`[deployer] Console WebSocket listening on ${host}:${port}`);
  return server;
}
