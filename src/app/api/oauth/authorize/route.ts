import { NextResponse } from "next/server";
import { readJson, requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { OAuthError } from "@/lib/oauth/clients";
import { issuerUrl, mcpEnabled, mcpResourceUrl, scopeForRole } from "@/lib/oauth/config";
import { approve, checkAuthorizeRequest, errorRedirect } from "@/lib/oauth/server";

/**
 * The consent screen's answer. Body: { query: the /oauth/authorize query string,
 * decision: "allow" | "deny", role: "viewer" | "operator" | "admin" }.
 * Returns { redirect } for the browser to follow back to the app.
 */
export async function POST(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  if (user.tokenId) return NextResponse.json({ error: "Approve AI connections while signed in to DeployNow" }, { status: 403 });
  if (!mcpEnabled()) return NextResponse.json({ error: "AI connectors are turned off on this server" }, { status: 403 });

  const body = await readJson(request);
  const ctx = { issuer: issuerUrl(request), mcpResource: mcpResourceUrl(request) };
  const check = await checkAuthorizeRequest(new URLSearchParams(String(body.query ?? "")), ctx);
  if (!check.ok) return "fatal" in check ? NextResponse.json({ error: check.fatal }, { status: 400 }) : NextResponse.json({ redirect: check.redirect });
  const { req } = check;
  const actor = { id: user.id, email: user.email };
  const ip = clientIp(request);

  if (body.decision !== "allow") {
    await audit({ actor, ip, action: "oauth.deny", targetType: "oauth_client", targetId: req.client.id, message: `${user.email} declined AI access for ${req.client.name}` });
    return NextResponse.json({ redirect: errorRedirect(req.redirectUri, "access_denied", "The person declined access", req.state, ctx.issuer) });
  }
  try {
    const { grant, redirect } = await approve(user, req, String(body.role ?? ""), ctx);
    await audit({
      actor,
      ip,
      action: "oauth.authorize",
      targetType: "oauth_grant",
      targetId: grant.id,
      message: `${user.email} connected ${req.client.name} with ${scopeForRole(grant.role).split(" ").pop()} access`,
      details: `redirect ${new URL(req.redirectUri).origin}`,
    });
    return NextResponse.json({ redirect });
  } catch (err) {
    if (err instanceof OAuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
