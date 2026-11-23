import { NextResponse } from "next/server";
import { requireUser } from "@/lib/apiAuth";
import { audit, clientIp } from "@/lib/audit";
import { mcpEnabled, mcpResourceUrl } from "@/lib/oauth/config";
import { listGrants, revokeGrant } from "@/lib/oauth/server";

/** Your connected AI apps, and the MCP address to add DeployNow to one. */
export async function GET(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  if (gate.user.tokenId) return NextResponse.json({ error: "Not available with a token" }, { status: 403 });
  return NextResponse.json({ enabled: mcpEnabled(), mcpUrl: mcpResourceUrl(request), connections: await listGrants(gate.user.id) });
}

/** DELETE ?id=<connection>: the app's tokens stop working at once. */
export async function DELETE(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { user } = gate;
  if (user.tokenId) return NextResponse.json({ error: "Not available with a token" }, { status: 403 });
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^c[a-z0-9]{24}$/.test(id)) return NextResponse.json({ error: "Invalid connection id" }, { status: 400 });
  const g = await revokeGrant(id, user.id);
  if (!g) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  await audit({ actor: { id: user.id, email: user.email }, ip: clientIp(request), action: "oauth.revoke", targetType: "oauth_grant", targetId: id, message: `${user.email} disconnected ${g.client.name}` });
  return NextResponse.json({ revoked: true });
}
