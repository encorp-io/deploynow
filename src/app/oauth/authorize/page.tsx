/**
 * The OAuth consent screen. An AI app (Claude, ChatGPT, …) sends the person
 * here; they pick how much the app may do, and we send them back with a code.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/apiAuth";
import { issuerUrl, maxConnectionRole, mcpEnabled, mcpResourceUrl, SCOPES } from "@/lib/oauth/config";
import { checkAuthorizeRequest, errorsMayRedirect } from "@/lib/oauth/server";
import { roleAtLeast } from "@/lib/rbac";
import ConsentForm from "./ConsentForm";
import AuthShell from "@/components/AuthShell";

export const dynamic = "force-dynamic";

function Problem({ text }: { text: string }) {
  return (
    <AuthShell title="Can't connect this app" subtitle={text}>
      <a href="/" className="block text-center text-sm text-accent hover:text-accent-hover">Back to DeployNow</a>
    </AuthShell>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string") params.set(k, v);
  const query = params.toString();

  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  if (!mcpEnabled()) return <Problem text="AI connectors are turned off on this DeployNow server." />;
  if (user.tokenId) return <Problem text="Open this page in a browser where you're signed in to DeployNow." />;

  const h = await headers();
  const ctx = { issuer: issuerUrl({ headers: h }), mcpResource: mcpResourceUrl({ headers: h }) };
  const check = await checkAuthorizeRequest(params, ctx);
  if (!check.ok) {
    if ("fatal" in check) return <Problem text={check.fatal} />;
    if (!(await errorsMayRedirect(user.id, check.clientId))) return <Problem text={`The app sent a request DeployNow can't accept: ${check.description}`} />;
    redirect(check.redirect);
  }
  const { req } = check;
  const max = maxConnectionRole(user);
  const options = SCOPES.filter((s) => roleAtLeast(max, s.role)).map((s) => ({ role: s.role, label: s.label, text: s.text }));
  const asked = req.requestedRole && roleAtLeast(max, req.requestedRole) ? req.requestedRole : "viewer";
  let returnTo = req.redirectUri;
  try {
    const u = new URL(req.redirectUri);
    returnTo = u.protocol === "https:" || u.protocol === "http:" ? u.host : u.protocol.replace(/:$/, "") + " app";
  } catch {
    /* keep the raw value */
  }

  return (
    <ConsentForm
      query={query}
      clientName={req.client.name}
      clientUri={req.client.clientUri}
      returnTo={returnTo}
      email={user.email}
      options={options}
      initialRole={asked}
      server={new URL(ctx.issuer).host}
    />
  );
}
