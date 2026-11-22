"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ArrowLeft, Copy, ExternalLink, Globe, Lock, Plus, Rocket, RotateCcw, Square, Trash2, Webhook } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, stateTone, timeAgo } from "@/components/ui";
import { AppBuildSettings } from "@/components/AppBuildSettings";
import { AppForm, appStatusTone, emptyApp, EnvEditor, SOURCE_LABELS, type AppFormValue, type EnvRow } from "@/components/apps";

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
  containers: { id: string; name: string; service: string; image: string; state: string; status: string }[] | null;
  can: { deploy: boolean; manage: boolean; secrets: boolean; logs: boolean };
  buildEndpointId: string | null;
  registryId: string | null;
  previewsEnabled: boolean;
  previewDomain: string;
  previewOfId: string | null;
  prNumber: number | null;
}

type Tab = "overview" | "deployments" | "environment" | "domains" | "settings";

function duration(d: Deployment) {
  if (!d.startedAt) return "";
  const end = d.finishedAt ? new Date(d.finishedAt).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(d.startedAt).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function DeploymentLog({ appId, dep, canDeploy, onAction }: { appId: string; dep: Deployment; canDeploy: boolean; onAction: () => void }) {
  const api = useApi();
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
    await api(`/api/apps/${appId}/deployments/${dep.id}`, { method: "POST", body: { action } });
    onAction();
  };

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Badge tone={appStatusTone(info.status)}>{info.status}</Badge>
        <span className="text-xs text-text-muted">{info.trigger} · {duration(info)}</span>
        {info.error && <span className="text-xs text-danger truncate">{info.error}</span>}
        <div className="ml-auto flex gap-2">
          {canDeploy && (info.status === "queued" || info.status === "running") && (
            <Button variant="danger" onClick={() => act("cancel")}><Square className="w-4 h-4" /> Cancel</Button>
          )}
          {canDeploy && info.status === "success" && (
            <Button variant="secondary" onClick={() => act("rollback")}><RotateCcw className="w-4 h-4" /> Roll back to this</Button>
          )}
        </div>
      </div>
      <pre ref={box} className="bg-black/40 border border-border rounded-lg p-3 text-xs font-mono text-text-secondary h-96 overflow-auto whitespace-pre-wrap break-all">
        {text || (info.status === "queued" ? "Waiting for the worker…" : "No log output")}
      </pre>
    </div>
  );
}

export default function AppPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = useApi();
  const router = useRouter();
  const [app, setApp] = useState<AppView | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [selected, setSelected] = useState<Deployment | null>(null);
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [settings, setSettings] = useState<AppFormValue | null>(null);
  const [domain, setDomain] = useState({ host: "", path: "/", containerPort: "", service: "", https: true, kind: "route", redirectTo: "", redirectCode: "308", basicAuthUser: "", basicAuthPassword: "" });
  const [revealed, setRevealed] = useState<{ key: string; value: string } | null>(null);
  const [webhook, setWebhook] = useState<{ url: string; secret: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    if (!res.ok) return setError(res.data.error ?? "Could not start the deployment");
    setSelected(res.data as Deployment);
    setTab("deployments");
    load();
  };

  const save = async (body: Record<string, unknown>, what: string) => {
    setBusy("save");
    setError("");
    setNotice("");
    const res = await api(`/api/apps/${id}`, { method: "PATCH", body });
    setBusy("");
    if (!res.ok) return setError(res.data.error ?? "Could not save");
    setNotice(`${what} saved. Deploy to apply.`);
    const a = await load();
    if (a) {
      setEnv(a.env);
      setSettings({ ...a, endpointId: a.endpoint.id });
    }
  };

  const reveal = async (key: string) => {
    const res = await api<{ key: string; value: string }>(`/api/apps/${id}/env`, { method: "POST", body: { key } });
    if (res.ok) setRevealed(res.data as { key: string; value: string });
    else setError(res.data.error ?? "Could not reveal");
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
    if (!res.ok) return setError(res.data.error ?? "Could not add the domain");
    setDomain({ ...domain, host: "", path: "/", https: true, redirectTo: "", basicAuthPassword: "" });
    setNotice("Domain added. Deploy to apply.");
    load();
  };

  const removeDomain = async (domainId: string) => {
    await api(`/api/apps/${id}/domains?domainId=${domainId}`, { method: "DELETE" });
    setNotice("Domain removed. Deploy to apply.");
    load();
  };

  const showWebhook = async (rotate: boolean) => {
    const res = await api<{ url: string; secret: string }>(`/api/apps/${id}/webhook`, { method: rotate ? "POST" : "GET" });
    if (res.ok) setWebhook(res.data as { url: string; secret: string });
    else setError(res.data.error ?? "Could not load the webhook");
  };

  const remove = async (keepContainers: boolean) => {
    setBusy("delete");
    const res = await api(`/api/apps/${id}`, { method: "DELETE", body: { keepContainers } });
    setBusy("");
    if (!res.ok) return setError(res.data.error ?? "Could not delete");
    router.push(`/projects/${app?.project.id}`);
  };

  if (!app || !settings) return <div className="max-w-6xl">{error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-text-muted">Loading…</p>}</div>;

  const current = app.deployments.find((d) => d.id === app.currentDeploymentId);
  const active = app.deployments.find((d) => d.status === "queued" || d.status === "running");
  const isCompose = app.sourceType === "compose" || app.sourceType === "git-compose";

  return (
    <div className="max-w-6xl">
      <Link href={`/projects/${app.project.id}`} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-3">
        <ArrowLeft className="w-4 h-4" /> {app.project.name} / {app.environment.name}
      </Link>
      <PageHeader
        title={app.name}
        subtitle={
          <span className="flex items-center gap-2">
            <Badge tone={appStatusTone(app.status)}>{app.status}</Badge>
            <span>{SOURCE_LABELS[app.sourceType]} on {app.endpoint.name}</span>
          </span>
        }
        actions={app.can.deploy && <Button onClick={deploy} loading={busy === "deploy"} disabled={!!active}><Rocket className="w-4 h-4" /> {active ? "Deploying…" : "Deploy"}</Button>}
      />

      <div className="flex gap-1 border-b border-border mb-4">
        {(["overview", "deployments", "environment", "domains", "settings"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={clsx("px-3 py-2 text-sm capitalize border-b-2 -mb-px", tab === t ? "border-accent text-text-primary" : "border-transparent text-text-muted hover:text-text-primary")}>
            {t}
          </button>
        ))}
      </div>

      <div className="space-y-3 mb-4">
        <ErrorText>{error}</ErrorText>
        {notice && <p className="text-xs text-accent bg-accent/10 rounded-lg px-3 py-2">{notice}</p>}
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
              <p className="text-sm text-text-muted">Not deployed yet.</p>
            )}
            <div className="mt-4 space-y-1.5">
              {app.containers === null && <p className="text-xs text-warning">Couldn&apos;t reach {app.endpoint.name}</p>}
              {app.containers?.map((c) => (
                <Link key={c.id} href={`/endpoints/${app.endpoint.id}/containers/${c.id}`} className="flex items-center gap-2 text-sm hover:text-accent">
                  <Badge tone={stateTone(c.state)}>{c.state}</Badge>
                  <span className="font-mono text-xs">{c.service || c.name}</span>
                  <span className="text-xs text-text-muted truncate">{c.status}</span>
                </Link>
              ))}
            </div>
          </Card>
          <Card className="p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-3">Domains</h3>
            {app.domains.length === 0 ? (
              <p className="text-sm text-text-muted">No domains. Add one in the Domains tab.</p>
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
                <DeploymentLog key={selected.id} appId={id} dep={selected} canDeploy={app.can.deploy} onAction={load} />
              ) : (
                <p className="text-sm text-text-muted">Operators and above can read deploy logs.</p>
              )
            ) : (
              <p className="text-sm text-text-muted">Pick a deployment to see its log.</p>
            )}
          </Card>
        </div>
      )}

      {tab === "environment" && (
        <Card className="p-5">
          <p className="text-sm text-text-muted mb-4">
            {isCompose
              ? "These values are available to the compose file as ${NAME}, or pass one through with `environment: [NAME]`."
              : "Passed to the container as environment variables."}{" "}
            Secrets are encrypted and never shown again; Vault values are read from Vault at each deploy. Both are masked in deploy logs.
          </p>
          {app.can.secrets ? (
            <>
              <EnvEditor rows={env} onChange={setEnv} canReveal onReveal={reveal} />
              <div className="flex justify-end mt-4">
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
          {app.domains.map((d) => (
            <div key={d.id} className="flex items-center gap-3 text-sm">
              <Globe className="w-4 h-4 text-text-muted" />
              <span className="font-mono">{d.host}{d.path !== "/" ? d.path : ""}</span>
              <span className="text-text-muted">→ {d.redirectTo ? `${d.redirectTo} (${d.redirectCode})` : `${d.service ? `${d.service}:` : ""}${d.containerPort}`}</span>
              <Badge tone={d.https ? "success" : "muted"}>{d.https ? "HTTPS" : "HTTP only"}</Badge>
              {d.basicAuthUser && <Badge tone="warning">password: {d.basicAuthUser}</Badge>}
              {app.can.manage && <Button variant="ghost" className="ml-auto" onClick={() => removeDomain(d.id)}><Trash2 className="w-4 h-4" /></Button>}
            </div>
          ))}
          {app.can.manage && app.endpoint.proxyMode !== "none" && (
            <div className="grid grid-cols-12 gap-2 items-end pt-2 border-t border-border">
              <div className="col-span-12 flex gap-2">
                {([["route", "Route to the app"], ["auth", "Route with a password"], ["redirect", "Redirect elsewhere"]] as const).map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setDomain({ ...domain, kind: k })} className={`px-2.5 py-1 rounded-lg border text-xs ${domain.kind === k ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary"}`}>{label}</button>
                ))}
              </div>
              {domain.kind === "redirect" && (
                <>
                  <div className="col-span-8"><Field label="Redirect to"><Input value={domain.redirectTo} onChange={(e) => setDomain({ ...domain, redirectTo: e.target.value })} placeholder="https://example.com" /></Field></div>
                  <div className="col-span-4">
                    <Field label="Status">
                      <select value={domain.redirectCode} onChange={(e) => setDomain({ ...domain, redirectCode: e.target.value })} className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary">
                        <option value="308">308 permanent</option>
                        <option value="301">301 permanent</option>
                        <option value="307">307 temporary</option>
                        <option value="302">302 temporary</option>
                      </select>
                    </Field>
                  </div>
                </>
              )}
              {domain.kind === "auth" && (
                <>
                  <div className="col-span-6"><Field label="User name"><Input value={domain.basicAuthUser} onChange={(e) => setDomain({ ...domain, basicAuthUser: e.target.value })} autoComplete="off" /></Field></div>
                  <div className="col-span-6"><Field label="Password (8+ characters)"><Input type="password" value={domain.basicAuthPassword} onChange={(e) => setDomain({ ...domain, basicAuthPassword: e.target.value })} autoComplete="new-password" /></Field></div>
                </>
              )}
              <div className="col-span-4"><Field label="Domain"><Input value={domain.host} onChange={(e) => setDomain({ ...domain, host: e.target.value })} placeholder="app.example.com" /></Field></div>
              <div className="col-span-2"><Field label="Path"><Input value={domain.path} onChange={(e) => setDomain({ ...domain, path: e.target.value })} /></Field></div>
              {isCompose && <div className="col-span-2"><Field label="Service"><Input value={domain.service} onChange={(e) => setDomain({ ...domain, service: e.target.value })} placeholder="web" /></Field></div>}
              <div className="col-span-2"><Field label="Container port"><Input type="number" value={domain.containerPort} onChange={(e) => setDomain({ ...domain, containerPort: e.target.value })} placeholder="3000" /></Field></div>
              <label className="col-span-1 flex items-center gap-1.5 text-xs text-text-secondary pb-2.5">
                <input type="checkbox" checked={domain.https} onChange={(e) => setDomain({ ...domain, https: e.target.checked })} /> HTTPS
              </label>
              <div className="col-span-1"><Button onClick={addDomain} loading={busy === "domain"} disabled={!domain.host || (domain.kind === "redirect" ? !domain.redirectTo : !domain.containerPort)}><Plus className="w-4 h-4" /></Button></div>
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

          {(app.sourceType === "git-dockerfile" || (app.sourceType === "git-compose" && !app.previewOfId)) && app.can.manage && (
            <AppBuildSettings app={app} onSave={save} busy={busy === "save"} />
          )}

          {(app.sourceType === "git-dockerfile" || app.sourceType === "git-compose") && app.can.manage && (
            <Card className="p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><Webhook className="w-4 h-4" /> GitHub webhook</h3>
              <p className="text-sm text-text-muted mb-3">
                In the repository: Settings → Webhooks → Add webhook, content type <code>application/json</code>, just the push event. Then set Updates to &quot;Deploy on every push&quot;. DeployNow must be reachable from GitHub.
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
        <Modal title={revealed.key} onClose={() => setRevealed(null)}>
          <Input readOnly value={revealed.value} className="font-mono" onFocus={(e) => e.target.select()} />
          <p className="text-xs text-text-muted mt-2">This view was written to the audit log.</p>
          <div className="flex justify-end mt-4"><Button onClick={() => setRevealed(null)}>Done</Button></div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title={`Delete ${app.name}?`} onClose={() => setConfirmDelete(false)}>
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
