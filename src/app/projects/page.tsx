"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderKanban, Plus } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, Modal, PageHeader, Skeleton } from "@/components/ui";
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
        subtitle="Each project holds environments (production, staging…) and the apps that run in them"
        actions={<Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New project</Button>}
      />

      {!projects ? (
        <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="Create your first project"
          action={<Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" /> New project</Button>}
        >
          A project groups related apps, for example a client portal with its API, web front end and database. It starts with a production environment; add staging later.
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.map((p) => {
            const apps = p.environments.flatMap((e) => e.apps.map((a) => ({ ...a, env: e.name })));
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="group rounded-2xl">
                <Card className="p-5 h-full transition-all duration-200 group-hover:border-border-bright group-hover:-translate-y-0.5 group-hover:shadow-[0_16px_40px_-20px_var(--dn-accent)]">
                  <div className="flex items-start gap-3.5 mb-3">
                    <span aria-hidden className="w-10 h-10 rounded-xl dn-gradient flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_6px_16px_-6px_var(--dn-accent)]">
                      {p.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <h2 className="font-semibold tracking-[-0.01em] text-text-primary truncate group-hover:text-accent transition-colors">{p.name}</h2>
                        <span className="text-xs text-text-muted flex-shrink-0">{apps.length} {apps.length === 1 ? "app" : "apps"}</span>
                      </div>
                      <p className="text-sm text-text-muted truncate">{p.description || p.environments.map((e) => e.name).join(" · ")}</p>
                    </div>
                  </div>
                  <div className="dn-hairline -mx-5 mb-3 opacity-60" />
                  <div className="flex flex-wrap gap-1.5">
                    {apps.length === 0 && <span className="text-xs text-text-muted">No apps yet. Open the project to add one.</span>}
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
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create();
            }}
          >
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Client portal" autoFocus /></Field>
            <Field label="Description (optional)"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <Field label="Default endpoint" hint="The machine new apps run on. You can change it per app.">
              <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary">
                {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Field>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!name.trim()}>Create project</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
