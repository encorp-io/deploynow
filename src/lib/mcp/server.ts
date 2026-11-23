/**
 * A stateless MCP server over Streamable HTTP (JSON responses, no SSE stream).
 *
 * Every POST is one JSON-RPC message (or a batch, for 2025-03-26 clients) and
 * gets one JSON answer. There are no sessions: each request carries its own
 * bearer token, so any DeployNow replica can answer it.
 */
import { audit, clientIp } from "../audit";
import type { CurrentUser } from "../apiAuth";
import { auditArgs, ToolError, toolsFor, type ToolContext } from "./tools";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
const VERSION = "2.0";

const INSTRUCTIONS = `DeployNow manages Docker hosts ("endpoints"), apps grouped in projects and environments, deployments, backups and scheduled tasks.
Start with list_endpoints or list_projects to find ids. Deploys and backups run in the background: they return an id to follow with get_deployment or get_backup_run.
Confirm with the user before stopping or killing containers, rolling back, or changing environment variables. Secret values are never shown, even to admins.
You act as the person who connected you, limited to the access they granted; a 403 means that person or this connection may not do it.`;

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type RpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const ok = (id: RpcRequest["id"], result: unknown): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: RpcRequest["id"], code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function negotiateVersion(asked: unknown): string {
  return typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
}

async function handleOne(msg: RpcRequest, user: CurrentUser, ctx: ToolContext): Promise<RpcResponse | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(msg?.id, -32600, "Invalid JSON-RPC request");
  }
  const isNotification = msg.id === undefined;
  // Notifications (initialized, cancelled, …) need no answer
  if (isNotification) return null;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "deploynow", title: "DeployNow", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: toolsFor(user).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: !!t.destructive, idempotentHint: t.readOnly, openWorldHint: false },
        })),
      });
    case "tools/call":
      return ok(msg.id, await callTool(String(params.name ?? ""), (params.arguments as Record<string, unknown>) ?? {}, user, ctx));
    case "resources/list":
      return ok(msg.id, { resources: [] });
    case "prompts/list":
      return ok(msg.id, { prompts: [] });
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>, user: CurrentUser, ctx: ToolContext) {
  const tool = toolsFor(user).find((t) => t.name === name);
  const via = user.oauth?.clientName ?? "an API token";
  const base = { actor: { id: user.id, email: user.email }, ip: clientIp(ctx.request), action: "mcp.tool_call", targetType: "mcp_tool", targetId: name };
  if (!tool) {
    await audit({ ...base, outcome: "failure", message: `${user.email} tried unknown or unavailable AI tool ${name.slice(0, 80)} via ${via}` });
    return { isError: true, content: [{ type: "text", text: `Unknown tool or not allowed for this connection: ${name}` }] };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
  try {
    const data = await tool.run(args, ctx);
    await audit({ ...base, message: `${user.email} ran ${name} via ${via}`, details: auditArgs(name, args) });
    const text = JSON.stringify(data, null, 1) ?? "null";
    return {
      content: [{ type: "text", text: text.length > 200_000 ? text.slice(0, 200_000) + "\n…(truncated)" : text }],
      ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data } : {}),
    };
  } catch (err) {
    const message = err instanceof ToolError ? err.message : "Internal error";
    if (!(err instanceof ToolError)) console.error(`[mcp] ${name} failed:`, err instanceof Error ? err.message : err);
    await audit({ ...base, outcome: "failure", message: `${user.email} ran ${name} via ${via}: ${message}`.slice(0, 1000), details: auditArgs(name, args) });
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/** Handle a parsed POST body: one message or a batch. Returns null when there's nothing to send back (202). */
export async function handleRpc(body: unknown, user: CurrentUser, ctx: ToolContext): Promise<RpcResponse | RpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (!body.length) return fail(null, -32600, "Empty batch");
    const out = (await Promise.all(body.slice(0, 50).map((m) => handleOne(m as RpcRequest, user, ctx)))).filter((r): r is RpcResponse => r !== null);
    return out.length ? out : null;
  }
  return handleOne(body as RpcRequest, user, ctx);
}
