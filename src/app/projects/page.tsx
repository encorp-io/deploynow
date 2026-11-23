"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader } from "@/components/ui";
import { appStatusTone } from "@/components/apps";

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  environments: { id: string; name: string; apps: { id: string; name: string; status: string; sourceType: string }[] }[];
}
interface EndpointOption { id: string; name: string }

export default function ProjectsPage() {
  const api = useApi();
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointOption[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, e] = await Promise.all([api<ProjectRow[]>("/api/projects"), api<EndpointOption[]>("/api/endpoints")]);
    if (p.ok) setProjects(p.data as unknown as ProjectRow[]);
    if (e.ok) {
      const list = e.data as unknown as EndpointOption[];
      setEndpoints(list);
      setEndpointId((cur) => cur || list[0]?.id || "");
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError("");
    const res = await api<{ id: string }>("/api/projects", { method: "POST", body: { name, description, endpointId } });
    setBusy(false);
    if (!res.ok) return setError(res.data.error ?? "Could not create the project");
    router.push(`/projects/${res.data.id}`);
  };

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Projects"
        subtitle="Apps grouped by project and environment, deployed from GHCR images, Dockerfiles or docker-compose"
        actions={<Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New project</Button>}
      />

      {!projects ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : projects.length === 0 ? (
        <Card className="p-12 text-center">
          <FolderKanban className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p className="text-text-primary font-medium mb-1">No projects yet</p>
          <p className="text-sm text-text-muted mb-4">A project holds an app&apos;s environments (production, staging) and their settings.</p>
          <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New project</Button>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((p) => {
            const apps = p.environments.flatMap((e) => e.apps.map((a) => ({ ...a, env: e.name })));
            return (
              <Link key={p.id} href={`/projects/${p.id}`}>
                <Card className="p-5 hover:border-border-bright transition-colors h-full">
                  <div className="flex items-center justify-between mb-1">
                    <h2 className="font-semibold text-text-primary">{p.name}</h2>
                    <span className="text-xs text-text-muted">{p.environments.map((e) => e.name).join(" · ")}</span>
                  </div>
                  {p.description && <p className="text-sm text-text-muted mb-3">{p.description}</p>}
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {apps.length === 0 && <span className="text-xs text-text-muted">No apps yet</span>}
                    {apps.slice(0, 8).map((a) => (
                      <Badge key={a.id} tone={appStatusTone(a.status)}>{a.name}{p.environments.length > 1 ? ` · ${a.env}` : ""}</Badge>
                    ))}
                    {apps.length > 8 && <span className="text-xs text-text-muted">+{apps.length - 8} more</span>}
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {creating && (
        <Modal title="New project" onClose={() => setCreating(false)}>
          <div className="space-y-3">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Client portal" autoFocus /></Field>
            <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Field label="Default endpoint" hint="Where new apps in the production environment run. You can change it per app.">
              <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary">
                {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Field>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={create} loading={busy} disabled={!name.trim()}>Create</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
