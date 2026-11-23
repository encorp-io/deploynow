"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, Plus, Send, Trash2, Vault } from "lucide-react";
import { useApi } from "./AppShell";
import { Badge, Button, ErrorText, Field, Input, TextArea } from "./ui";
import { selectClass } from "./apps";

const MASK = "••••••••";
const section = "dn-surface border border-border rounded-2xl p-6";

interface VaultForm { addr: string; namespace: string; auth: "token" | "approle"; token: string; roleId: string; secretId: string; caCert: string }

export function VaultSettings() {
  const api = useApi();
  const [v, setV] = useState<VaultForm | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api<{ vault: VaultForm }>("/api/settings").then((r) => r.ok && setV((r.data as { vault: VaultForm }).vault));
  }, [api]);

  if (!v) return null;
  const set = (k: keyof VaultForm, val: string) => setV({ ...v, [k]: val });

  const save = async () => {
    setBusy("save");
    setError("");
    setMsg("");
    const res = await api("/api/settings", { method: "PUT", body: { vault: v } });
    setBusy("");
    if (!res.ok) return setError(res.data.error ?? "Could not save");
    setMsg("Saved");
  };
  const test = async () => {
    setBusy("test");
    setError("");
    setMsg("");
    const res = await api<{ message?: string }>("/api/settings/vault", { method: "POST" });
    setBusy("");
    if (!res.ok) return setError(res.data.error ?? "Vault test failed");
    setMsg((res.data as { message: string }).message);
  };

  return (
    <section className={section}>
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><Vault className="w-4 h-4" /> HashiCorp Vault (optional)</h2>
      <p className="text-xs text-text-muted mb-4">
        For production secrets: an app env var of kind &quot;vault&quot; holds <code>mount/path#field</code> (KV v2 or v1), read at each deploy. Vault keeps versions, rotation and the audit trail.
      </p>
      <div className="space-y-3">
        <div className="grid sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2"><Field label="Address"><Input value={v.addr} onChange={(e) => set("addr", e.target.value)} placeholder="https://vault.example.com:8200" /></Field></div>
          <Field label="Namespace (Enterprise/HCP)"><Input value={v.namespace} onChange={(e) => set("namespace", e.target.value)} placeholder="admin" /></Field>
        </div>
        <Field label="Login">
          <select value={v.auth} onChange={(e) => set("auth", e.target.value)} className={selectClass}>
            <option value="approle">AppRole (recommended)</option>
            <option value="token">Token</option>
          </select>
        </Field>
        {v.auth === "token" ? (
          <Field label="Token"><Input type="password" value={v.token} onFocus={() => v.token === MASK && set("token", "")} onChange={(e) => set("token", e.target.value)} /></Field>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Role ID"><Input value={v.roleId} onChange={(e) => set("roleId", e.target.value)} className="font-mono" /></Field>
            <Field label="Secret ID"><Input type="password" value={v.secretId} onFocus={() => v.secretId === MASK && set("secretId", "")} onChange={(e) => set("secretId", e.target.value)} /></Field>
          </div>
        )}
        <Field label="CA certificate (optional, PEM)" hint="Only for a private CA">
          <TextArea rows={3} value={v.caCert} onChange={(e) => set("caCert", e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        {msg && <p className="text-xs text-success">{msg}</p>}
        <div className="flex gap-2">
          <Button type="button" onClick={save} loading={busy === "save"}>Save Vault settings</Button>
          <Button type="button" variant="secondary" onClick={test} loading={busy === "test"} disabled={!v.addr}>Test connection</Button>
        </div>
      </div>
    </section>
  );
}

interface Channel { id: string; name: string; type: string; events: string[]; enabled: boolean; lastError: string }

const EVENT_LABELS: Record<string, string> = {
  "deploy.success": "Deploy succeeded",
  "deploy.failure": "Deploy failed",
  "backup.success": "Backup succeeded",
  "backup.failure": "Backup failed",
  "restore.success": "Restore finished",
  "restore.failure": "Restore failed",
  "task.failure": "Scheduled task failed",
  "alert.firing": "Alert started (disk, memory, crash loop, agent offline…)",
  "alert.resolved": "Alert cleared",
  "update.available": "New DeployNow version",
  "uptime.down": "Uptime check down",
  "uptime.up": "Uptime check back up",
  "uptime.cert": "Certificate expires soon",
};

export function NotificationSettings() {
  const api = useApi();
  const [data, setData] = useState<{ channels: Channel[]; events: string[] } | null>(null);
  const [form, setForm] = useState<{ name: string; type: string; url: string; botToken: string; chatId: string; host?: string; port?: string; security?: string; user?: string; pass?: string; from?: string; to?: string; apiKey?: string; domain?: string; region?: string; events: string[] } | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const r = await api<{ channels: Channel[]; events: string[] }>("/api/notifications");
    if (r.ok) setData(r.data as { channels: Channel[]; events: string[] });
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data) return null;
  const events = data.events;

  const create = async () => {
    if (!form) return;
    setBusy("create");
    setError("");
    const r = await api<{ secret?: string }>("/api/notifications", { method: "POST", body: form });
    setBusy("");
    if (!r.ok) return setError(r.data.error ?? "Could not add the channel");
    const secret = (r.data as { secret?: string }).secret;
    setMsg(secret ? `Added. Verify X-DeployNow-Signature with this secret: ${secret}` : "Added");
    setForm(null);
    load();
  };
  const test = async (id: string) => {
    setBusy(id);
    setMsg("");
    const r = await api(`/api/notifications/${id}`, { method: "POST" });
    setBusy("");
    setMsg(r.ok ? "Test message sent" : "");
    if (!r.ok) setError(r.data.error ?? "Test failed");
    load();
  };
  const toggle = async (c: Channel) => {
    await api(`/api/notifications/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } });
    load();
  };
  const remove = async (id: string) => {
    await api(`/api/notifications/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <section className={section}>
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><Bell className="w-4 h-4" /> Notifications</h2>
      <p className="text-xs text-text-muted mb-4">Where DeployNow reports deployments, backups and alerts: Slack, Discord, Telegram, email (SMTP or Mailgun) or a signed webhook.</p>
      <div className="space-y-2">
        {data.channels.length === 0 && <p className="text-sm text-text-muted">No channels yet.</p>}
        {data.channels.map((c) => (
          <div key={c.id} className="flex items-center gap-2 text-sm">
            <Badge tone={c.enabled ? (c.lastError ? "danger" : "success") : "muted"}>{c.type}</Badge>
            <span className="text-text-primary">{c.name}</span>
            <span className="text-xs text-text-muted">{c.events.map((e) => EVENT_LABELS[e] ?? e).join(", ")}</span>
            {c.lastError && <span className="text-xs text-danger truncate">{c.lastError}</span>}
            <div className="ml-auto flex gap-1">
              <Button type="button" variant="ghost" onClick={() => toggle(c)}>{c.enabled ? "Pause" : "Resume"}</Button>
              <Button type="button" variant="ghost" onClick={() => test(c.id)} loading={busy === c.id}><Send className="w-4 h-4" /></Button>
              <Button type="button" variant="ghost" onClick={() => remove(c.id)}><Trash2 className="w-4 h-4" /></Button>
            </div>
          </div>
        ))}
      </div>
      {form ? (
        <div className="space-y-3 mt-4 pt-4 border-t border-border">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="#deploys" /></Field>
            <Field label="Type">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={selectClass}>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="telegram">Telegram</option>
                <option value="email">Email (SMTP)</option>
                <option value="mailgun">Email (Mailgun)</option>
                <option value="webhook">Webhook</option>
              </select>
            </Field>
          </div>
          {form.type === "email" ? (
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="SMTP server"><Input value={form.host ?? ""} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="smtp.example.com" /></Field>
              <Field label="Security">
                <select value={form.security ?? "starttls"} onChange={(e) => setForm({ ...form, security: e.target.value, port: e.target.value === "tls" ? "465" : e.target.value === "none" ? "25" : "587" })} className={selectClass}>
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">TLS</option>
                  <option value="none">None</option>
                </select>
              </Field>
              <Field label="Port"><Input value={form.port ?? "587"} onChange={(e) => setForm({ ...form, port: e.target.value })} inputMode="numeric" /></Field>
              <Field label="User name"><Input value={form.user ?? ""} onChange={(e) => setForm({ ...form, user: e.target.value })} autoComplete="off" /></Field>
              <Field label="Password"><Input type="password" value={form.pass ?? ""} onChange={(e) => setForm({ ...form, pass: e.target.value })} autoComplete="new-password" /></Field>
              <Field label="From"><Input value={form.from ?? ""} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="DeployNow <ops@example.com>" /></Field>
              <div className="sm:col-span-3"><Field label="To (comma-separated)"><Input value={form.to ?? ""} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="oncall@example.com, ops@example.com" /></Field></div>
            </div>
          ) : form.type === "mailgun" ? (
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Sending domain"><Input value={form.domain ?? ""} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="mg.example.com" /></Field>
              <Field label="Region">
                <select value={form.region ?? "us"} onChange={(e) => setForm({ ...form, region: e.target.value })} className={selectClass}>
                  <option value="us">US (api.mailgun.net)</option>
                  <option value="eu">EU (api.eu.mailgun.net)</option>
                </select>
              </Field>
              <Field label="API key" hint="A Sending API key for the domain"><Input type="password" value={form.apiKey ?? ""} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} autoComplete="new-password" /></Field>
              <Field label="From (optional)"><Input value={form.from ?? ""} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="DeployNow <alerts@mg.example.com>" /></Field>
              <div className="sm:col-span-2"><Field label="To (comma-separated)"><Input value={form.to ?? ""} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="oncall@example.com, ops@example.com" /></Field></div>
            </div>
          ) : form.type === "telegram" ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Bot token"><Input type="password" value={form.botToken} onChange={(e) => setForm({ ...form, botToken: e.target.value })} /></Field>
              <Field label="Chat id"><Input value={form.chatId} onChange={(e) => setForm({ ...form, chatId: e.target.value })} placeholder="-1001234567890" /></Field>
            </div>
          ) : (
            <Field label={form.type === "webhook" ? "URL (https)" : "Incoming webhook URL"}>
              <Input type="password" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://hooks.slack.com/services/…" />
            </Field>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {events.map((e) => (
              <label key={e} className="flex items-center gap-1.5 text-xs text-text-secondary">
                <input type="checkbox" checked={form.events.includes(e)} onChange={(x) => setForm({ ...form, events: x.target.checked ? [...form.events, e] : form.events.filter((y) => y !== e) })} />
                {EVENT_LABELS[e]}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" onClick={create} loading={busy === "create"}>Add channel</Button>
            <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="secondary" className="mt-4" onClick={() => setForm({ name: "", type: "slack", url: "", botToken: "", chatId: "", events: ["deploy.failure", "backup.failure", "restore.failure", "task.failure", "alert.firing", "alert.resolved", "update.available", "uptime.down", "uptime.up", "uptime.cert"] })}>
          <Plus className="w-4 h-4" /> Add channel
        </Button>
      )}
      <div className="mt-3 space-y-2">
        <ErrorText>{error}</ErrorText>
        {msg && <p className="text-xs text-success break-all">{msg}</p>}
      </div>
    </section>
  );
}
