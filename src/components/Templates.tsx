"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, LayoutTemplate, Search } from "lucide-react";
import { useApi } from "./AppShell";
import { Badge, Button, ErrorText, Field, Input, Modal, Select } from "./ui";
import { useToast } from "./feedback";

interface TemplateVarView { key: string; label: string; default: string; secret: boolean; generated: boolean; required: boolean; help: string }
export interface TemplateView {
  id: string;
  name: string;
  category: string;
  description: string;
  website: string;
  web: { service: string; port: number } | null;
  publish: { service: string; port: number } | null;
  backup: boolean;
  notes: string;
  vars: TemplateVarView[];
  compose: string;
}

interface Props {
  environmentId: string;
  defaultEndpointId: string;
  endpoints: { id: string; name: string }[];
  onClose: () => void;
}

/** Pick a template, answer a few questions, and the app is created, backed up and deployed. */
export function TemplatePicker({ environmentId, defaultEndpointId, endpoints, onClose }: Props) {
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [destinations, setDestinations] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<TemplateView | null>(null);
  const [form, setForm] = useState({ name: "", endpointId: defaultEndpointId, expose: "domain" as "domain" | "port" | "none", domain: "", https: true, hostPort: "", backupDestinationId: "", deploy: true, values: {} as Record<string, string> });
  const [showCompose, setShowCompose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<TemplateView[]>("/api/templates").then((r) => r.ok && setTemplates(r.data as unknown as TemplateView[]));
    api<{ id: string; name: string }[]>("/api/backups/destinations").then((r) => r.ok && setDestinations(r.data as unknown as { id: string; name: string }[]));
  }, [api]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (templates ?? []).filter((t) => !q || `${t.name} ${t.category} ${t.description}`.toLowerCase().includes(q));
  }, [templates, query]);
  const categories = [...new Set(shown.map((t) => t.category))];

  const pick = (t: TemplateView) => {
    setPicked(t);
    setError("");
    setShowCompose(false);
    setForm((f) => ({
      ...f,
      name: t.name,
      expose: t.web ? "domain" : "none",
      hostPort: "",
      backupDestinationId: t.backup && destinations.length ? destinations[0].id : "",
      values: Object.fromEntries(t.vars.map((v) => [v.key, v.generated ? "" : v.default])),
    }));
  };

  const create = async () => {
    if (!picked) return;
    setBusy(true);
    setError("");
    const r = await api<{ id: string; notes: string; backupError?: string; kitAvailable?: boolean }>("/api/templates", {
      method: "POST",
      body: {
        templateId: picked.id,
        environmentId,
        endpointId: form.endpointId,
        name: form.name,
        domain: form.expose === "domain" ? form.domain : "",
        https: form.https,
        hostPort: form.expose === "port" ? form.hostPort : null,
        values: form.values,
        backupDestinationId: form.backupDestinationId || undefined,
        deploy: form.deploy,
      },
    });
    setBusy(false);
    if (!r.ok) return setError(r.data.error ?? "Couldn't create the app");
    const d = r.data as { id: string; notes: string; backupError?: string; kitAvailable?: boolean };
    if (d.backupError) toast.error(`The app was created, but not its backup policy: ${d.backupError}`);
    else if (d.kitAvailable) toast.success("Backups are on. Download the recovery kit under Backups.");
    if (d.notes) toast.success(d.notes);
    router.push(`/apps/${d.id}`);
  };

  if (!picked) {
    return (
      <Modal title="New app from a template" wide onClose={onClose}>
        <div className="relative mb-4">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates" className="pl-9" autoFocus />
        </div>
        {!templates ? (
          <p className="text-sm text-text-muted">Loading…</p>
        ) : (
          <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
            {categories.map((c) => (
              <section key={c}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-2">{c}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {shown.filter((t) => t.category === c).map((t) => (
                    <button key={t.id} type="button" onClick={() => pick(t)} className="text-left rounded-xl border border-border p-3 hover:border-accent hover:bg-bg-secondary">
                      <div className="flex items-center gap-2">
                        <LayoutTemplate className="w-4 h-4 text-accent flex-shrink-0" />
                        <span className="font-medium text-text-primary">{t.name}</span>
                        {t.backup && <Badge tone="muted">backups</Badge>}
                      </div>
                      <p className="text-xs text-text-muted mt-1">{t.description}</p>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {shown.length === 0 && <p className="text-sm text-text-muted">No template matches.</p>}
          </div>
        )}
      </Modal>
    );
  }

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const canCreate = form.name.trim() && (form.expose !== "domain" || form.domain.trim()) && (form.expose !== "port" || form.hostPort);

  return (
    <Modal
      title={picked.name}
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" className="mr-auto" onClick={() => setPicked(null)}><ArrowLeft className="w-4 h-4" /> Templates</Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={create} loading={busy} disabled={!canCreate}>{form.deploy ? "Create and deploy" : "Create app"}</Button>
        </>
      }
    >
      <p className="text-sm text-text-secondary mb-4">
        {picked.description}{" "}
        <a href={picked.website} target="_blank" rel="noreferrer" className="text-accent hover:underline inline-flex items-center gap-0.5">Website <ExternalLink className="w-3 h-3" /></a>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name"><Input value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Endpoint">
          <Select value={form.endpointId} onChange={(e) => set({ endpointId: e.target.value })}>
            {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        </Field>

        {(picked.web || picked.publish) && (
          <Field label={picked.web ? "How to reach it" : "Reach it from other apps"}>
            <Select value={form.expose} onChange={(e) => set({ expose: e.target.value as typeof form.expose })}>
              {picked.web && <option value="domain">On a domain (HTTPS through the edge proxy)</option>}
              <option value="port">On a host port</option>
              <option value="none">{picked.web ? "Not yet (add a domain later)" : "Only inside this app"}</option>
            </Select>
          </Field>
        )}
        {form.expose === "domain" && picked.web && (
          <Field label="Domain" hint="Point its DNS at the endpoint first.">
            <Input value={form.domain} onChange={(e) => set({ domain: e.target.value })} placeholder={`${picked.id}.example.com`} />
          </Field>
        )}
        {form.expose === "port" && (
          <Field label="Host port" hint={`Forwards to port ${(picked.web ?? picked.publish)!.port} in the container.`}>
            <Input type="number" min={1} max={65535} value={form.hostPort} onChange={(e) => set({ hostPort: e.target.value })} placeholder={String((picked.web ?? picked.publish)!.port)} />
          </Field>
        )}

        {picked.vars.map((v) => (
          <Field key={v.key} label={v.label} hint={v.help || undefined}>
            <Input type={v.secret ? "password" : "text"} autoComplete="off" value={form.values[v.key] ?? ""} onChange={(e) => set({ values: { ...form.values, [v.key]: e.target.value } })} placeholder={v.generated ? "Generated" : v.default} />
          </Field>
        ))}

        {picked.backup && (
          <Field label="Nightly backup" hint={destinations.length ? "A database dump and the data volumes, at 03:00, 7 daily, 4 weekly and 6 monthly copies." : "Add a backup destination under Backups to back this app up."}>
            <Select value={form.backupDestinationId} onChange={(e) => set({ backupDestinationId: e.target.value })} disabled={!destinations.length}>
              <option value="">No backup</option>
              {destinations.map((d) => <option key={d.id} value={d.id}>To {d.name}</option>)}
            </Select>
          </Field>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-text-secondary">
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.deploy} onChange={(e) => set({ deploy: e.target.checked })} /> Deploy right away</label>
        <button type="button" onClick={() => setShowCompose(!showCompose)} className="text-accent hover:underline text-xs">{showCompose ? "Hide" : "Show"} the compose file</button>
      </div>
      {showCompose && <pre className="mt-3 max-h-72 overflow-auto rounded-lg bg-bg-secondary p-3 text-xs font-mono text-text-secondary">{picked.compose}</pre>}
      <p className="mt-3 text-xs text-text-muted">Passwords and keys are generated and stored as secrets. Everything can be changed later in the app&apos;s settings.</p>
      <div className="mt-3"><ErrorText>{error}</ErrorText></div>
    </Modal>
  );
}
