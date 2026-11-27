"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Boxes, Globe, Layers, LayoutTemplate, Plus, Trash2 } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, IconButton, Input, Modal, PageHeader, PageSkeleton, Select, timeAgo } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";
import { TemplatePicker } from "@/components/Templates";
import { AppForm, appStatusTone, emptyApp, SOURCE_LABELS, type AppFormValue } from "@/components/apps";

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
  const confirm = useConfirm();
  const toast = useToast();
  const [project, setProject] = useState<ProjectView | null>(null);
  const [endpoints, setEndpoints] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [newApp, setNewApp] = useState<{ envId: string; value: AppFormValue } | null>(null);
  const [fromTemplate, setFromTemplate] = useState<EnvRow | null>(null);
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

  const deleteEnv = async (env: EnvRow) => {
    if (!(await confirm({ title: `Delete the ${env.name} environment?`, message: "It has no apps, so nothing is stopped.", confirmLabel: "Delete environment" }))) return;
    const res = await api(`/api/environments/${env.id}`, { method: "DELETE" });
    if (!res.ok) toast.error(res.data.error ?? "Could not delete");
    else toast.success(`Deleted ${env.name}`);
    load();
  };

  const deleteProject = async () => {
    if (!project) return;
    if (!(await confirm({ title: `Delete ${project.name}?`, message: "The project and its environments are removed. It has no apps, so nothing is stopped.", confirmLabel: "Delete project", typeToConfirm: project.name }))) return;
    const res = await api(`/api/projects/${id}`, { method: "DELETE" });
    if (!res.ok) return toast.error(res.data.error ?? "Could not delete");
    toast.success(`Deleted ${project.name}`);
    router.push("/projects");
  };

  if (!project) return error ? <div className="max-w-6xl"><ErrorText>{error}</ErrorText></div> : <PageSkeleton />;

  const appCount = project.environments.reduce((n, e) => n + e.apps.length, 0);

  return (
    <div className="max-w-6xl">
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name }]}
        title={project.name}
        subtitle={project.description || undefined}
        actions={
          project.canManage && (
            <>
              {appCount === 0 && (
                <IconButton label="Delete project" variant="danger" onClick={deleteProject}><Trash2 className="w-4 h-4" /></IconButton>
              )}
              <Button variant="secondary" onClick={() => setNewEnv({ name: "", endpointId: endpoints[0]?.id ?? "" })}><Plus className="w-4 h-4" /> Environment</Button>
            </>
          )
        }
      />
      <ErrorText>{error}</ErrorText>

      <div className="space-y-6 mt-2">
        {project.environments.map((env) => (
          <section key={env.id}>
            <div className="flex items-center justify-between gap-3 mb-2">
              <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wide min-w-0">
                {env.name} <span className="text-text-muted font-normal normal-case">{env.defaultEndpoint ? `· runs on ${env.defaultEndpoint.name}` : ""}</span>
              </h2>
              {project.canManage && (
                <div className="flex gap-2">
                  {env.apps.length === 0 && project.environments.length > 1 && (
                    <IconButton label={`Delete ${env.name}`} onClick={() => deleteEnv(env)}><Trash2 className="w-4 h-4" /></IconButton>
                  )}
                  <Button variant="secondary" onClick={() => setFromTemplate(env)}>
                    <LayoutTemplate className="w-4 h-4" /> From template
                  </Button>
                  <Button variant="secondary" onClick={() => setNewApp({ envId: env.id, value: { ...emptyApp, endpointId: env.defaultEndpoint?.id ?? endpoints[0]?.id ?? "" } })}>
                    <Plus className="w-4 h-4" /> New app
                  </Button>
                </div>
              )}
            </div>
            <Card className="overflow-hidden">
              {env.apps.length === 0 ? (
                <div className="p-8 text-center">
                  <Boxes className="w-8 h-8 text-text-muted mx-auto mb-2" />
                  <p className="text-sm text-text-primary mb-1">No apps in {env.name} yet</p>
                  <p className="text-xs text-text-muted mb-4">Deploy a container image, a Dockerfile or a docker-compose file from Git, or start from one of the ready templates.</p>
                  {project.canManage && (
<div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setNewApp({ envId: env.id, value: { ...emptyApp, endpointId: env.defaultEndpoint?.id ?? endpoints[0]?.id ?? "" } })}>
                      <Plus className="w-4 h-4" /> Add an app
                    </Button>
                      <Button variant="secondary" onClick={() => setFromTemplate(env)}>
                        <LayoutTemplate className="w-4 h-4" /> Start from a template
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                env.apps.map((a, i) => (
                  <Link key={a.id} href={`/apps/${a.id}`} className={`flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-bg-secondary ${i ? "border-t border-border" : ""}`}>
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
                    <div className="sm:text-right text-xs text-text-muted sm:w-36 flex sm:block gap-2">
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
        <Modal icon={Boxes}
          title="New app"
          wide
          onClose={() => setNewApp(null)}
          footer={
            <>
              <span className="mr-auto self-center text-xs text-text-muted hidden sm:block">Next: environment variables, domains, then deploy.</span>
              <Button variant="secondary" onClick={() => setNewApp(null)}>Cancel</Button>
              <Button onClick={createApp} loading={busy} disabled={!newApp.value.name.trim()}>Create app</Button>
            </>
          }
        >
          <AppForm value={newApp.value} onChange={(value) => setNewApp({ ...newApp, value })} endpoints={endpoints} isNew />
          <div className="mt-3"><ErrorText>{formError}</ErrorText></div>
        </Modal>
      )}

      {fromTemplate && (
        <TemplatePicker environmentId={fromTemplate.id} defaultEndpointId={fromTemplate.defaultEndpoint?.id ?? endpoints[0]?.id ?? ""} endpoints={endpoints} onClose={() => setFromTemplate(null)} />
      )}

      {newEnv && (
        <Modal icon={Layers} title="New environment" onClose={() => setNewEnv(null)}>
          <div className="space-y-3">
            <Field label="Name"><Input value={newEnv.name} onChange={(e) => setNewEnv({ ...newEnv, name: e.target.value })} placeholder="staging" autoFocus /></Field>
            <Field label="Default endpoint">
              <Select value={newEnv.endpointId} onChange={(e) => setNewEnv({ ...newEnv, endpointId: e.target.value })}>
                {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
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
