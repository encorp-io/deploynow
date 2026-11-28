"use client";

/**
 * Containers DeployNow doesn't manage: the "Not managed by DeployNow" folder on
 * the Projects page, and the dialog that turns a compose stack into an app.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Boxes, ChevronDown, FolderInput, FolderOpen, Layers } from "lucide-react";
import { clsx } from "clsx";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Modal, Select, Skeleton, TextArea, stateTone } from "@/components/ui";

export const STANDALONE = "_standalone";

export interface ExternalContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  service: string | null;
  ports: string[];
  leftover: boolean;
}
interface ExternalStack { name: string; workingDir: string | null; configFiles: string | null; containers: ExternalContainer[]; running: number; appId: string | null }
interface EndpointExternal {
  id: string;
  name: string;
  status: string;
  error: string | null;
  stacks: ExternalStack[];
  standalone: ExternalContainer[];
}

export function stackHref(endpointId: string, stack: string) {
  return `/projects/external/${endpointId}/${encodeURIComponent(stack)}`;
}

const FOLDER_KEY = "dn-external-open";

function StackCard({ href, icon: Icon, title, badge, sub, containers }: { href: string; icon: typeof Layers; title: string; badge: string; sub: string; containers: ExternalContainer[] }) {
  return (
    <Link href={href} className="group rounded-2xl">
      <Card className="p-5 h-full transition-all duration-200 group-hover:border-border-bright group-hover:-translate-y-0.5">
        <div className="flex items-start gap-3.5 mb-3">
          <span aria-hidden className="w-10 h-10 rounded-xl bg-bg-secondary border border-border flex items-center justify-center text-text-secondary flex-shrink-0">
            <Icon className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-semibold tracking-[-0.01em] text-text-primary truncate group-hover:text-accent transition-colors">{title}</h3>
              <Badge>{badge}</Badge>
            </div>
            <p className="text-sm text-text-muted truncate">{sub}</p>
          </div>
        </div>
        <div className="dn-hairline -mx-5 mb-3 opacity-60" />
        <div className="flex flex-wrap gap-1.5">
          {containers.slice(0, 8).map((c) => (
            <Badge key={c.id} tone={c.leftover ? "warning" : stateTone(c.state)}>{c.service ?? c.name}</Badge>
          ))}
          {containers.length > 8 && <span className="text-xs text-text-muted">+{containers.length - 8} more</span>}
        </div>
      </Card>
    </Link>
  );
}

/** The folder of containers that run on the endpoints without DeployNow managing them. */
export function ExternalSection() {
  const api = useApi();
  const [data, setData] = useState<EndpointExternal[] | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(FOLDER_KEY) === "0") setOpen(false);
    } catch {
      /* no storage */
    }
  }, []);
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(FOLDER_KEY, o ? "0" : "1");
      } catch {
        /* no storage */
      }
      return !o;
    });
  };

  const load = useCallback(async () => {
    const res = await api<{ endpoints: EndpointExternal[] }>("/api/external");
    setData(res.ok ? (res.data as { endpoints: EndpointExternal[] }).endpoints : []);
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  if (data === null) return <Skeleton className="h-16 mt-8" />;
  const withContent = data.filter((e) => e.stacks.length || e.standalone.length);
  const failed = data.filter((e) => e.error);
  if (!withContent.length && !failed.length) return null;
  const total = withContent.reduce((n, e) => n + e.standalone.length + e.stacks.reduce((m, s) => m + s.containers.length, 0), 0);
  const stacks = withContent.reduce((n, e) => n + e.stacks.length, 0);
  const several = data.length > 1;

  return (
    <section className="mt-10" aria-labelledby="external-heading">
      <button type="button" onClick={toggle} aria-expanded={open} className="w-full flex items-center gap-3 text-left group">
        <span aria-hidden className="w-9 h-9 rounded-xl bg-bg-secondary border border-border flex items-center justify-center text-text-secondary">
          <FolderOpen className="w-[18px] h-[18px]" />
        </span>
        <span className="flex-1 min-w-0">
          <span id="external-heading" className="block font-semibold text-text-primary group-hover:text-accent transition-colors">Not managed by DeployNow</span>
          <span className="block text-sm text-text-muted">
            {total} container{total === 1 ? "" : "s"}{stacks ? `, ${stacks} compose stack${stacks === 1 ? "" : "s"}` : ""} that already ran on your servers. Open one to see logs, use the console or restart it.
          </span>
        </span>
        <ChevronDown className={clsx("w-5 h-5 text-text-muted transition-transform", !open && "-rotate-90")} />
      </button>

      {open && (
        <div className="mt-4 space-y-6">
          {withContent.map((e) => (
            <div key={e.id}>
              {several && <h3 className="text-xs font-medium uppercase tracking-wide text-text-muted mb-2">{e.name}</h3>}
              <div className="grid gap-4 md:grid-cols-2">
                {e.stacks.map((s) => (
                  <StackCard
                    key={s.name}
                    href={stackHref(e.id, s.name)}
                    icon={Layers}
                    title={s.name}
                    badge={s.appId ? "deploy to take over" : "compose"}
                    sub={`${s.running} of ${s.containers.length} running${s.workingDir ? ` · ${s.workingDir}` : ""}`}
                    containers={s.containers}
                  />
                ))}
                {e.standalone.length > 0 && (
                  <StackCard
                    href={stackHref(e.id, STANDALONE)}
                    icon={Boxes}
                    title="Standalone containers"
                    badge="docker run"
                    sub={`${e.standalone.filter((c) => c.state === "running").length} of ${e.standalone.length} running`}
                    containers={e.standalone}
                  />
                )}
              </div>
            </div>
          ))}
          {failed.map((e) => (
            <p key={e.id} className="text-xs text-text-muted">Couldn&apos;t list the containers on {e.name}: {e.error}</p>
          ))}
        </div>
      )}
    </section>
  );
}

interface ProjectOption { id: string; name: string; environments: { id: string; name: string }[] }
interface Plan {
  stack: string;
  slug: string;
  inPlace: boolean;
  yaml: string;
  services: string[];
  warnings: string[];
  blocker: string | null;
  env: { key: string; kind: "plain" | "secret" }[];
  taken: boolean;
}

/** Turn a compose stack into a DeployNow compose app (nothing is deployed until the person deploys it). */
export function AdoptDialog({ endpointId, stack, onClose }: { endpointId: string; stack: string; onClose: () => void }) {
  const api = useApi();
  const router = useRouter();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [name, setName] = useState(stack);
  const [compose, setCompose] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, pr] = await Promise.all([
        api<Plan>(`/api/endpoints/${endpointId}/stacks/${encodeURIComponent(stack)}/adopt`),
        api<ProjectOption[]>("/api/projects"),
      ]);
      if (p.ok) {
        setPlan(p.data as Plan);
        setCompose((p.data as Plan).yaml);
      } else setError(p.data.error ?? "Could not read the stack");
      if (pr.ok) {
        const list = pr.data as unknown as ProjectOption[];
        setProjects(list);
        setEnvironmentId(list[0]?.environments[0]?.id ?? "");
      }
    })();
  }, [api, endpointId, stack]);

  const submit = async () => {
    setBusy(true);
    setError("");
    const res = await api<{ id: string }>(`/api/endpoints/${endpointId}/stacks/${encodeURIComponent(stack)}/adopt`, {
      body: { environmentId, name, compose: compose === plan?.yaml ? undefined : compose },
    });
    setBusy(false);
    if (!res.ok) return setError(res.data.error ?? "Could not create the app");
    router.push(`/apps/${res.data.id}`);
  };

  const secrets = plan?.env.filter((e) => e.kind === "secret").length ?? 0;

  return (
    <Modal
      icon={FolderInput}
      title={`Manage ${stack} with DeployNow`}
      description="Creates a compose app from this stack. Nothing changes on the server until you deploy the app."
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!plan || !environmentId || plan.taken}>Create app</Button>
        </>
      }
    >
      {!plan ? (
        error ? <ErrorText>{error}</ErrorText> : <div className="space-y-2"><Skeleton className="h-9" /><Skeleton className="h-40" /></div>
      ) : (
        <div className="space-y-4">
          {projects.length === 0 ? (
            <p className="text-sm text-text-muted">Create a project first, then come back to add this stack to it.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project and environment">
                <Select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
                  {projects.flatMap((p) => p.environments.map((env) => (
                    <option key={env.id} value={env.id}>{p.environments.length > 1 ? `${p.name} / ${env.name}` : p.name}</option>
                  )))}
                </Select>
              </Field>
              <Field label="App name" hint={`Docker name: ${plan.slug}`}>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>
          )}
          {plan.taken && <ErrorText>An app named {plan.slug} already exists on this endpoint.</ErrorText>}

          <div className="text-sm text-text-secondary space-y-1.5">
            <p>
              {plan.services.length} service{plan.services.length === 1 ? "" : "s"} ({plan.services.join(", ")}).{" "}
              {plan.env.length
                ? `${plan.env.length} environment variable${plan.env.length === 1 ? "" : "s"} move to the app's settings${secrets ? `, ${secrets} of them stored as secrets` : ""}.`
                : "No environment variables to move."}
            </p>
            {plan.inPlace && <p>The app keeps the compose project name {plan.stack}, so the first deploy recreates these containers in place and keeps the named volumes and their data.</p>}
          </div>

          {plan.warnings.map((w) => (
            <p key={w} className="flex gap-2 text-xs text-warning bg-warning/10 border border-warning/20 rounded-[10px] px-3 py-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {w}
            </p>
          ))}
          {plan.blocker && (
            <p className="flex gap-2 text-xs text-danger bg-danger/10 border border-danger/20 rounded-[10px] px-3 py-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>DeployNow&apos;s compose rules would refuse this file as it is: {plan.blocker} You can edit it below (or paste your original docker-compose.yml) before creating the app.</span>
            </p>
          )}

          <Field label="Compose file" hint="Rebuilt from the running containers. Environment values are not in the file: they are read from the containers and saved with the app.">
            <TextArea value={compose} onChange={(e) => setCompose(e.target.value)} rows={16} className="font-mono text-xs" spellCheck={false} />
          </Field>
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Modal>
  );
}
