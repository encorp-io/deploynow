"use client";

import { useCallback, useEffect, useState } from "react";
import { LogIn, Plus, Trash2 } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { SharedRegistryLogins } from "@/components/RegistryLogins";
import { Badge, Button, ErrorText, Field, Input, Select } from "@/components/ui";

const MASK = "••••••••";

interface Provider {
  id: string;
  type: string;
  name: string;
  clientId: string;
  clientSecret: string;
  tenant: string;
  issuer: string;
  allowedDomains: string[];
  autoCreate: boolean;
  defaultRole: string;
  enabled: boolean;
  linkedUsers: number;
}

type ProviderForm = Omit<Provider, "id" | "linkedUsers" | "allowedDomains"> & { id?: string; allowedDomains: string };

const blank = (type: string): ProviderForm => ({
  type,
  name: type === "google" ? "Google" : type === "microsoft" ? "Microsoft" : "",
  clientId: "",
  clientSecret: "",
  tenant: type === "microsoft" ? "organizations" : "",
  issuer: "",
  allowedDomains: "",
  autoCreate: false,
  defaultRole: "viewer",
  enabled: true,
});

const SETUP_HELP: Record<string, string> = {
  google: "Google Cloud console → APIs & Services → Credentials → OAuth client ID (Web application).",
  microsoft: "Entra ID → App registrations → New registration (Web). Use your tenant id to allow only your organisation.",
  oidc: "Any OpenID Connect provider: Okta, Auth0, Keycloak, Authentik, GitLab…",
};

export function SsoSettings() {
  const api = useApi();
  const [data, setData] = useState<{ redirectUri: string; providers: Provider[] } | null>(null);
  const [form, setForm] = useState<ProviderForm | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<{ redirectUri: string; providers: Provider[] }>("/api/sso");
    if (r.ok) setData(r.data as { redirectUri: string; providers: Provider[] });
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return null;

  const save = async () => {
    if (!form) return;
    setBusy(true);
    setError("");
    const r = await api(form.id ? `/api/sso/${form.id}` : "/api/sso", { method: form.id ? "PATCH" : "POST", body: form });
    setBusy(false);
    if (!r.ok) return setError(r.data.error ?? "Could not save");
    setForm(null);
    load();
  };
  const remove = async (p: Provider) => {
    if (!window.confirm(`Remove sign-in with ${p.name}? ${p.linkedUsers} linked account(s) will need another way to sign in.`)) return;
    const r = await api(`/api/sso/${p.id}`, { method: "DELETE" });
    if (!r.ok) setError(r.data.error ?? "Could not remove it");
    load();
  };
  const set = <K extends keyof ProviderForm>(k: K, v: ProviderForm[K]) => form && setForm({ ...form, [k]: v });

  return (
    <section className="bg-bg-card border border-border rounded-xl p-6">
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><LogIn className="w-4 h-4" /> Single sign-on</h2>
      <p className="text-xs text-text-muted mb-4">
        Let people sign in with Google, Microsoft or another OpenID Connect provider. Redirect URI: <code className="text-accent">{data.redirectUri}</code>
      </p>
      <div className="divide-y divide-border">
        {data.providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between py-2.5 text-sm">
            <div>
              <p className="text-text-primary">
                {p.name} <Badge tone={p.enabled ? "success" : "muted"}>{p.type}</Badge>
              </p>
              <p className="text-xs text-text-muted">
                {p.allowedDomains.length ? `Only ${p.allowedDomains.map((d) => "@" + d).join(", ")}` : "Existing users with a verified email"}
                {p.autoCreate ? ` · new users join as ${p.defaultRole}` : " · invite only"} · {p.linkedUsers} linked
              </p>
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" onClick={() => setForm({ ...p, allowedDomains: p.allowedDomains.join(", ") })}>Edit</Button>
              <Button type="button" variant="ghost" onClick={() => remove(p)} aria-label={`Remove ${p.name}`}><Trash2 className="w-4 h-4" /></Button>
            </div>
          </div>
        ))}
      </div>
      {form ? (
        <div className="space-y-3 mt-4 pt-4 border-t border-border">
          <p className="text-xs text-text-muted">{SETUP_HELP[form.type]}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Button label"><Input value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
            {form.type === "microsoft" && (
              <Field label="Tenant" hint="Tenant id, domain, or organizations"><Input value={form.tenant} onChange={(e) => set("tenant", e.target.value)} /></Field>
            )}
            {form.type === "oidc" && (
              <Field label="Issuer URL"><Input value={form.issuer} onChange={(e) => set("issuer", e.target.value)} placeholder="https://auth.example.com/realms/main" /></Field>
            )}
            <Field label="Client id"><Input value={form.clientId} onChange={(e) => set("clientId", e.target.value)} /></Field>
            <Field label="Client secret"><Input type="password" value={form.clientSecret} onFocus={() => form.clientSecret === MASK && set("clientSecret", "")} onChange={(e) => set("clientSecret", e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Allowed email domains" hint="Comma-separated; empty allows any existing user"><Input value={form.allowedDomains} onChange={(e) => set("allowedDomains", e.target.value)} placeholder="example.com" /></Field>
            <Field label="Role for new users">
              <Select value={form.defaultRole} onChange={(e) => set("defaultRole", e.target.value)} disabled={!form.autoCreate}>
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={form.autoCreate} onChange={(e) => set("autoCreate", e.target.checked)} /> Create an account on first sign-in for people in the allowed domains
          </label>
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Show on the sign-in page
          </label>
          <div className="flex gap-2">
            <Button type="button" onClick={save} loading={busy}>{form.id ? "Save" : "Add provider"}</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 mt-4">
          <Button type="button" variant="secondary" onClick={() => setForm(blank("google"))}><Plus className="w-4 h-4" /> Google</Button>
          <Button type="button" variant="secondary" onClick={() => setForm(blank("microsoft"))}><Plus className="w-4 h-4" /> Microsoft</Button>
          <Button type="button" variant="secondary" onClick={() => setForm(blank("oidc"))}><Plus className="w-4 h-4" /> Other OIDC</Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </section>
  );
}

/** Shared registry logins (service accounts); personal ones live on the Account page. */
export function RegistrySettings() {
  return <SharedRegistryLogins />;
}
