"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, ExternalLink, Globe, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { useApi } from "@/components/AppShell";
import { useConfirm, useToast } from "@/components/feedback";
import { Badge, Button, ErrorText, Field, Input } from "@/components/ui";

interface DomainData {
  domain: string;
  active: string;
  ignored: boolean;
  envOrigin: string | null;
  currentOrigin: string;
  fallbackPort: number;
  route: { present: boolean; running: boolean; domains: string[]; endpointName: string; proxyMode: string; error: string };
  passkeys: number;
}

interface CheckResult {
  domain: string;
  addresses: string[];
  reachable: boolean;
  certificateValid: boolean;
  message: string;
  stage: string;
  error?: string;
  canForce?: boolean;
  needsConfirm?: boolean;
  passkeysOffDomain?: number;
  activated?: boolean;
  url?: string;
}

/** Settings → Domain: serve DeployNow itself on a domain through Traefik. */
export function PlatformDomainSettings() {
  const api = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const [data, setData] = useState<DomainData | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"" | "check" | "activate" | "remove">("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const r = await api<DomainData>("/api/settings/domain");
    if (r.ok) {
      setData(r.data);
      setInput((v) => v || r.data.domain);
    } else setError(r.data.error ?? "Couldn't load the domain settings");
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return error ? <ErrorText>{error}</ErrorText> : null;

  const run = async (action: "check" | "activate", extra: { force?: boolean; confirmPasskeys?: boolean } = {}) => {
    setBusy(action);
    setError("");
    if (action === "check" || !extra.confirmPasskeys) setResult(null);
    const r = await api<CheckResult>("/api/settings/domain", { method: "POST", body: { action, domain: input, ...extra } });
    setBusy("");
    if (!r.ok && r.status !== 422 && !r.data.needsConfirm) return setError(r.data.error ?? "Couldn't use that domain");
    setResult(r.data);
    if (r.data.needsConfirm) {
      const ok = await confirm({
        title: "Passkeys won't carry over",
        message: `${r.data.passkeysOffDomain} passkey(s) were added at another address. A passkey only works on the address it was added on, so after the switch they'll work only at that old address. Sign in at ${r.data.domain} with your password and add a new passkey there.`,
        confirmLabel: `Switch to ${r.data.domain}`,
        danger: false,
      });
      if (ok) return run("activate", { ...extra, confirmPasskeys: true });
      return;
    }
    if (r.data.activated) {
      toast.success(`DeployNow now uses ${r.data.domain}`);
      load();
    }
  };

  const remove = async () => {
    if (!(await confirm({ title: `Stop using ${data.domain}?`, message: `Links, sign-in callbacks and new agent commands go back to ${data.envOrigin ?? "the address each visitor uses"}, and Traefik stops routing ${data.domain}.`, confirmLabel: "Remove domain" }))) return;
    setBusy("remove");
    const r = await api<{ warning?: string }>("/api/settings/domain", { method: "DELETE" });
    setBusy("");
    if (!r.ok) return setError(r.data.error ?? "Couldn't remove the domain");
    if (r.data.warning) toast.error(r.data.warning);
    else toast.success("Domain removed");
    setInput("");
    setResult(null);
    load();
  };

  const onDomain = data.active && new URL(data.currentOrigin).hostname === data.active;
  const proxyMissing = data.route.proxyMode === "none";
  const changed = input.trim().toLowerCase() !== data.domain;

  return (
    <section className="bg-bg-card border border-border rounded-xl p-6">
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2">
        <Globe className="w-4 h-4" /> Platform domain
      </h2>
      <p className="text-xs text-text-muted mb-4">
        Serve DeployNow on your own domain, such as <code className="text-accent">deploy.example.com</code>, with a Let&apos;s Encrypt certificate from the edge proxy
        {data.route.endpointName ? ` on ${data.route.endpointName}` : ""}. Sign-in callbacks, webhook URLs, agent commands, invite and notification links all use it.
      </p>

      <div className="space-y-4">
        <div className="text-sm">
          {data.active ? (
            <p className="flex flex-wrap items-center gap-2 text-text-primary">
              <a href={`https://${data.active}`} className="text-accent hover:underline inline-flex items-center gap-1">
                https://{data.active} <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <Badge tone={data.route.running && data.route.domains.includes(data.active) ? "success" : "warning"}>
                {data.route.running && data.route.domains.includes(data.active) ? "Routed" : "Route missing"}
              </Badge>
            </p>
          ) : (
            <p className="text-text-secondary">
              {data.ignored ? (
                <>
                  <Badge tone="warning">Ignored</Badge> {data.domain} is stored, but IGNORE_PLATFORM_DOMAIN is set.
                </>
              ) : (
                <>No domain set. DeployNow uses {data.envOrigin ? <code className="text-accent">{data.envOrigin}</code> : "the address each visitor uses"}.</>
              )}
            </p>
          )}
          {data.route.error && <p className="text-xs text-warning mt-1">{data.route.error}</p>}
        </div>

        {proxyMissing && data.route.endpointName && (
          <p className="text-xs text-warning">Set up the edge proxy on {data.route.endpointName} first (Endpoints → {data.route.endpointName} → Edge proxy).</p>
        )}

        <Field label="Domain" hint="Point an A or AAAA record at this server first. Ports 80 and 443 must be open.">
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="deploy.example.com" autoComplete="off" spellCheck={false} />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => run("check")} loading={busy === "check"} disabled={!input.trim() || !!busy}>
            Check domain
          </Button>
          <Button type="button" onClick={() => run("activate")} loading={busy === "activate"} disabled={!input.trim() || !changed || !!busy}>
            Use this domain
          </Button>
          {data.domain && (
            <Button type="button" variant="ghost" onClick={remove} loading={busy === "remove"} disabled={!!busy}>
              <Trash2 className="w-4 h-4" /> Remove
            </Button>
          )}
        </div>
        {busy === "check" || busy === "activate" ? <p className="text-xs text-text-muted">Looking up DNS, routing the domain and waiting for its certificate. This can take up to a minute.</p> : null}

        {result && (
          <div className={clsx("rounded-lg px-3 py-2 text-xs space-y-1", result.reachable && result.certificateValid ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
            <p className="flex items-start gap-2">
              {result.reachable && result.certificateValid ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
              <span>{result.message || result.error}</span>
            </p>
            {result.addresses?.length > 0 && <p className="text-text-muted">DNS: {result.addresses.join(", ")}</p>}
            {result.canForce && result.addresses?.length > 0 && (
              <div className="pt-1">
                <p className="text-text-muted mb-2">
                  Some servers can&apos;t reach their own public address (no hairpin NAT). If https://{result.domain} works in your browser, you can switch anyway.
                </p>
                <Button type="button" variant="secondary" onClick={() => run("activate", { force: true })} disabled={!!busy}>
                  Use it anyway
                </Button>
              </div>
            )}
          </div>
        )}
        {result?.activated && !onDomain && (
          <p className="text-xs text-text-secondary">
            Open <a className="text-accent hover:underline" href={`https://${result.domain}`}>https://{result.domain}</a> and sign in there. Each address keeps its own session.
          </p>
        )}
        <ErrorText>{error}</ErrorText>

        <div className="text-xs text-text-muted border-t border-border pt-4 space-y-1">
          <p>
            The server&apos;s own address on port {data.fallbackPort} keeps working, so a broken domain can&apos;t lock you out: sign in there and remove or change it. Without the UI, set{" "}
            <code className="text-accent">IGNORE_PLATFORM_DOMAIN=true</code> and restart DeployNow.
          </p>
          {data.passkeys > 0 && <p>Passkeys are tied to the address they were added on. Changing the domain means adding new passkeys at the new address.</p>}
          <p>Agents already connected keep the address they joined with. New join commands use the domain unless an agent address is set under Agents.</p>
        </div>
      </div>
    </section>
  );
}
