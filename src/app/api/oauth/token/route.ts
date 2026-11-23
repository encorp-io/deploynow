import { clientIp, audit } from "@/lib/audit";
import { authenticateClient, OAuthError } from "@/lib/oauth/clients";
import { mcpEnabled, mcpResourceUrl } from "@/lib/oauth/config";
import { formBody, json, oauthError, preflight } from "@/lib/oauth/http";
import { exchangeCode, refreshTokens } from "@/lib/oauth/server";

/** OAuth token endpoint: authorization_code (with PKCE) and refresh_token. */
export async function POST(request: Request) {
  if (!mcpEnabled()) return json({ error: "access_denied", error_description: "AI connectors are turned off on this server" }, 403);
  const body = await formBody(request);
  const resource = mcpResourceUrl(request);
  try {
    const client = await authenticateClient(request, body);
    const grantType = body.get("grant_type");
    if (grantType === "authorization_code") return json(await exchangeCode(client, body, resource));
    if (grantType === "refresh_token") return json(await refreshTokens(client, body, resource));
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  } catch (err) {
    if (err instanceof OAuthError && /already used/.test(err.message)) {
      await audit({ ip: clientIp(request), action: "oauth.token_replay", outcome: "failure", message: `A used ${body.get("grant_type") === "refresh_token" ? "refresh token" : "authorization code"} was presented again; the connection's tokens were revoked` });
    }
    return oauthError(err);
  }
}

export const OPTIONS = preflight;
