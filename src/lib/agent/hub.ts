/**
 * Agent hub: the endpoint for deploynow-agent connections.
 *
 * An HTTPS server (default port 8444) with the hub's own CA:
 *   POST /enroll       one-time join token + CSR -> signed client certificate
 *   WS   /connect      control channel (client certificate required)
 *   WS   /stream?id=   one Docker connection, dialled back by the agent on request
 *
 * For every agent endpoint the hub listens on a private unix socket
 * (<data>/agents/<endpointId>.sock). Each connection to it becomes a stream to
 * the agent's local Docker socket, so dockerode, the console and the docker CLI
 * work exactly as they do for a local socket.
 */
import crypto from "crypto";
import fs from "fs";
import https from "https";
import net from "net";
import path from "path";
import type { TLSSocket } from "tls";
import { WebSocketServer, createWebSocketStream, type WebSocket } from "ws";
import { prisma } from "../prisma";
import { publicBaseUrl } from "../publicOrigin";
import { dataDir } from "../paths";
import { ensureHubPki, signAgentCsr, certFingerprint, CsrError } from "./pki";

export const AGENT_TYPE = "agent" as const;
const JOIN_TTL_MS = 60 * 60 * 1000;
const STREAM_WAIT_MS = 15_000;
const MAX_BODY = 64 * 1024;

interface AgentConn {
  ws: WebSocket;
  endpointId: string;
  connectedAt: Date;
  /** Open Docker streams carried for this connection; cut when it ends or is revoked */
  streams: Set<net.Socket>;
}

interface PendingStream {
  endpointId: string;
  socket: net.Socket;
  timer: ReturnType<typeof setTimeout>;
}

interface HubState {
  server: https.Server | null;
  port: number;
  agents: Map<string, AgentConn>;
  sockets: Map<string, net.Server>;
  pending: Map<string, PendingStream>;
}

// Route handlers and instrumentation can load separate copies of this module; share one state
const g = globalThis as unknown as { __deploynowAgentHub?: HubState };
const state: HubState = (g.__deploynowAgentHub ??= { server: null, port: 0, agents: new Map(), sockets: new Map(), pending: new Map() });

export function agentSocketPath(endpointId: string): string {
  return path.join(dataDir(), "agents", `${endpointId}.sock`);
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** A new one-time join token for an agent endpoint (replaces any earlier one). */
export async function createJoinToken(endpointId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = "dnj_" + crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + JOIN_TTL_MS);
  await prisma.endpoint.update({ where: { id: endpointId }, data: { agentJoinTokenHash: hashToken(token), agentJoinExpiresAt: expiresAt } });
  return { token, expiresAt };
}

/** The address agents dial when none is set in Settings: AGENT_PUBLIC_URL, else the public host (platform domain or AUTH_URL) on the agent port. */
export function defaultAgentUrl(): string {
  if (process.env.AGENT_PUBLIC_URL) return process.env.AGENT_PUBLIC_URL.replace(/\/+$/, "");
  const port = Number(process.env.AGENT_PORT ?? 8444) || 8444;
  try {
    const u = new URL(publicBaseUrl() ?? "");
    return `https://${u.hostname}:${port}`;
  } catch {
    return `https://<this-server>:${port}`;
  }
}

export async function agentPublicUrl(): Promise<string> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" } });
  return s?.agentPublicUrl || defaultAgentUrl();
}

export async function joinInfo(endpointId: string) {
  const pki = await ensureHubPki();
  const { token, expiresAt } = await createJoinToken(endpointId);
  const url = await agentPublicUrl();
  const ca = certFingerprint(pki.caCert);
  const image = process.env.AGENT_IMAGE || "ghcr.io/encorp-io/deploynow-agent:latest";
  const command = [
    "docker run -d --name deploynow-agent --restart unless-stopped",
    "  -v /var/run/docker.sock:/var/run/docker.sock",
    "  -v deploynow-agent:/data",
    `  -e DEPLOYNOW_URL=${url}`,
    `  -e DEPLOYNOW_TOKEN=${token}`,
    `  -e DEPLOYNOW_CA=${ca}`,
    `  ${image}`,
  ].join(" \\\n");
  return { url, token, caFingerprint: ca, expiresAt, command };
}

/** Close an agent's control connection and every stream it carries. */
function dropAgent(endpointId: string, code: number, reason: string) {
  const conn = state.agents.get(endpointId);
  if (!conn) return;
  state.agents.delete(endpointId);
  for (const s of conn.streams) s.destroy();
  conn.streams.clear();
  conn.ws.close(code, reason);
}

export function isAgentConnected(endpointId: string): boolean {
  return state.agents.has(endpointId);
}

/** Cut off an agent: forget its certificate, drop the connection and close its socket. */
export async function revokeAgent(endpointId: string): Promise<void> {
  await prisma.endpoint.update({
    where: { id: endpointId },
    data: { agentCertSerial: "", agentJoinTokenHash: "", agentJoinExpiresAt: null, status: "offline", lastError: "Agent revoked" },
  });
  dropAgent(endpointId, 4001, "revoked");
}

export function closeAgentSocket(endpointId: string) {
  const srv = state.sockets.get(endpointId);
  if (srv) srv.close();
  state.sockets.delete(endpointId);
  fs.rmSync(agentSocketPath(endpointId), { force: true });
  dropAgent(endpointId, 4002, "endpoint removed");
}

/** Listen on the endpoint's local Docker socket (idempotent). */
export async function ensureAgentSocket(endpointId: string): Promise<string> {
  const p = agentSocketPath(endpointId);
  if (state.sockets.has(endpointId)) return p;
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.rmSync(p, { force: true });
  const server = net.createServer((socket) => openStream(endpointId, socket));
  state.sockets.set(endpointId, server);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(p, () => resolve()));
  fs.chmodSync(p, 0o600);
  return p;
}

function openStream(endpointId: string, socket: net.Socket) {
  socket.on("error", () => socket.destroy());
  const agent = state.agents.get(endpointId);
  if (!agent) {
    socket.destroy();
    return;
  }
  const id = crypto.randomBytes(16).toString("hex");
  const timer = setTimeout(() => {
    state.pending.delete(id);
    socket.destroy();
  }, STREAM_WAIT_MS);
  state.pending.set(id, { endpointId, socket, timer });
  socket.on("close", () => {
    const p = state.pending.get(id);
    if (p) {
      clearTimeout(p.timer);
      state.pending.delete(id);
    }
  });
  agent.ws.send(JSON.stringify({ type: "open", id }), (err) => {
    if (err) socket.destroy();
  });
}

function normSerial(s: string): string {
  return s.replace(/^0+/, "").toUpperCase();
}

/** The agent endpoint a TLS client certificate belongs to, or null. */
async function endpointForPeer(sock: TLSSocket) {
  if (!sock.authorized) return null;
  const peer = sock.getPeerCertificate();
  const cn = peer?.subject?.CN;
  const serial = peer?.serialNumber;
  if (typeof cn !== "string" || !serial || !/^c[a-z0-9]{24}$/.test(cn)) return null;
  const endpoint = await prisma.endpoint.findUnique({ where: { id: cn } });
  if (!endpoint || endpoint.type !== AGENT_TYPE || !endpoint.agentCertSerial) return null;
  return normSerial(endpoint.agentCertSerial) === normSerial(serial) ? endpoint : null;
}

function json(res: import("http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleEnroll(req: import("http").IncomingMessage, res: import("http").ServerResponse) {
  let raw = "";
  let tooBig = false;
  req.on("data", (c: Buffer) => {
    raw += c.toString("utf8");
    if (raw.length > MAX_BODY) {
      tooBig = true;
      req.destroy();
    }
  });
  await new Promise<void>((r) => req.on("end", () => r()).on("close", () => r()));
  if (tooBig) return json(res, 413, { error: "Request too large" });
  let body: { token?: string; csr?: string; hostname?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return json(res, 400, { error: "Invalid JSON" });
  }
  const token = String(body.token ?? "");
  const endpoint = token ? await prisma.endpoint.findFirst({ where: { type: AGENT_TYPE, agentJoinTokenHash: hashToken(token) } }) : null;
  if (!endpoint || !endpoint.agentJoinExpiresAt || endpoint.agentJoinExpiresAt < new Date()) {
    return json(res, 401, { error: "The join token is invalid or has expired; create a new one in DeployNow" });
  }
  const pki = await ensureHubPki();
  try {
    const { cert, serial } = signAgentCsr(pki.caCert, pki.caKey, String(body.csr ?? ""), endpoint.id);
    // One-time: the token is consumed, and any earlier certificate stops working
    const won = await prisma.endpoint.updateMany({
      where: { id: endpoint.id, agentJoinTokenHash: hashToken(token) },
      data: { agentCertSerial: serial, agentJoinTokenHash: "", agentJoinExpiresAt: null, agentHostname: String(body.hostname ?? "").slice(0, 120), lastError: "" },
    });
    if (won.count !== 1) return json(res, 401, { error: "The join token was already used" });
    dropAgent(endpoint.id, 4003, "re-enrolled");
    await audit(endpoint.id, "agent.enroll", `Agent enrolled for endpoint ${endpoint.name}${body.hostname ? ` from host ${String(body.hostname).slice(0, 60)}` : ""}`, req);
    return json(res, 200, { cert, ca: pki.caCert, endpointId: endpoint.id });
  } catch (err) {
    if (err instanceof CsrError) return json(res, 400, { error: err.message });
    throw err;
  }
}

async function audit(endpointId: string, action: string, message: string, req?: import("http").IncomingMessage) {
  const { audit: write } = await import("../audit");
  await write({ action, message, targetType: "endpoint", targetId: endpointId, endpointId, ip: req?.socket.remoteAddress ?? "" });
}

async function onAgentConnected(endpointId: string, ws: WebSocket) {
  dropAgent(endpointId, 4004, "replaced by a new connection");
  const conn: AgentConn = { ws, endpointId, connectedAt: new Date(), streams: new Set() };
  state.agents.set(endpointId, conn);
  // Handlers go on before any await, so the agent's first messages aren't lost;
  // messages are processed in order, after the connection is recorded
  let chain: Promise<unknown> = (async () => {
    await ensureAgentSocket(endpointId);
    await prisma.endpoint.update({ where: { id: endpointId }, data: { status: "online", agentConnectedAt: conn.connectedAt, lastSeenAt: conn.connectedAt, lastError: "" } });
  })().catch(() => {});

  let alive = true;
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);
  ws.on("pong", () => (alive = true));

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    alive = true;
    chain = chain.then(() => handleMessage(data.toString())).catch(() => {});
  });

  async function handleMessage(text: string) {
    let msg: { type?: string; version?: string; hostname?: string; metrics?: Record<string, number | string> };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "hello") {
      await prisma.endpoint.update({
        where: { id: endpointId },
        data: { agentVersion: String(msg.version ?? "").slice(0, 40), agentHostname: String(msg.hostname ?? "").slice(0, 120) },
      }).catch(() => {});
      // Fill in Docker version, OS and container count through the new socket
      void import("../endpoints").then(async ({ refreshEndpoint }) => {
        const e = await prisma.endpoint.findUnique({ where: { id: endpointId } });
        if (e) await refreshEndpoint(e);
      }).catch(() => {});
    } else if (msg.type === "metrics" && msg.metrics && typeof msg.metrics === "object") {
      const m = msg.metrics;
      const clean = {
        cpus: Number(m.cpus) || 0,
        load1: Number(m.load1) || 0,
        load5: Number(m.load5) || 0,
        memTotal: Number(m.memTotal) || 0,
        memAvailable: Number(m.memAvailable) || 0,
        diskPath: String(m.diskPath ?? "").slice(0, 200),
        diskTotal: Number(m.diskTotal) || 0,
        diskFree: Number(m.diskFree) || 0,
      };
      await prisma.endpoint.update({
        where: { id: endpointId },
        data: { hostMetrics: JSON.stringify(clean), hostMetricsAt: new Date(), lastSeenAt: new Date(), cpus: clean.cpus || undefined, memoryBytes: clean.memTotal || undefined },
      }).catch(() => {});
    }
  }

  ws.on("close", async () => {
    clearInterval(ping);
    for (const s of conn.streams) s.destroy();
    conn.streams.clear();
    if (state.agents.get(endpointId) !== conn) return;
    state.agents.delete(endpointId);
    await chain;
    await prisma.endpoint.update({ where: { id: endpointId }, data: { status: "offline", lastError: "The agent disconnected" } }).catch(() => {});
  });
  ws.on("error", () => ws.terminate());
}

/** Start the hub (idempotent). Port 0 picks a free port (tests); AGENT_PORT=off disables it. */
export async function startAgentHub(port = Number(process.env.AGENT_PORT ?? 8444)): Promise<number> {
  if (state.server) return state.port;
  if (String(process.env.AGENT_PORT).toLowerCase() === "off") return 0;
  const pki = await ensureHubPki();
  const server = https.createServer({
    cert: pki.serverCert + pki.caCert,
    key: pki.serverKey,
    ca: pki.caCert,
    requestCert: true,
    rejectUnauthorized: false, // /enroll has no client certificate yet; /connect and /stream check it
    minVersion: "TLSv1.2",
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const streams = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "https://hub");
    if (req.method === "POST" && url.pathname === "/enroll") {
      handleEnroll(req, res).catch((err) => {
        console.error("[agent-hub] enroll failed:", err instanceof Error ? err.message : err);
        if (!res.headersSent) json(res, 500, { error: "Enrolment failed" });
      });
      return;
    }
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    json(res, 404, { error: "Not found" });
  });

  server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "/", "https://hub");
    const deny = (code: number) => {
      socket.write(`HTTP/1.1 ${code} ${code === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const endpoint = await endpointForPeer(socket as TLSSocket);
      if (!endpoint) return deny(401);
      if (url.pathname === "/connect") {
        wss.handleUpgrade(req, socket, head, (ws) => void onAgentConnected(endpoint.id, ws));
      } else if (url.pathname === "/stream") {
        const id = url.searchParams.get("id") ?? "";
        const pending = state.pending.get(id);
        if (!pending || pending.endpointId !== endpoint.id) return deny(404);
        state.pending.delete(id);
        clearTimeout(pending.timer);
        const conn = state.agents.get(endpoint.id);
        if (!conn) {
          pending.socket.destroy();
          return deny(404);
        }
        streams.handleUpgrade(req, socket, head, (ws) => {
          const duplex = createWebSocketStream(ws);
          const local = pending.socket;
          conn.streams.add(local);
          local.on("close", () => conn.streams.delete(local));
          duplex.on("error", () => local.destroy());
          local.on("close", () => duplex.destroy());
          duplex.on("close", () => local.destroy());
          local.pipe(duplex).pipe(local);
        });
      } else {
        deny(404);
      }
    } catch {
      deny(401);
    }
  });

  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "0.0.0.0", () => resolve()));
  state.server = server;
  state.port = (server.address() as net.AddressInfo).port;

  // Agents reconnect on their own; have their sockets ready
  const agents = await prisma.endpoint.findMany({ where: { type: AGENT_TYPE } });
  for (const e of agents) await ensureAgentSocket(e.id).catch(() => {});
  await prisma.endpoint.updateMany({ where: { type: AGENT_TYPE, status: "online" }, data: { status: "offline", lastError: "Waiting for the agent to reconnect" } });
  console.log(`[deployer] Agent hub listening on :${state.port}`);
  return state.port;
}

export async function stopAgentHub() {
  for (const a of state.agents.values()) {
    for (const s of a.streams) s.destroy();
    a.ws.terminate();
  }
  state.agents.clear();
  for (const id of [...state.sockets.keys()]) {
    state.sockets.get(id)?.close();
    fs.rmSync(agentSocketPath(id), { force: true });
  }
  state.sockets.clear();
  for (const p of state.pending.values()) {
    clearTimeout(p.timer);
    p.socket.destroy();
  }
  state.pending.clear();
  if (state.server) {
    state.server.closeAllConnections?.();
    await new Promise<void>((r) => state.server!.close(() => r()));
  }
  state.server = null;
  state.port = 0;
}
