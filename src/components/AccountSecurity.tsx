"use client";

import { useCallback, useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Bot, Copy, Fingerprint, KeyRound, Plus, Trash2 } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Select, timeAgo } from "@/components/ui";
import { useConfirm } from "@/components/feedback";

interface PasskeyRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export function PasskeysCard({ onChange }: { onChange?: () => void }) {
  const api = useApi();
  const confirm = useConfirm();
  const [rows, setRows] = useState<PasskeyRow[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);

  const load = useCallback(async () => {
    const res = await api<PasskeyRow[]>("/api/passkeys");
    if (res.ok) setRows(res.data as unknown as PasskeyRow[]);
  }, [api]);

  useEffect(() => {
    setSupported(!!window.PublicKeyCredential && window.isSecureContext);
    load();
  }, [load]);

  async function add() {
    setError("");
    setBusy(true);
    try {
      const options = await api<Record<string, unknown>>("/api/passkeys/register", { body: {} });
      if (!options.ok) throw new Error(String(options.data.error ?? "Could not start"));
      const response = await startRegistration(options.data as never);
      const res = await api("/api/passkeys/register", { method: "PUT", body: { response, name: name || defaultName() } });
      if (!res.ok) throw new Error(String(res.data.error ?? "Could not save the passkey"));
      setName("");
      await load();
      onChange?.();
    } catch (err) {
      const e = err as Error;
      setError(e.name === "NotAllowedError" ? "Cancelled." : e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: PasskeyRow) {
    if (!(await confirm({ title: `Remove the passkey "${p.name}"?`, confirmLabel: "Remove" }))) return;
    const res = await api(`/api/passkeys/${p.id}`, { method: "DELETE" });
    if (!res.ok) setError(String(res.data.error ?? "Could not remove it"));
    await load();
    onChange?.();
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Fingerprint className="w-5 h-5 text-accent" />
        <div>
          <h2 className="font-semibold text-text-primary">Passkeys</h2>
          <p className="text-xs text-text-muted">Sign in with Touch ID, Windows Hello, your phone or a security key. A passkey counts as two-factor.</p>
        </div>
      </div>
      {rows.length > 0 && (
        <div className="divide-y divide-border">
          {rows.map((p) => (
            <div key={p.id} className="flex items-center justify-between py-2.5 text-sm">
              <div>
                <p className="text-text-primary">{p.name}</p>
                <p className="text-xs text-text-muted">Added {timeAgo(p.createdAt)} · {p.lastUsedAt ? `used ${timeAgo(p.lastUsedAt)}` : "never used"}</p>
              </div>
              <Button variant="ghost" onClick={() => remove(p)} aria-label={`Remove ${p.name}`}><Trash2 className="w-4 h-4" /></Button>
            </div>
          ))}
        </div>
      )}
      {supported ? (
        <div className="flex gap-2">
          <Input placeholder="Name, like MacBook or YubiKey" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          <Button loading={busy} onClick={add} className="whitespace-nowrap"><Plus className="w-4 h-4" /> Add a passkey</Button>
        </div>
      ) : (
        <p className="text-xs text-text-muted">This browser can&apos;t create passkeys here. Passkeys need HTTPS and a domain name.</p>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function defaultName() {
  const ua = navigator.userAgent;
  return /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Passkey";
}

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string;
  revoked: boolean;
  expired: boolean;
  createdAt: string;
}

const SCOPES = [
  { value: "viewer", label: "Read only (viewer)" },
  { value: "operator", label: "Deploy and run (operator)" },
  { value: "admin", label: "Full access (admin)" },
];

export function ApiTokensCard({ role }: { role: string }) {
  const api = useApi();
  const confirm = useConfirm();
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [form, setForm] = useState({ name: "", scope: "viewer", expiresInDays: "90" });
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rank = ["viewer", "operator", "admin", "owner"].indexOf(role);

  const load = useCallback(async () => {
    const res = await api<TokenRow[]>("/api/tokens");
    if (res.ok) setRows(res.data as unknown as TokenRow[]);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    setError("");
    setBusy(true);
    const res = await api<{ token: string }>("/api/tokens", { body: { name: form.name, scope: form.scope, expiresInDays: form.expiresInDays === "never" ? null : Number(form.expiresInDays) } });
    setBusy(false);
    if (!res.ok) return setError(String(res.data.error ?? "Could not create the token"));
    setCreated(res.data.token);
    setForm({ ...form, name: "" });
    load();
  }

  async function revoke(t: TokenRow) {
    if (!(await confirm({ title: `Revoke "${t.name}"?`, message: "Anything using it stops working.", confirmLabel: "Revoke" }))) return;
    await api(`/api/tokens/${t.id}`, { method: "DELETE" });
    load();
  }

  const active = rows.filter((t) => !t.revoked);
  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <KeyRound className="w-5 h-5 text-accent" />
        <div>
          <h2 className="font-semibold text-text-primary">API tokens</h2>
          <p className="text-xs text-text-muted">
            For scripts, CI and the <code>deploynow</code> CLI. Send as <code>Authorization: Bearer …</code>. See the <a className="text-accent" href="/api/openapi.json" target="_blank">API description</a>.
          </p>
        </div>
      </div>
      {created && (
        <div className="space-y-2 bg-success/10 border border-success/30 rounded-lg p-3">
          <p className="text-xs text-text-secondary">Copy the token now. It won&apos;t be shown again.</p>
          <div className="flex gap-2 items-center">
            <code className="flex-1 font-mono text-xs break-all text-text-primary">{created}</code>
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(created)}><Copy className="w-4 h-4" /> Copy</Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>Done</Button>
          </div>
        </div>
      )}
      {active.length > 0 && (
        <div className="divide-y divide-border">
          {active.map((t) => (
            <div key={t.id} className="flex items-center justify-between py-2.5 text-sm">
              <div>
                <p className="text-text-primary">
                  {t.name} <Badge tone={t.expired ? "danger" : "muted"}>{t.expired ? "expired" : t.scope}</Badge>
                </p>
                <p className="text-xs text-text-muted">
                  <code>{t.prefix}…</code> · created {timeAgo(t.createdAt)} · {t.expiresAt ? `expires ${new Date(t.expiresAt).toLocaleDateString()}` : "never expires"} ·{" "}
                  {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}${t.lastUsedIp ? ` from ${t.lastUsedIp}` : ""}` : "never used"}
                </p>
              </div>
              <Button variant="ghost" onClick={() => revoke(t)}>Revoke</Button>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[1fr_200px_140px_auto] gap-2 items-end">
        <Field label="Name"><Input placeholder="GitHub Actions" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Access">
          <Select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
            {SCOPES.filter((s, i) => i <= rank).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label="Expires">
          <Select value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}>
            <option value="7">in 7 days</option>
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in a year</option>
            <option value="never">never</option>
          </Select>
        </Field>
        <Button loading={busy} onClick={create} disabled={!form.name.trim()}><Plus className="w-4 h-4" /> Create</Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

interface ConnectionRow {
  id: string;
  name: string;
  clientUri: string;
  redirectHost: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string;
}

const ROLE_LABEL: Record<string, string> = { viewer: "read only", operator: "operate", admin: "admin" };

/** AI apps connected over OAuth (Claude, ChatGPT, …), with the address to add DeployNow to one. */
export function ConnectedAppsCard() {
  const api = useApi();
  const confirm = useConfirm();
  const [data, setData] = useState<{ enabled: boolean; mcpUrl: string; connections: ConnectionRow[] } | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ enabled: boolean; mcpUrl: string; connections: ConnectionRow[] }>("/api/account/connections");
    if (res.ok) setData(res.data as unknown as { enabled: boolean; mcpUrl: string; connections: ConnectionRow[] });
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function revoke(c: ConnectionRow) {
    if (!(await confirm({ title: `Disconnect ${c.name}?`, message: "It loses access at once. You can connect it again later.", confirmLabel: "Disconnect" }))) return;
    await api(`/api/account/connections?id=${c.id}`, { method: "DELETE" });
    load();
  }

  if (!data) return null;
  return (
    <Card className="p-6 space-y-4">
      <div id="ai-connections" className="flex items-center gap-3">
        <Bot className="w-5 h-5 text-accent" />
        <div>
          <h2 className="font-semibold text-text-primary">AI connections</h2>
          <p className="text-xs text-text-muted">
            Use DeployNow from Claude, ChatGPT or any app that supports MCP connectors. Add a custom connector with this address, then sign in here and choose what it may do.
          </p>
        </div>
      </div>
      {data.enabled ? (
        <div className="flex gap-2 items-center bg-bg-secondary border border-border rounded-xl pl-3.5 pr-1.5 py-1.5">
          <code className="flex-1 font-mono text-xs break-all text-text-primary">{data.mcpUrl}</code>
          <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(data.mcpUrl)}><Copy className="w-4 h-4" /> Copy</Button>
        </div>
      ) : (
        <p className="text-sm text-text-secondary">AI connectors are turned off on this server (DEPLOYNOW_MCP=off).</p>
      )}
      {data.connections.length > 0 ? (
        <div className="divide-y divide-border">
          {data.connections.map((c) => (
            <div key={c.id} className="flex items-center justify-between py-2.5 text-sm gap-3">
              <div className="min-w-0">
                <p className="text-text-primary truncate">
                  {c.name} <Badge tone={c.role === "admin" ? "warning" : "muted"}>{ROLE_LABEL[c.role] ?? c.role}</Badge>
                </p>
                <p className="text-xs text-text-muted">
                  {c.redirectHost ? `${c.redirectHost} · ` : ""}connected {timeAgo(c.createdAt)} · {c.lastUsedAt ? `used ${timeAgo(c.lastUsedAt)}${c.lastUsedIp ? ` from ${c.lastUsedIp}` : ""}` : "never used"}
                </p>
              </div>
              <Button variant="ghost" onClick={() => revoke(c)}>Disconnect</Button>
            </div>
          ))}
        </div>
      ) : (
        data.enabled && <p className="text-xs text-text-muted">No apps connected yet.</p>
      )}
    </Card>
  );
}
