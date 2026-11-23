/**
 * The OAuth consent screen. An AI app (Claude, ChatGPT, …) sends the person
 * here; they pick how much the app may do, and we send them back with a code.
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/apiAuth";
import { issuerUrl, maxConnectionRole, mcpEnabled, mcpResourceUrl, SCOPES } from "@/lib/oauth/config";
import { checkAuthorizeRequest } from "@/lib/oauth/server";
import { roleAtLeast } from "@/lib/rbac";
import ConsentForm from "./ConsentForm";

export const dynamic = "force-dynamic";

function Problem({ text }: { text: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-bg-card border border-border rounded-xl p-6 space-y-2">
        <h1 className="text-lg font-semibold text-text-primary">Can&apos;t connect this app</h1>
        <p className="text-sm text-text-secondary">{text}</p>
        <a href="/" className="text-sm text-accent">Back to DeployNow</a>
      </div>
    </div>
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
