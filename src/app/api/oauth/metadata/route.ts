import { issuerUrl, mcpEnabled, SCOPE_NAMES } from "@/lib/oauth/config";
import { json, preflight } from "@/lib/oauth/http";

/** RFC 8414 authorization server metadata, served at /.well-known/oauth-authorization-server. */
export async function GET(request: Request) {
  if (!mcpEnabled()) return json({ error: "AI connectors are turned off on this server" }, 404);
  const iss = issuerUrl(request);
  return json(
    {
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/api/oauth/token`,
      registration_endpoint: `${iss}/api/oauth/register`,
      revocation_endpoint: `${iss}/api/oauth/revoke`,
      scopes_supported: SCOPE_NAMES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${iss}/account#ai-connections`,
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  );
}

export const OPTIONS = preflight;
