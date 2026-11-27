"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { Copy, ExternalLink, Eye, Globe, Info, Lock, Plus, Rocket, RotateCcw, ScrollText, Square, SquareTerminal, Trash2, Webhook } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, IconButton, Input, Modal, PageHeader, PageSkeleton, Select, stateTone, timeAgo } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";
import { AppBuildSettings } from "@/components/AppBuildSettings";
import { AppRegistryLogin } from "@/components/RegistryLogins";
import ContainerLogs from "@/components/ContainerLogs";
import ResourceHistory from "@/components/ResourceHistory";
import { AppForm, appStatusTone, emptyApp, EnvEditor, SOURCE_LABELS, type AppFormValue, type EnvRow } from "@/components/apps";

const ContainerConsole = dynamic(() => import("@/components/ContainerConsole"), { ssr: false });

interface Deployment {
  id: string;
  trigger: string;
  status: string;
  commitSha: string;
  commitMessage: string;
  imageRef: string;
  error: string;
  startedByEmail: string;
  rollbackOfId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
interface DomainRow { id: string; host: string; path: string; containerPort: number; service: string; https: boolean; redirectTo: string; redirectCode: number; basicAuthUser: string }
interface AppView extends Omit<AppFormValue, "endpointId"> {
  id: string;
  status: string;
  env: EnvRow[];
  currentDeploymentId: string | null;
  webhookUrl: string | null;
  endpoint: { id: string; name: string; proxyMode: string; status: string };
  environment: { id: string; name: string };
  project: { id: string; name: string };
  domains: DomainRow[];
  deployments: Deployment[];
  containers: AppContainer[] | null;
  can: { deploy: boolean; manage: boolean; secrets: boolean; logs: boolean; containerLogs: boolean; console: boolean };
  buildEndpointId: string | null;
  registryId: string | null;
  pullRegistryId: string | null;
  previewsEnabled: boolean;
  previewDomain: string;
  previewOfId: string | null;
  prNumber: number | null;
}

interface AppContainer { id: string; name: string; service: string; image: string; state: string; status: string }

type Tab = "overview" | "logs" | "deployments" | "console" | "environment" | "domains" | "settings";
const TABS: Tab[] = ["overview", "logs", "deployments", "console", "environment", "domains", "settings"];

/** Picks which of the app's containers the Logs and Console tabs show. Hidden for single-container apps. */
function ContainerPicker({ containers, value, onChange, endpointId }: { containers: AppContainer[]; value: string; onChange: (id: string) => void; endpointId: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      {containers.length > 1 &&
        containers.map((c) => (
          <button
            key={c.id}
            onClick={() => onChange(c.id)}
            aria-pressed={c.id === value}
            className={clsx(
              "flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm",
              c.id === value ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary hover:text-text-primary hover:bg-bg-secondary",
            )}
          >
            <span className={clsx("w-2 h-2 rounded-full", c.state === "running" ? "bg-success" : c.state === "restarting" ? "bg-warning" : "bg-text-muted")} />
            <span className="font-mono text-xs">{c.service || c.name}</span>
          </button>
        ))}
      <Link href={`/endpoints/${endpointId}/containers/${value}`} className="ml-auto text-xs text-text-muted hover:text-accent">Container details</Link>
    </div>
  );
}

function duration(d: Deployment) {
  if (!d.startedAt) return "";
  const end = d.finishedAt ? new Date(d.finishedAt).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(d.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function DeploymentLog({ appId, dep, canDeploy, isLive, onAction }: { appId: string; dep: Deployment; canDeploy: boolean; isLive: boolean; onAction: () => void }) {
  const api = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const [text, setText] = useState("");
  const [info, setInfo] = useState<Deployment>(dep);
  const offset = useRef(0);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stop = false;
    offset.current = 0;
    setText("");
    const poll = async () => {
      while (!stop) {
        const res = await api<Deployment & { log: string; next: number }>(`/api/apps/${appId}/deployments/${dep.id}?offset=${offset.current}`);
        if (!res.ok || stop) break;
        const d = res.data as Deployment & { log: string; next: number };
        if (d.log) setText((t) => t + d.log);
        offset.current = d.next;
        setInfo(d);
        if (d.status !== "queued" && d.status !== "running" && !d.log) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!stop) onAction();
    };
    poll();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, dep.id, api]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);

  const act = async (action: string) => {
    if (action === "rollback" && !(await confirm({ title: "Roll back to this deployment?", message: "DeployNow redeploys this version. The current one stops once the rollback is healthy.", confirmLabel: "Roll back", danger: false }))) return;
    const res = await api(`/api/apps/${appId}/deployments/${dep.id}`, { method: "POST", body: { action } });
    if (!res.ok) toast.error(res.data.error ?? "That didn't work");
    else toast.success(action === "rollback" ? "Rollback started" : "Deployment cancelled");
    onAction();
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Badge tone={appStatusTone(info.status)}>{info.status}</Badge>
        {isLive && <Badge tone="success">live</Badge>}
        <span className="text-xs text-text-muted">{info.trigger} · {duration(info)}</span>
        {info.error && <span className="text-xs text-danger break-words min-w-0">{info.error}</span>}
        <div className="ml-auto flex gap-2">
          {canDeploy && (info.status === "queued" || info.status === "running") && (
            <Button variant="danger" onClick={() => act("cancel")}><Square className="w-4 h-4" /> Cancel</Button>
          )}
          {canDeploy && info.status === "success" && !isLive && (
            <Button variant="secondary" onClick={() => act("rollback")}><RotateCcw className="w-4 h-4" /> Roll back to this</Button>
          )}
        </div>
      </div>
      <pre ref={box} className="bg-black/40 border border-border rounded-lg p-3 text-xs font-mono text-text-secondary h-[28rem] max-h-[60vh] overflow-auto whitespace-pre-wrap break-all">
        {text || (info.status === "queued" ? "Waiting for the worker…" : "No log output")}
      </pre>
    </div>
  );
}

export default function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = useApi();
  const router = useRouter();
  const search = useSearchParams();
  const confirm = useConfirm();
  const toast = useToast();
  const [app, setApp] = useState<AppView | null>(null);
  const tabParam = search.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "overview";
  const setTab = useCallback((t: Tab) => router.replace(t === "overview" ? `/apps/${id}` : `/apps/${id}?tab=${t}`, { scroll: false }), [router, id]);
  const [error, setError] = useState("");
  // Saved changes that only take effect on the next deploy
  const [pending, setPending] = useState("");
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<Deployment | null>(null);
  const [containerId, setContainerId] = useState("");
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [settings, setSettings] = useState<AppFormValue | null>(null);
  const [domain, setDomain] = useState({ host: "", path: "/", containerPort: "", service: "", https: true, kind: "route", redirectTo: "", redirectCode: "308", basicAuthUser: "", basicAuthPassword: "" });
  const [revealed, setRevealed] = useState<{ key: string; value: string } | null>(null);
  const [webhook, setWebhook] = useState<{ url: string; secret: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const envDirty = !!app && JSON.stringify(env) !== JSON.stringify(app.env);

  const load = useCallback(async () => {
    const res = await api<AppView>(`/api/apps/${id}`);
    if (!res.ok) return setError(res.data.error ?? "App not found");
    const a = res.data as AppView;
    setApp(a);
    return a;
  }, [api, id]);

  useEffect(() => {
    load().then((a) => {
      if (!a) return;
      setEnv(a.env);
      setSettings({ ...a, endpointId: a.endpoint.id });
    });
  }, [load]);

  // Opening the Deployments tab shows the newest deployment's log
  useEffect(() => {
    if (tab === "deployments" && !selected && app?.deployments[0]) setSelected(app.deployments[0]);
  }, [tab, selected, app]);

  // Keep the header fresh while something is deploying
  useEffect(() => {
    if (!app || !app.deployments.some((d) => d.status === "queued" || d.status === "running")) return;
    const t = setTimeout(load, 3000);
    return () => clearTimeout(t);
  }, [app, load]);

  const deploy = async () => {
    setBusy("deploy");
    setError("");
    const res = await api<Deployment>(`/api/apps/${id}/deploy`, { method: "POST", body: {} });
    setBusy("");
    if (!res.ok) return toast.error(res.data.error ?? "Could not start the deployment");
    setPending("");
    setSelected(res.data as Deployment);
    setTab("deployments");
    load();
  };

  const save = async (body: Record<string, unknown>, what: string): Promise<boolean> => {
    setBusy("save");
    setError("");
    const res = await api(`/api/apps/${id}`, { method: "PATCH", body });
    setBusy("");
    if (!res.ok) {
      toast.error(res.data.error ?? "Could not save");
      return false;
    }
    toast.success(`${what} saved`);
    setPending(`${what} changed.`);
    const a = await load();
    if (a) {
      setEnv(a.env);
      setSettings({ ...a, endpointId: a.endpoint.id });
    }
    return true;
  };

  const reveal = async (key: string) => {
    const res = await api<{ key: string; value: string }>(`/api/apps/${id}/env`, { method: "POST", body: { key } });
    if (res.ok) setRevealed(res.data as { key: string; value: string });
    else toast.error(res.data.error ?? "Could not reveal");
  };

  const addDomain = async () => {
    setBusy("domain");
    setError("");
    const res = await api(`/api/apps/${id}/domains`, {
      method: "POST",
      body: {
        host: domain.host,
        path: domain.path,
        service: domain.service,
        https: domain.https,
        containerPort: Number(domain.containerPort) || undefined,
        ...(domain.kind === "redirect" ? { redirectTo: domain.redirectTo, redirectCode: Number(domain.redirectCode) } : {}),
        ...(domain.kind === "auth" ? { basicAuthUser: domain.basicAuthUser, basicAuthPassword: domain.basicAuthPassword } : {}),
      },
    });
    setBusy("");
    if (!res.ok) return toast.error(res.data.error ?? "Could not add the domain");
    setDomain({ ...domain, host: "", path: "/", https: true, redirectTo: "", basicAuthPassword: "" });
    toast.success(`Added ${domain.host}`);
    setPending("Domains changed.");
    load();
  };

  const removeDomain = async (d: DomainRow) => {
    if (!(await confirm({ title: `Remove ${d.host}${d.path !== "/" ? d.path : ""}?`, message: "It stops routing to this app after the next deploy.", confirmLabel: "Remove" }))) return;
    const res = await api(`/api/apps/${id}/domains?domainId=${d.id}`, { method: "DELETE" });
    if (!res.ok) return toast.error(res.data.error ?? "Could not remove the domain");
    toast.success(`Removed ${d.host}`);
    setPending("Domains changed.");
    load();
  };

  const showWebhook = async (rotate: boolean) => {
    const res = await api<{ url: string; secret: string }>(`/api/apps/${id}/webhook`, { method: rotate ? "POST" : "GET" });
    if (res.ok) setWebhook(res.data as { url: string; secret: string });
    else toast.error(res.data.error ?? "Could not load the webhook");
  };

  const remove = async (keepContainers: boolean) => {
    setBusy("delete");
    const res = await api(`/api/apps/${id}`, { method: "DELETE", body: { keepContainers } });
    setBusy("");
    if (!res.ok) return toast.error(res.data.error ?? "Could not delete");
    toast.success(`Deleted ${app?.name}`);
    router.push(`/projects/${app?.project.id}`);
  };

  if (!app || !settings) return error ? <div className="max-w-6xl"><ErrorText>{error}</ErrorText></div> : <PageSkeleton />;

  const current = app.deployments.find((d) => d.id === app.currentDeploymentId);
  const active = app.deployments.find((d) => d.status === "queued" || d.status === "running");
  const isCompose = app.sourceType === "compose" || app.sourceType === "git-compose";
  const containers = app.containers ?? [];
  const container = containers.find((c) => c.id === containerId) ?? containers.find((c) => c.state === "running") ?? containers[0];
  const openContainer = (c: AppContainer, t: Tab) => {
    setContainerId(c.id);
    setTab(t);
  };
  // What the Logs and Console tabs show when there is no container to attach to
  const noContainer =
    app.containers === null ? (
      <p className="text-sm text-warning">Couldn&apos;t reach {app.endpoint.name}. Check that the endpoint is online.</p>
    ) : (
      <div className="text-sm text-text-muted space-y-3 py-6 text-center">
        <p>{app.deployments.length ? "No containers are running for this app." : "Deploy the app to see its logs and open a console."}</p>
        {app.can.deploy && !active && <Button onClick={deploy} loading={busy === "deploy"}><Rocket className="w-4 h-4" /> Deploy now</Button>}
      </div>
    );

  return (
    <div className="max-w-6xl">
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: app.project.name, href: `/projects/${app.project.id}` }, { label: app.environment.name }]}
        title={app.name}
        subtitle={
          <span className="flex items-center flex-wrap gap-2">
            <Badge tone={appStatusTone(app.status)}>{app.status}</Badge>
            <span>{SOURCE_LABELS[app.sourceType]} on {app.endpoint.name}</span>
          </span>
        }
        actions={app.can.deploy && <Button onClick={deploy} loading={busy === "deploy"} disabled={!!active}><Rocket className="w-4 h-4" /> {active ? "Deploying…" : "Deploy"}</Button>}
      />

      <div role="tablist" className="flex gap-1 border-b border-border mb-4 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={clsx("px-3 py-2 text-sm capitalize border-b-2 -mb-px whitespace-nowrap", tab === t ? "border-accent text-text-primary" : "border-transparent text-text-muted hover:text-text-primary")}
          >
            {t}
            {t === "domains" && app.domains.length > 0 && <span className="ml-1.5 text-xs text-text-muted">{app.domains.length}</span>}
            {t === "environment" && app.env.length > 0 && <span className="ml-1.5 text-xs text-text-muted">{app.env.length}</span>}
          </button>
        ))}
      </div>

      <div className="space-y-3 mb-4">
        <ErrorText>{error}</ErrorText>
        {pending && app.can.deploy && !active && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent/10 px-4 py-2.5">
            <Info className="w-4 h-4 text-accent flex-shrink-0" />
            <p className="text-sm text-text-primary flex-1 min-w-[12rem]">{pending} Deploy to apply it to the running app.</p>
            <Button variant="ghost" onClick={() => setPending("")}>Later</Button>
            <Button onClick={deploy} loading={busy === "deploy"}><Rocket className="w-4 h-4" /> Deploy now</Button>
          </div>
        )}
      </div>

      {tab === "overview" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Running now</h3>
            {current ? (
              <div className="text-sm space-y-1">
                <p className="text-text-secondary">Deployed {timeAgo(current.finishedAt)} by {current.startedByEmail || current.trigger}</p>
                {current.commitSha && <p className="font-mono text-xs text-text-muted">{current.commitSha.slice(0, 12)} {current.commitMessage}</p>}
                {current.imageRef && <p className="font-mono text-xs text-text-muted break-all">{current.imageRef}</p>}
              </div>
            ) : (
              <div className="text-sm text-text-muted space-y-3">
                <p>Not deployed yet. Add environment variables and a domain if it needs them, then deploy.</p>
                {app.can.deploy && <Button onClick={deploy} loading={busy === "deploy"}><Rocket className="w-4 h-4" /> Deploy now</Button>}
              </div>
            )}
            <div className="mt-4 space-y-1.5">
              {app.containers === null && <p className="text-xs text-warning">Couldn&apos;t reach {app.endpoint.name}</p>}
              {app.containers?.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-sm">
                  <Badge tone={stateTone(c.state)}>{c.state}</Badge>
                  <Link href={`/endpoints/${app.endpoint.id}/containers/${c.id}`} className="font-mono text-xs hover:text-accent">{c.service || c.name}</Link>
                  <span className="text-xs text-text-muted truncate min-w-0 flex-1">{c.status}</span>
                  {app.can.containerLogs && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" aria-label={`Logs of ${c.service || c.name}`} onClick={() => openContainer(c, "logs")}><ScrollText className="w-3.5 h-3.5" /> Logs</Button>
                  )}
                  {app.can.console && c.state === "running" && (
                    <Button variant="ghost" className="!px-2 !py-1 text-xs" aria-label={`Console in ${c.service || c.name}`} onClick={() => openContainer(c, "console")}><SquareTerminal className="w-3.5 h-3.5" /> Console</Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Domains</h3>
            {app.domains.length === 0 ? (
              <p className="text-sm text-text-muted">
                No domains yet.{" "}
                <button className="text-accent hover:underline" onClick={() => setTab("domains")}>Add one</button>
              </p>
            ) : (
              app.domains.map((d) => (
                <a key={d.id} href={`${d.https ? "https" : "http"}://${d.host}${d.path}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm text-text-primary hover:text-accent">
                  <Globe className="w-4 h-4" /> {d.host}{d.path !== "/" ? d.path : ""} <ExternalLink className="w-3 h-3" />
                </a>
              ))
            )}
            <h3 className="text-sm font-semibold text-text-primary mt-5 mb-2">Recent deployments</h3>
            {app.deployments.slice(0, 5).map((d) => (
              <button key={d.id} onClick={() => { setSelected(d); setTab("deployments"); }} className="flex w-full items-center gap-2 text-sm py-1 hover:text-accent">
                <Badge tone={appStatusTone(d.status)}>{d.status}</Badge>
                <span className="text-xs text-text-muted">{d.trigger}</span>
                <span className="text-xs text-text-muted ml-auto">{timeAgo(d.createdAt)}</span>
              </button>
            ))}
          </Card>
        </div>
      )}
      {tab === "overview" && <div className="mt-4"><ResourceHistory appId={id} /></div>}

      {tab === "logs" && (
        <Card className="p-4">
          {!app.can.containerLogs ? (
            <p className="text-sm text-text-muted">Operators and above can read app logs.</p>
          ) : !container ? (
            noContainer
          ) : (
            <>
              <ContainerPicker containers={containers} value={container.id} onChange={setContainerId} endpointId={app.endpoint.id} />
              <ContainerLogs key={container.id} endpointId={app.endpoint.id} containerId={container.id} />
            </>
          )}
        </Card>
      )}

      {tab === "console" && (
        <Card className="p-4">
          {!app.can.console ? (
            <p className="text-sm text-text-muted">Operators and above can open a console.</p>
          ) : !container ? (
            noContainer
          ) : (
            <>
              <ContainerPicker containers={containers} value={container.id} onChange={setContainerId} endpointId={app.endpoint.id} />
              {container.state === "running" ? (
                <ContainerConsole key={container.id} api={api} endpointId={app.endpoint.id} containerId={container.id} />
              ) : (
                <p className="text-sm text-text-muted">{container.service || container.name} isn&apos;t running. Deploy or start it to open a console.</p>
              )}
            </>
          )}
        </Card>
      )}

      {tab === "deployments" && (
        <div className="grid gap-4 md:grid-cols-[280px_1fr]">
          <Card className="overflow-hidden self-start">
            {app.deployments.length === 0 && <p className="text-sm text-text-muted p-4">No deployments yet</p>}
            {app.deployments.map((d, i) => (
              <button key={d.id} onClick={() => setSelected(d)} className={clsx("w-full text-left px-3 py-2.5", i && "border-t border-border", selected?.id === d.id ? "bg-accent/10" : "hover:bg-bg-secondary")}>
                <div className="flex items-center gap-2">
                  <Badge tone={appStatusTone(d.status)}>{d.status}</Badge>
                  <span className="text-xs text-text-secondary">{d.trigger}</span>
                  {d.id === app.currentDeploymentId && <span className="text-xs text-success">live</span>}
                  <span className="text-xs text-text-muted ml-auto">{timeAgo(d.createdAt)}</span>
                </div>
                <p className="text-xs text-text-muted font-mono truncate mt-1">{d.commitSha ? `${d.commitSha.slice(0, 8)} ${d.commitMessage}` : d.imageRef || d.id.slice(-8)}</p>
              </button>
            ))}
          </Card>
          <Card className="p-4">
            {selected ? (
              app.can.logs ? (
                <DeploymentLog key={selected.id} appId={id} dep={selected} canDeploy={app.can.deploy} isLive={selected.id === app.currentDeploymentId} onAction={load} />
              ) : (
                <p className="text-sm text-text-muted">Operators and above can read deploy logs.</p>
              )
            ) : (
              <p className="text-sm text-text-muted py-10 text-center">{app.deployments.length ? "Pick a deployment on the left to see its log." : "Deploy the app to see its log here."}</p>
            )}
          </Card>
        </div>
      )}

      {tab === "environment" && (
        <Card className="p-5">
          <p className="text-sm text-text-muted mb-4">
            {isCompose
              ? "These values are available to the compose file as ${NAME}, and are written to .env next to it: load them all into a service with `env_file: .env`, or pass one through with `environment: [NAME]`."
              : "Passed to the container as environment variables."}{" "}
            Secrets are encrypted and never shown again; Vault values are read from Vault at each deploy. Both are masked in deploy logs.
          </p>
          {app.can.secrets ? (
            <>
              <EnvEditor
                rows={env}
                onChange={setEnv}
                canReveal
                onReveal={reveal}
                onImport={(rows) => {
                  setEnv(rows);
                  return save({ env: rows }, "Environment");
                }}
              />
              <div className="flex items-center justify-end gap-3 mt-4">
                {envDirty && <span className="text-xs text-warning">Unsaved changes</span>}
                <Button onClick={() => save({ env }, "Environment")} loading={busy === "save"}>Save</Button>
              </div>
            </>
          ) : (
            <div className="space-y-1">
              {app.env.map((e) => (
                <div key={e.key} className="flex gap-3 font-mono text-xs">
                  <span className="text-text-primary w-56">{e.key}</span>
                  <span className="text-text-muted">{e.kind === "secret" ? <Lock className="w-3 h-3 inline" /> : e.value}</span>
                </div>
              ))}
              <p className="text-xs text-text-muted mt-3">Admins of this project can change environment variables.</p>
            </div>
          )}
        </Card>
      )}

      {tab === "domains" && (
        <Card className="p-5 space-y-4">
          {app.endpoint.proxyMode === "none" ? (
            <p className="text-sm text-warning">
              {app.endpoint.name} has no edge proxy yet. <Link className="underline" href={`/endpoints/${app.endpoint.id}`}>Set one up on the endpoint page</Link>, then add domains here.
            </p>
          ) : (
            <p className="text-sm text-text-muted">
              Traffic is routed by {app.endpoint.proxyMode === "managed" ? "DeployNow's Traefik" : "the existing Traefik"} on {app.endpoint.name}. Point the domain&apos;s DNS at that machine; HTTPS certificates come from Let&apos;s Encrypt.
            </p>
          )}
          {app.domains.length === 0 && app.endpoint.proxyMode !== "none" && <p className="text-sm text-text-primary">No domains yet. Add the first one below.</p>}
          {app.domains.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <Globe className="w-4 h-4 text-text-muted" />
              <span className="font-mono">{d.host}{d.path !== "/" ? d.path : ""}</span>
              <span className="text-text-muted">→ {d.redirectTo ? `${d.redirectTo} (${d.redirectCode})` : `${d.service ? `${d.service}:` : ""}${d.containerPort}`}</span>
              <Badge tone={d.https ? "success" : "muted"}>{d.https ? "HTTPS" : "HTTP only"}</Badge>
              {d.basicAuthUser && <Badge tone="warning">password: {d.basicAuthUser}</Badge>}
              {app.can.manage && <IconButton label={`Remove ${d.host}`} className="ml-auto" onClick={() => removeDomain(d)}><Trash2 className="w-4 h-4" /></IconButton>}
            </div>
          ))}
          {app.can.manage && app.endpoint.proxyMode !== "none" && (
            <div className="grid grid-cols-12 gap-2 items-end pt-2 border-t border-border">
              <div className="col-span-12 flex flex-wrap gap-2">
                {([["route", "Route to the app"], ["auth", "Route with a password"], ["redirect", "Redirect elsewhere"]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setDomain({ ...domain, kind: k })} className={`px-2.5 py-1 rounded-lg border text-xs ${domain.kind === k ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary"}`}>{label}</button>
                ))}
              </div>
              {domain.kind === "redirect" && (
                <>
                  <div className="col-span-12 sm:col-span-8"><Field label="Redirect to"><Input value={domain.redirectTo} onChange={(e) => setDomain({ ...domain, redirectTo: e.target.value })} placeholder="https://example.com" /></Field></div>
                  <div className="col-span-12 sm:col-span-4">
                    <Field label="Status">
                      <Select value={domain.redirectCode} onChange={(e) => setDomain({ ...domain, redirectCode: e.target.value })}>
                        <option value="308">308 permanent</option>
                        <option value="301">301 permanent</option>
                        <option value="307">307 temporary</option>
                        <option value="302">302 temporary</option>
                      </Select>
                    </Field>
                  </div>
                </>
              )}
              {domain.kind === "auth" && (
                <>
                  <div className="col-span-12 sm:col-span-6"><Field label="User name"><Input value={domain.basicAuthUser} onChange={(e) => setDomain({ ...domain, basicAuthUser: e.target.value })} autoComplete="off" /></Field></div>
                  <div className="col-span-12 sm:col-span-6"><Field label="Password (8+ characters)"><Input type="password" value={domain.basicAuthPassword} onChange={(e) => setDomain({ ...domain, basicAuthPassword: e.target.value })} autoComplete="new-password" /></Field></div>
                </>
              )}
              <div className="col-span-12 md:col-span-4"><Field label="Domain"><Input value={domain.host} onChange={(e) => setDomain({ ...domain, host: e.target.value })} placeholder="app.example.com" /></Field></div>
              <div className="col-span-6 md:col-span-2"><Field label="Path"><Input value={domain.path} onChange={(e) => setDomain({ ...domain, path: e.target.value })} /></Field></div>
              {isCompose && <div className="col-span-6 md:col-span-2"><Field label="Service"><Input value={domain.service} onChange={(e) => setDomain({ ...domain, service: e.target.value })} placeholder="web" /></Field></div>}
              <div className="col-span-6 md:col-span-2"><Field label="Container port"><Input type="number" value={domain.containerPort} onChange={(e) => setDomain({ ...domain, containerPort: e.target.value })} placeholder="3000" /></Field></div>
              <label className="col-span-3 md:col-span-1 flex items-center gap-1.5 text-xs text-text-secondary pb-2.5">
                <input type="checkbox" checked={domain.https} onChange={(e) => setDomain({ ...domain, https: e.target.checked })} /> HTTPS
              </label>
              <div className="col-span-3 md:col-span-1"><Button className="w-full" title="Add domain" onClick={addDomain} loading={busy === "domain"} disabled={!domain.host || (domain.kind === "redirect" ? !domain.redirectTo : !domain.containerPort)}><Plus className="w-4 h-4" /> <span className="md:hidden">Add</span></Button></div>
            </div>
          )}
        </Card>
      )}

      {tab === "settings" && (
        <div className="space-y-4">
          <Card className="p-5">
            <AppForm value={settings} onChange={setSettings} endpoints={[app.endpoint]} isNew={false} />
            {app.can.manage && (
              <div className="flex justify-end mt-4">
                <Button
                  onClick={() => {
                    // Only the form's own fields; env has its own tab
                    const keys = Object.keys(emptyApp).filter((k) => k !== "endpointId" && k !== "slug") as (keyof AppFormValue)[];
                    save(Object.fromEntries(keys.map((k) => [k, settings[k]])), "Settings");
                  }}
                  loading={busy === "save"}
                >
                  Save
                </Button>
              </div>
            )}
          </Card>

          {app.can.manage && (app.sourceType !== "image" || !!app.image) && <AppRegistryLogin app={app} onSave={save} busy={busy === "save"} />}

          {(app.sourceType === "git-dockerfile" || (app.sourceType === "git-compose" && !app.previewOfId)) && app.can.manage && (
            <AppBuildSettings app={app} onSave={save} busy={busy === "save"} />
          )}

          {(app.sourceType === "git-dockerfile" || app.sourceType === "git-compose") && app.can.manage && (
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><Webhook className="w-4 h-4" /> GitHub webhook</h3>
              <p className="text-sm text-text-muted mb-3">
                In the repository: Settings → Webhooks → Add webhook, content type <code>application/json</code>, with the push event (and pull request events for previews). Then set Updates to &quot;Deploy on every push&quot;. DeployNow must be reachable from GitHub.
              </p>
              {webhook ? (
                <div className="space-y-2">
                  <Field label="Payload URL"><Input readOnly value={webhook.url} className="font-mono" /></Field>
                  <Field label="Secret"><Input readOnly value={webhook.secret} className="font-mono" /></Field>
                  <Button variant="secondary" onClick={() => showWebhook(true)}>Make a new secret</Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => showWebhook(false)}><Copy className="w-4 h-4" /> Show URL and secret</Button>
              )}
            </Card>
          )}

          {app.can.manage && (
            <Card className="p-5 border-danger/40">
              <h3 className="text-sm font-semibold text-danger mb-1">Delete app</h3>
              <p className="text-sm text-text-muted mb-3">Stops and removes its containers. Named volumes are kept.</p>
              <Button variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 className="w-4 h-4" /> Delete {app.name}</Button>
            </Card>
          )}
        </div>
      )}

      {revealed && (
        <Modal icon={Eye} title={revealed.key} onClose={() => setRevealed(null)}>
          <Input readOnly value={revealed.value} className="font-mono" onFocus={(e) => e.target.select()} />
          <p className="text-xs text-text-muted mt-2">This view was written to the audit log.</p>
          <div className="flex justify-end mt-4"><Button onClick={() => setRevealed(null)}>Done</Button></div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal icon={Trash2} tone="danger" title={`Delete ${app.name}?`} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-text-secondary mb-4">Its deployments, logs and settings are removed from DeployNow.</p>
          <div className="flex flex-col gap-2">
            <Button variant="danger" onClick={() => remove(false)} loading={busy === "delete"}>Delete and remove containers</Button>
            <Button variant="secondary" onClick={() => remove(true)}>Delete but keep the containers running</Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
