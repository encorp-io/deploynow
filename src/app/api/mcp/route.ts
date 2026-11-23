/**
 * DeployNow's MCP endpoint, reached at /mcp (rewritten here). Add it to Claude,
 * ChatGPT or any MCP client as a custom connector; the client signs in with
 * OAuth. A personal API token (dn_…) works too, for clients that take a header.
 */
import { NextResponse } from "next/server";
import { getCurrentUser, oauthBearer } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { issuerUrl, mcpEnabled, mcpResourceUrl, resourceMetadataUrl, SCOPE_NAMES } from "@/lib/oauth/config";
import { CORS, json, preflight } from "@/lib/oauth/http";
import { handleRpc, PROTOCOL_VERSIONS } from "@/lib/mcp/server";

const MAX_BODY = 1_000_000;

function unauthorized(request: Request, error?: string) {
  const parts = [`Bearer realm="DeployNow"`, `resource_metadata="${resourceMetadataUrl(request)}"`, `scope="${SCOPE_NAMES.join(" ")}"`];
  if (error) parts.push(`error="${error}"`, `error_description="The access token is missing, expired or revoked"`);
  return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": parts.join(", ") });
}

export async function POST(request: Request) {
  if (!mcpEnabled()) return json({ error: "AI connectors are turned off on this server" }, 404);
  const header = request.headers.get("authorization");
  const user = await getCurrentUser();
  if (!user) return unauthorized(request, header ? "invalid_token" : undefined);
  // A cookie session isn't enough here: MCP clients must present a token
  if (!user.tokenId) return unauthorized(request);
  // An OAuth token is only good for the resource it was issued for (RFC 8707)
  if (oauthBearer(header) && user.oauth?.resource !== mcpResourceUrl(request)) return unauthorized(request, "invalid_token");

  const version = request.headers.get("mcp-protocol-version");
  if (version && !PROTOCOL_VERSIONS.includes(version)) return json({ error: `Unsupported MCP-Protocol-Version ${version}` }, 400);

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const first = (Array.isArray(body) ? body[0] : body) as { method?: string } | undefined;
  if (first?.method === "initialize") {
    await audit({ actor: { id: user.id, email: user.email }, ip: clientIp(request), action: "mcp.connect", targetType: "mcp", message: `${user.email} opened an AI session via ${user.oauth?.clientName ?? "an API token"}` });
  }
  const result = await handleRpc(body, user, { request, origin: issuerUrl(request) });
  if (result === null) return new NextResponse(null, { status: 202, headers: CORS });
  return json(result);
}

/** No server-initiated stream: this server only answers requests. */
export async function GET() {
  return new NextResponse(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
}

/** Stateless: there is no session to end. */
export async function DELETE() {
  return new NextResponse(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
}

export const OPTIONS = preflight;
