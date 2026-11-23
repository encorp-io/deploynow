/** Response helpers for the OAuth and MCP endpoints that machines call. */
import { NextResponse } from "next/server";
import { OAuthError } from "./clients";

/**
 * These endpoints take no cookies, so any origin may call them; browser-based
 * MCP clients (MCP Inspector, web IDEs) need CORS to get through.
 */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export function preflight() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, { status, headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache", ...headers } });
}

export function oauthError(err: unknown) {
  if (err instanceof OAuthError) {
    return json({ error: err.code, error_description: err.message }, err.status, err.code === "invalid_client" ? { "WWW-Authenticate": 'Basic realm="DeployNow"' } : {});
  }
  throw err;
}

/** Token and revocation bodies are form-encoded; accept JSON too, which some clients send. */
export async function formBody(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text().catch(() => "");
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(obj ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}
