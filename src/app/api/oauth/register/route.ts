import { audit, clientIp } from "@/lib/audit";
import { OAuthError, registerClient } from "@/lib/oauth/clients";
import { mcpEnabled } from "@/lib/oauth/config";
import { json, oauthError, preflight } from "@/lib/oauth/http";

/** RFC 7591 dynamic client registration. Open by design: a person still has to approve the app. */
export async function POST(request: Request) {
  if (!mcpEnabled()) return json({ error: "access_denied", error_description: "AI connectors are turned off on this server" }, 403);
  let meta: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    meta = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "Send the client metadata as a JSON object" }, 400);
  }
  const ip = clientIp(request);
  try {
    const { row, response } = await registerClient(meta, ip);
    await audit({ ip, action: "oauth.client_register", targetType: "oauth_client", targetId: row.id, message: `An app registered for AI access: ${row.name}`, details: JSON.parse(row.redirectUris).join(", ") });
    return json(response, 201);
  } catch (err) {
    if (err instanceof OAuthError && err.status === 429) return json({ error: "invalid_client_metadata", error_description: err.message }, 429);
    return oauthError(err);
  }
}

export const OPTIONS = preflight;
