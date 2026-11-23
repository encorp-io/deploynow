"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { CheckCircle, AlertCircle, HardDrive, KeyRound, Lock, Radio } from "lucide-react";
import AgentJoin, { type JoinInfo } from "./AgentJoin";
import { Button, ErrorText, Field, Input, TextArea } from "./ui";

export interface EndpointView {
  id: string;
  name: string;
  type: "socket" | "ssh" | "tls" | "agent";
  host: string;
  port: number | null;
  username: string;
  labels: string[];
  status: string;
  dockerVersion: string;
  os: string;
  cpus: number;
  memoryBytes: number;
  containers: number;
  lastSeenAt: string | null;
  lastError: string;
  hostKeyFingerprint: string;
  hasPrivateKey: boolean;
  hasTlsCerts: boolean;
  agent?: { enrolled: boolean; joinPending: boolean; version: string; hostname: string; connectedAt: string | null } | null;
  hostMetrics?: { cpus: number; load1: number; load5: number; memTotal: number; memAvailable: number; diskPath: string; diskTotal: number; diskFree: number } | null;
  hostMetricsAt?: string | null;
}

const TYPES = [
  { value: "socket", label: "Local socket", icon: HardDrive, hint: "The machine this deployer runs on. Mount /var/run/docker.sock into the container." },
  { value: "ssh", label: "SSH", icon: KeyRound, hint: "A remote machine you can SSH into. The user needs access to Docker (root or the docker group)." },
  { value: "tls", label: "Docker TLS API", icon: Lock, hint: "A Docker daemon listening on TCP 2376 with client certificate auth." },
  { value: "agent", label: "Agent", icon: Radio, hint: "A server behind NAT or a firewall. You run a small agent there; it connects out to DeployNow over mutual TLS, so no inbound port is needed." },
] as const;

type Api = <T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) => Promise<{ ok: boolean; status: number; data: T & { error?: string } }>;

export default function EndpointForm({
  api,
  existing,
  onSaved,
  onCancel,
}: {
  api: Api;
  existing?: EndpointView;
  onSaved: (e: EndpointView) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: existing?.name ?? "",
    type: existing?.type ?? "ssh",
    host: existing?.host ?? "",
    port: existing?.port?.toString() ?? "",
    username: existing?.username ?? "root",
    labels: existing?.labels.join(", ") ?? "",
    privateKey: "",
    passphrase: "",
    ca: "",
    cert: "",
    key: "",
  });
  const [test, setTest] = useState<{ ok: boolean; error?: string; info?: { dockerVersion: string; os: string; containers: number }; hostKeyFingerprint?: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [joined, setJoined] = useState<{ endpoint: EndpointView; join: JoinInfo } | null>(null);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  function payload(extra: Record<string, unknown> = {}) {
    return {
      id: existing?.id,
      name: form.name,
      type: form.type,
      host: form.host,
      port: form.port ? Number(form.port) : undefined,
      username: form.username,
      labels: form.labels,
      ...(form.privateKey ? { privateKey: form.privateKey } : {}),
      ...(form.passphrase ? { passphrase: form.passphrase } : {}),
      ...(form.ca ? { ca: form.ca } : {}),
      ...(form.cert ? { cert: form.cert } : {}),
      ...(form.key ? { key: form.key } : {}),
      ...extra,
    };
  }

  async function runTest() {
    setBusy("test");
    setError("");
    const res = await api<NonNullable<typeof test>>("/api/endpoints/test", { body: payload() });
    setBusy("");
    setTest(res.data as NonNullable<typeof test>);
  }

  async function save(saveOffline = false) {
    setBusy("save");
    setError("");
    const res = await api<EndpointView>(existing ? `/api/endpoints/${existing.id}` : "/api/endpoints", {
      method: existing ? "PATCH" : "POST",
      body: payload({ saveOffline }),
    });
    setBusy("");
    if (!res.ok) return setError(res.data.error ?? "Could not save");
    const join = (res.data as { join?: JoinInfo }).join;
    if (join) setJoined({ endpoint: res.data as EndpointView, join });
    else onSaved(res.data as EndpointView);
  }

  if (joined) {
    return (
      <div className="space-y-4">
        <AgentJoin join={joined.join} />
        <div className="flex justify-end">
          <Button type="button" onClick={() => onSaved(joined.endpoint)}>Done</Button>
        </div>
      </div>
    );
  }

  const typeInfo = TYPES.find((t) => t.value === form.type)!;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {TYPES.filter((t) => !existing || (t.value === "agent") === (existing.type === "agent")).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => {
                setForm({ ...form, type: t.value, host: t.value === "socket" && !form.host ? "/var/run/docker.sock" : form.host });
                setTest(null);
              }}
              className={clsx(
                "flex flex-col items-center gap-1 p-3 rounded-lg border text-xs font-medium transition-colors",
                form.type === t.value ? "border-accent bg-accent/10 text-accent" : "border-border text-text-secondary hover:border-border-bright",
              )}
            >
              <Icon className="w-5 h-5" />
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-text-muted">{typeInfo.hint}</p>

      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={form.name} onChange={set("name")} placeholder="prod-1" />
        </Field>
        <Field label="Labels" hint="Comma-separated, e.g. prod, client-a">
          <Input value={form.labels} onChange={set("labels")} placeholder="prod" />
        </Field>
      </div>

      {form.type === "agent" ? null : form.type === "socket" ? (
        <Field label="Socket path">
          <Input value={form.host} onChange={set("host")} placeholder="/var/run/docker.sock" />
        </Field>
      ) : (
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <Field label="Host">
            <Input value={form.host} onChange={set("host")} placeholder="203.0.113.10 or server.example.com" />
          </Field>
          <Field label="Port">
            <Input value={form.port} onChange={set("port")} placeholder={form.type === "ssh" ? "22" : "2376"} inputMode="numeric" />
          </Field>
        </div>
      )}

      {form.type === "ssh" && (
        <>
          <Field label="SSH user">
            <Input value={form.username} onChange={set("username")} placeholder="root" />
          </Field>
          <Field
            label="Private key"
            hint={existing?.hasPrivateKey ? "A key is stored. Leave empty to keep it." : "Paste the private key. It is encrypted before it is stored."}
          >
            <TextArea rows={5} value={form.privateKey} onChange={set("privateKey")} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </Field>
          <Field label="Key passphrase (optional)">
            <Input type="password" value={form.passphrase} onChange={set("passphrase")} />
          </Field>
        </>
      )}

      {form.type === "tls" && (
        <>
          {existing?.hasTlsCerts && <p className="text-xs text-text-muted">Certificates are stored. Leave the fields empty to keep them.</p>}
          <Field label="CA certificate (ca.pem)">
            <TextArea rows={3} value={form.ca} onChange={set("ca")} placeholder="-----BEGIN CERTIFICATE-----" />
          </Field>
          <Field label="Client certificate (cert.pem)">
            <TextArea rows={3} value={form.cert} onChange={set("cert")} placeholder="-----BEGIN CERTIFICATE-----" />
          </Field>
          <Field label="Client key (key.pem)">
            <TextArea rows={3} value={form.key} onChange={set("key")} placeholder="-----BEGIN PRIVATE KEY-----" />
          </Field>
        </>
      )}

      {test && (
        <div className={clsx("rounded-lg p-3 text-xs space-y-1", test.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
          <p className="flex items-center gap-2 font-medium">
            {test.ok ? <CheckCircle className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
            {test.ok ? `Connected: Docker ${test.info?.dockerVersion} on ${test.info?.os}, ${test.info?.containers} containers` : test.error}
          </p>
          {test.hostKeyFingerprint && (
            <p className="text-text-secondary">
              SSH host key <span className="font-mono">{test.hostKeyFingerprint}</span>. Check it matches the server
              (<span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>); it is pinned when you save.
            </p>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>

      <div className="flex justify-between gap-2 pt-2">
        {form.type === "agent" ? <span /> : <Button type="button" variant="secondary" loading={busy === "test"} onClick={runTest}>Test connection</Button>}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          {error.startsWith("Could not connect") && (
            <Button type="button" variant="secondary" onClick={() => save(true)}>Save anyway</Button>
          )}
          <Button type="button" loading={busy === "save"} onClick={() => save(false)}>{existing ? "Save" : "Add endpoint"}</Button>
        </div>
      </div>
    </div>
  );
}
