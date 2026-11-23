import { issuerUrl, mcpEnabled, mcpResourceUrl, SCOPE_NAMES } from "@/lib/oauth/config";
import { json, preflight } from "@/lib/oauth/http";

/** RFC 9728 protected resource metadata for /mcp, served at /.well-known/oauth-protected-resource[/mcp]. */
export async function GET(request: Request) {
  if (!mcpEnabled()) return json({ error: "AI connectors are turned off on this server" }, 404);
  return json(
    {
      resource: mcpResourceUrl(request),
      authorization_servers: [issuerUrl(request)],
      scopes_supported: SCOPE_NAMES,
      bearer_methods_supported: ["header"],
      resource_name: "DeployNow",
      resource_documentation: `${issuerUrl(request)}/account#ai-connections`,
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  );
}

export const OPTIONS = preflight;
