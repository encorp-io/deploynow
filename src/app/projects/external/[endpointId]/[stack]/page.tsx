"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { FileText, FolderInput, Play, RotateCw, Square, SquareTerminal, Trash2 } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, IconButton, PageHeader, PageSkeleton, TableWrap, stateTone, timeAgo } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";
import { AdoptDialog, STANDALONE, type ExternalContainer } from "@/components/External";

interface StackView {
  endpoint: { id: string; name: string };
  name: string;
  standalone: boolean;
  workingDir: string | null;
  configFiles: string | null;
  appId: string | null;
  containers: ExternalContainer[];
  allowed: { logs: boolean; console: boolean; control: boolean; remove: boolean; adopt: boolean };
}

const th = "text-left text-xs font-medium text-text-muted px-4 py-2.5";
const td = "px-4 py-2.5 text-sm text-text-primary";

export default function ExternalStackPage({ params }: { params: Promise<{ endpointId: string; stack: string }> }) {
  const { endpointId, stack: raw } = use(params);
  const stack = decodeURIComponent(raw);
  const api = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const [view, setView] = useState<StackView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [adopting, setAdopting] = useState(false);
  const base = `/api/endpoints/${endpointId}/stacks/${encodeURIComponent(stack)}`;

  const load = useCallback(async () => {
    const res = await api<StackView>(base);
    if (res.ok) {
      setView(res.data as StackView);
      setError("");
    } else setError(res.data.error ?? "Stack not found");
  }, [api, base]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function run(key: string, fn: () => Promise<{ ok: boolean; data: { error?: string } }>, done?: string) {
    setBusy(key);
    const res = await fn();
    setBusy("");
    if (!res.ok) toast.error(res.data.error ?? "Action failed");
    else if (done) toast.success(done);
    load();
  }

  const stackAction = async (action: "start" | "stop" | "restart") => {
    if (action !== "start" && !(await confirm({ title: `${action === "stop" ? "Stop" : "Restart"} every container of ${stack}?`, confirmLabel: action === "stop" ? "Stop all" : "Restart all" }))) return;
    run(`stack:${action}`, () => api(base, { body: { action } }), `${action === "start" ? "Started" : action === "stop" ? "Stopped" : "Restarted"} ${stack}`);
  };
  const containerAction = (c: ExternalContainer, action: string) => run(`${c.id}:${action}`, () => api(`/api/endpoints/${endpointId}/containers/${c.id}`, { body: { action } }));
  const remove = async (c: ExternalContainer) => {
    if (!(await confirm({ title: `Remove container ${c.name}?`, message: "This can't be undone. Named volumes are kept.", confirmLabel: "Remove" }))) return;
    run(`${c.id}:remove`, () => api(`/api/endpoints/${endpointId}/containers/${c.id}`, { method: "DELETE" }));
  };

  if (!view) return error ? <ErrorText>{error}</ErrorText> : <PageSkeleton />;
  const a = view.allowed;
  const title = view.standalone ? "Standalone containers" : stack;
  const running = view.containers.filter((c) => c.state === "running").length;
  const leftover = view.containers.some((c) => c.leftover);
  const href = (c: ExternalContainer, tab?: string) => `/endpoints/${endpointId}/containers/${c.id}${tab ? `?tab=${tab}` : ""}`;

  return (
    <div className="max-w-6xl">
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: "Not managed by DeployNow", href: "/projects" }, { label: title }]}
        title={title}
        subtitle={
          <span className="flex items-center flex-wrap gap-x-2 gap-y-1">
            <Badge>{view.standalone ? "docker run" : "compose"}</Badge>
            <span>{running} of {view.containers.length} running on <Link href={`/endpoints/${endpointId}`} className="text-accent hover:underline">{view.endpoint.name}</Link></span>
            {view.workingDir && <span className="font-mono text-xs">{view.workingDir}</span>}
          </span>
        }
        actions={
          <>
            {!view.standalone && a.control && (
              <>
                <Button variant="secondary" loading={busy === "stack:start"} onClick={() => stackAction("start")}><Play className="w-4 h-4" /> Start</Button>
                <Button variant="secondary" loading={busy === "stack:restart"} onClick={() => stackAction("restart")}><RotateCw className="w-4 h-4" /> Restart</Button>
                <Button variant="secondary" loading={busy === "stack:stop"} onClick={() => stackAction("stop")}><Square className="w-4 h-4" /> Stop</Button>
              </>
            )}
            {!view.standalone && a.adopt && <Button onClick={() => setAdopting(true)}><FolderInput className="w-4 h-4" /> Manage with DeployNow</Button>}
          </>
        }
      />
      <ErrorText>{error}</ErrorText>
      {leftover && (
        <p className="text-xs text-warning bg-warning/10 border border-warning/20 rounded-[10px] px-3 py-2 mb-3">
          Some of these containers belonged to a DeployNow app that was deleted. Remove them, or deploy the app again.
        </p>
      )}
      {view.appId && (
        <p className="text-sm text-text-secondary bg-accent/10 border border-accent/20 rounded-[10px] px-3 py-2 mb-3">
          This stack is now a DeployNow app. <Link href={`/apps/${view.appId}`} className="text-accent hover:underline font-medium">Deploy it</Link> to take over these containers; they then move into its project.
        </p>
      )}
      {!view.standalone && view.configFiles && (
        <p className="text-xs text-text-muted mb-3">Started with <span className="font-mono">docker compose</span> from <span className="font-mono break-all">{view.configFiles}</span>.</p>
      )}

      <Card className="overflow-hidden">
        <TableWrap><table className="w-full min-w-[720px]">
          <thead className="border-b border-border"><tr>
            <th className={th}>{view.standalone ? "Name" : "Service"}</th><th className={th}>State</th><th className={th}>Image</th><th className={th}>Ports</th><th className={th}>Created</th><th className={th}></th>
          </tr></thead>
          <tbody className="divide-y divide-border">
            {view.containers.map((c) => (
              <tr key={c.id} className="hover:bg-bg-card-hover">
                <td className={clsx(td, "whitespace-nowrap")}>
                  <Link href={href(c)} className="text-accent hover:underline font-medium">{view.standalone ? c.name : c.service ?? c.name}</Link>
                  {!view.standalone && <span className="block text-xs text-text-muted">{c.name}</span>}
                  {c.leftover && <span className="block mt-0.5"><Badge tone="warning">left over</Badge></span>}
                </td>
                <td className={td}><Badge tone={stateTone(c.state)}>{c.state}</Badge><span className="block text-xs text-text-muted mt-0.5">{c.status}</span></td>
                <td className={clsx(td, "font-mono text-xs max-w-xs truncate")}>{c.image}</td>
                <td className={clsx(td, "text-xs")}>{c.ports.join(", ")}</td>
                <td className={clsx(td, "text-xs text-text-muted")}>{timeAgo(c.created)}</td>
                <td className={clsx(td, "text-right whitespace-nowrap")}>
                  {a.logs && <Link href={href(c, "logs")} aria-label={`Logs of ${c.name}`} title="Logs" className="inline-flex p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary"><FileText className="w-4 h-4" /></Link>}
                  {a.console && c.state === "running" && <Link href={href(c, "console")} aria-label={`Console of ${c.name}`} title="Console" className="inline-flex p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-secondary"><SquareTerminal className="w-4 h-4" /></Link>}
                  {a.control && (c.state === "running" ? (
                    <>
                      <IconButton label="Restart" loading={busy === `${c.id}:restart`} onClick={() => containerAction(c, "restart")}><RotateCw className="w-4 h-4" /></IconButton>
                      <IconButton label="Stop" loading={busy === `${c.id}:stop`} onClick={() => containerAction(c, "stop")}><Square className="w-4 h-4" /></IconButton>
                    </>
                  ) : (
                    <IconButton label="Start" loading={busy === `${c.id}:start`} onClick={() => containerAction(c, c.state === "paused" ? "unpause" : "start")}><Play className="w-4 h-4" /></IconButton>
                  ))}
                  {a.remove && <IconButton label="Remove" loading={busy === `${c.id}:remove`} onClick={() => remove(c)}><Trash2 className="w-4 h-4" /></IconButton>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></TableWrap>
      </Card>

      {!view.standalone && !a.adopt && !leftover && (
        <p className="text-xs text-text-muted mt-3">An admin on {view.endpoint.name} can turn this stack into a DeployNow app.</p>
      )}
      {adopting && stack !== STANDALONE && <AdoptDialog endpointId={endpointId} stack={stack} onClose={() => setAdopting(false)} />}
    </div>
  );
}
