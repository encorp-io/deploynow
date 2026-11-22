"use client";

import { useCallback, useEffect, useState } from "react";
import { Network } from "lucide-react";
import { useApi } from "./AppShell";
import { Badge, Button, Card, ErrorText, Field, Input } from "./ui";

interface ProxyInfo {
  mode: "none" | "managed" | "external";
  network: string;
  email: string;
  error: string;
  status?: { running: boolean; image: string; error: string };
  check?: { ok: boolean; message: string };
}

/** Edge proxy (Traefik) for an endpoint: DeployNow's own, an existing one, or none. */
export default function ProxyCard({ endpointId }: { endpointId: string }) {
  const api = useApi();
  const [info, setInfo] = useState<ProxyInfo | null>(null);
  const [mode, setMode] = useState<ProxyInfo["mode"]>("none");
  const [email, setEmail] = useState("");
  const [network, setNetwork] = useState("dokploy-network");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<ProxyInfo>(`/api/endpoints/${endpointId}/proxy`);
    if (!res.ok) return;
    const d = res.data as ProxyInfo;
    setInfo(d);
    setMode(d.mode);
    if (d.email) setEmail(d.email);
    if (d.mode === "external") setNetwork(d.network);
  }, [api, endpointId]);

  useEffect(() => {
    load();
  }, [load]);

  const apply = async () => {
    setBusy(true);
    setError("");
    const res = await api(`/api/endpoints/${endpointId}/proxy`, { method: "POST", body: { mode, email, network } });
    setBusy(false);
    if (!res.ok) setError(res.data.error ?? "Could not change the proxy");
    load();
  };

  if (!info) return null;
  const changed = mode !== info.mode || (mode === "managed" && email !== info.email) || (mode === "external" && network !== info.network);

  return (
    <Card className="p-5 mb-4">
      <div className="flex items-center gap-2 mb-1">
        <Network className="w-4 h-4 text-text-muted" />
        <h3 className="text-sm font-semibold text-text-primary">Edge proxy for app domains</h3>
        {info.mode === "managed" && <Badge tone={info.status?.running ? "success" : "danger"}>{info.status?.running ? "Traefik running" : "Traefik stopped"}</Badge>}
        {info.mode === "external" && <Badge tone={info.check?.ok ? "success" : "warning"}>{info.check?.ok ? "Traefik found" : "Traefik not found"}</Badge>}
        {info.mode === "none" && <Badge>Off</Badge>}
      </div>
      <p className="text-xs text-text-muted mb-3">
        {info.mode === "external" && info.check ? info.check.message : "Routes domains to apps on this machine and gets Let's Encrypt certificates."}
      </p>
      <div className="flex flex-wrap gap-2 mb-3">
        {([
          ["managed", "DeployNow runs Traefik (ports 80, 443)"],
          ["external", "Use an existing Traefik (e.g. Dokploy's)"],
          ["none", "No proxy"],
        ] as const).map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)} className={`px-3 py-1.5 rounded-lg border text-xs ${mode === k ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary"}`}>
            {label}
          </button>
        ))}
      </div>
      {mode === "managed" && (
        <Field label="Let's Encrypt email" hint="Expiry notices go here">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@example.com" />
        </Field>
      )}
      {mode === "external" && (
        <Field label="Traefik's Docker network" hint="Dokploy uses dokploy-network, with entrypoints web/websecure and a letsencrypt resolver">
          <Input value={network} onChange={(e) => setNetwork(e.target.value)} className="font-mono" />
        </Field>
      )}
      <div className="mt-3 space-y-2">
        <ErrorText>{error || info.error || (info.mode === "managed" ? info.status?.error : "")}</ErrorText>
        {(changed || (mode === "managed" && !info.status?.running)) && (
          <Button onClick={apply} loading={busy}>{mode === "managed" ? (info.mode === "managed" ? "Reinstall Traefik" : "Install Traefik") : "Save"}</Button>
        )}
      </div>
    </Card>
  );
}
