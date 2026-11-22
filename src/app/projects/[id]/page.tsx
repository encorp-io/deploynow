"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Globe, Plus, Trash2 } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, timeAgo } from "@/components/ui";
import { AppForm, appStatusTone, emptyApp, selectClass, SOURCE_LABELS, type AppFormValue } from "@/components/apps";

interface AppRow {
  id: string;
  name: string;
  slug: string;
  sourceType: string;
  status: string;
  image: string;
  gitRepo: string;
  endpoint: { id: string; name: string };
  domains: { host: string; path: string; https: boolean }[];
  lastDeployment: { id: string; status: string; createdAt: string; finishedAt: string | null; commitSha: string } | null;
}
interface EnvRow { id: string; name: string; slug: string; defaultEndpoint: { id: string; name: string } | null; apps: AppRow[] }
interface ProjectView { id: string; name: string; description: string; canManage: boolean; environments: EnvRow[] }

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = useApi();
  const router = useRouter();
  const [project, setProject] = useState<ProjectView | null>(null);
  const [endpoints, setEndpoints] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [newApp, setNewApp] = useState<{ envId: string; value: AppFormValue } | null>(null);
  const [newEnv, setNewEnv] = useState<{ name: string; endpointId: string } | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, e] = await Promise.all([api<ProjectView>(`/api/projects/${id}`), api<{ id: string; name: string }[]>("/api/endpoints")]);
    if (p.ok) setProject(p.data as ProjectView);
    else setError(p.data.error ?? "Project not found");
    if (e.ok) setEndpoints(e.data as unknown as { id: string; name: string }[]);
  }, [api, id]);

  useEffect(() => {
    load();
  }, [load]);

  const createApp = async () => {
    if (!newApp) return;
    setBusy(true);
    setFormError("");
    const res = await api<{ id: string }>("/api/apps", { method: "POST", body: { ...newApp.value, environmentId: newApp.envId } });
    setBusy(false);
    if (!res.ok) return setFormError(res.data.error ?? "Could not create the app");
    router.push(`/apps/${res.data.id}`);
  };

  const createEnv = async () => {
    if (!newEnv) return;
    setBusy(true);
    setFormError("");
    const res = await api(`/api/projects/${id}/environments`, { method: "POST", body: newEnv });
    setBusy(false);
    if (!res.ok) return setFormError(res.data.error ?? "Could not add the environment");
    setNewEnv(null);
    load();
  };

  const deleteEnv = async (envId: string) => {
    const res = await api(`/api/environments/${envId}`, { method: "DELETE" });
    if (!res.ok) setError(res.data.error ?? "Could not delete");
    load();
  };

  const deleteProject = async () => {
    const res = await api(`/api/projects/${id}`, { method: "DELETE" });
    if (!res.ok) return setError(res.data.error ?? "Could not delete");
    router.push("/projects");
  };

  if (!project) return <div className="max-w-6xl">{error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-text-muted">Loading…</p>}</div>;

  return (
    <div className="max-w-6xl">
      <Link href="/projects" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-3"><ArrowLeft className="w-4 h-4" /> Projects</Link>
      <PageHeader
        title={project.name}
        subtitle={project.description || undefined}
        actions={
          project.canManage && (
            <>
              <Button variant="secondary" onClick={() => setNewEnv({ name: "", endpointId: endpoints[0]?.id ?? "" })}><Plus className="w-4 h-4" /> Environment</Button>
              {project.environments.every((e) => e.apps.length === 0) && (
                <Button variant="danger" onClick={deleteProject}><Trash2 className="w-4 h-4" /> Delete project</Button>
              )}
            </>
          )
        }
      />
      <ErrorText>{error}</ErrorText>

      <div className="space-y-6 mt-2">
        {project.environments.map((env) => (
          <section key={env.id}>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide">
                {env.name} <span className="text-text-muted font-normal normal-case">{env.defaultEndpoint ? `· on ${env.defaultEndpoint.name}` : ""}</span>
              </h2>
              {project.canManage && (
                <div className="flex gap-2">
                  {env.apps.length === 0 && project.environments.length > 1 && (
                    <Button variant="ghost" onClick={() => deleteEnv(env.id)}><Trash2 className="w-4 h-4" /></Button>
                  )}
                  <Button variant="secondary" onClick={() => setNewApp({ envId: env.id, value: { ...emptyApp, endpointId: env.defaultEndpoint?.id ?? endpoints[0]?.id ?? "" } })}>
                    <Plus className="w-4 h-4" /> New app
                  </Button>
                </div>
              )}
            </div>
            <Card className="overflow-hidden">
              {env.apps.length === 0 ? (
                <p className="text-sm text-text-muted p-6 text-center">No apps in {env.name} yet</p>
              ) : (
                env.apps.map((a, i) => (
                  <Link key={a.id} href={`/apps/${a.id}`} className={`flex items-center gap-4 px-4 py-3 hover:bg-bg-secondary ${i ? "border-t border-border" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary">{a.name}</span>
                        <Badge tone={appStatusTone(a.status)}>{a.status}</Badge>
                      </div>
                      <p className="text-xs text-text-muted font-mono truncate mt-0.5">{SOURCE_LABELS[a.sourceType]} · {a.image || a.gitRepo || "inline compose"}</p>
                    </div>
                    <div className="hidden md:flex flex-wrap gap-1 justify-end max-w-xs">
                      {a.domains.map((d) => (
                        <span key={d.host + d.path} className="inline-flex items-center gap-1 text-xs text-text-secondary"><Globe className="w-3 h-3" />{d.host}{d.path !== "/" ? d.path : ""}</span>
                      ))}
                    </div>
                    <div className="text-right text-xs text-text-muted w-32">
                      <p>{a.endpoint.name}</p>
                      <p>{a.lastDeployment ? `deployed ${timeAgo(a.lastDeployment.finishedAt ?? a.lastDeployment.createdAt)}` : "never deployed"}</p>
                    </div>
                  </Link>
                ))
              )}
            </Card>
          </section>
        ))}
      </div>

      {newApp && (
        <Modal title="New app" wide onClose={() => setNewApp(null)}>
          <AppForm value={newApp.value} onChange={(value) => setNewApp({ ...newApp, value })} endpoints={endpoints} isNew />
          <p className="text-xs text-text-muted mt-3">Add environment variables, secrets and domains on the app page, then deploy.</p>
          <div className="mt-3"><ErrorText>{formError}</ErrorText></div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setNewApp(null)}>Cancel</Button>
            <Button onClick={createApp} loading={busy}>Create app</Button>
          </div>
        </Modal>
      )}

      {newEnv && (
        <Modal title="New environment" onClose={() => setNewEnv(null)}>
          <div className="space-y-3">
            <Field label="Name"><Input value={newEnv.name} onChange={(e) => setNewEnv({ ...newEnv, name: e.target.value })} placeholder="staging" autoFocus /></Field>
            <Field label="Default endpoint">
              <select value={newEnv.endpointId} onChange={(e) => setNewEnv({ ...newEnv, endpointId: e.target.value })} className={selectClass}>
                {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Field>
            <ErrorText>{formError}</ErrorText>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setNewEnv(null)}>Cancel</Button>
              <Button onClick={createEnv} loading={busy} disabled={!newEnv.name.trim()}>Add</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
