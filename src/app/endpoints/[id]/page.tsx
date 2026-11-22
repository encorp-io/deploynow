"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ArrowLeft, Play, Square, RotateCw, Trash2, Pencil, RefreshCw, Eraser } from "lucide-react";
import { useApi } from "@/components/AppShell";
import EndpointForm, { type EndpointView } from "@/components/EndpointForm";
import { Badge, Button, Card, ErrorText, Modal, PageHeader, formatBytes, stateTone, timeAgo } from "@/components/ui";

type Tab = "containers" | "images" | "volumes" | "networks";

interface ContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  ports: { ip?: string; private: number; public?: number; type: string }[];
  composeProject: string | null;
}
interface ImageRow { id: string; tags: string[]; size: number; created: number; inUse: boolean }
interface VolumeRow { id: string; name: string; driver: string; created: string | null; usedBy: string[] }
interface NetworkRow { id: string; name: string; driver: string; scope: string; subnet: string | null; builtin: boolean; usedBy: string[] }

const th = "text-left text-xs font-medium text-text-muted px-4 py-2.5";
const td = "px-4 py-2.5 text-sm text-text-primary";

export default function EndpointPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const api = useApi();
  const router = useRouter();
  const [endpoint, setEndpoint] = useState<EndpointView | null>(null);
  const [tab, setTab] = useState<Tab>("containers");
  const [rows, setRows] = useState<unknown[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState("");

  const loadEndpoint = useCallback(async () => {
    const res = await api<EndpointView>(`/api/endpoints/${id}`);
    if (res.ok) setEndpoint(res.data as EndpointView);
    else setError(res.data.error ?? "Endpoint not found");
  }, [api, id]);

  const loadTab = useCallback(async () => {
    setRows(null);
    const res = await api<unknown[]>(`/api/endpoints/${id}/${tab}`);
    if (res.ok) {
      setRows(res.data as unknown as unknown[]);
      setError("");
    } else {
      setRows([]);
      setError(res.data.error ?? "Could not load");
    }
  }, [api, id, tab]);

  useEffect(() => {
    loadEndpoint();
  }, [loadEndpoint]);
  useEffect(() => {
    loadTab();
  }, [loadTab]);

  async function act(key: string, fn: () => Promise<{ ok: boolean; data: { error?: string } }>) {
    setBusy(key);
    const res = await fn();
    setBusy("");
    if (!res.ok) setError(res.data.error ?? "Action failed");
    else loadTab();
  }

  const containerAction = (c: ContainerRow, action: string) =>
    act(`${c.id}:${action}`, () => api(`/api/endpoints/${id}/containers/${c.id}`, { body: { action } }));

  const removeContainer = (c: ContainerRow) => {
    if (!confirm(`Remove container ${c.name}? This can't be undone.`)) return;
    act(`${c.id}:remove`, () => api(`/api/endpoints/${id}/containers/${c.id}`, { method: "DELETE" }));
  };

  const removeResource = (kind: Tab, ref: string, label: string) => {
    if (!confirm(`Remove ${kind.slice(0, -1)} ${label}?${kind === "volumes" ? " Its data will be deleted." : ""}`)) return;
    act(`${ref}:remove`, () => api(`/api/endpoints/${id}/${kind}?ref=${encodeURIComponent(ref)}`, { method: "DELETE" }));
  };

  const prune = async (kind: Tab) => {
    const what = { containers: "stopped containers", images: "dangling images", volumes: "unused volumes (their data is deleted)", networks: "unused networks" }[kind];
    if (!confirm(`Remove all ${what} on ${endpoint?.name}?`)) return;
    setBusy("prune");
    const res = await api<{ removed: number; reclaimed: number }>(`/api/endpoints/${id}/prune`, { body: { kind } });
    setBusy("");
    if (res.ok) {
      alert(`Removed ${res.data.removed}, reclaimed ${formatBytes(res.data.reclaimed)}`);
      loadTab();
    } else setError(res.data.error ?? "Prune failed");
  };

  async function deleteEndpoint() {
    if (!confirm(`Remove endpoint ${endpoint?.name}? Its containers keep running; the deployer just stops managing them.`)) return;
    const res = await api(`/api/endpoints/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/endpoints");
    else setError(res.data.error ?? "Could not remove");
  }

  async function refresh() {
    setBusy("refresh");
    const res = await api<EndpointView>(`/api/endpoints/${id}/refresh`, { method: "POST" });
    if (res.ok) setEndpoint(res.data as EndpointView);
    setBusy("");
    loadTab();
  }

  if (!endpoint) {
    return error ? <ErrorText>{error}</ErrorText> : <p className="text-sm text-text-muted">Loading…</p>;
  }

  const q = filter.toLowerCase();
  const match = (...vals: (string | undefined | null)[]) => !q || vals.some((v) => v?.toLowerCase().includes(q));

  return (
    <div>
      <Link href="/endpoints" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary mb-3">
        <ArrowLeft className="w-3.5 h-3.5" /> Endpoints
      </Link>
      <PageHeader
        title={endpoint.name}
        subtitle={
          <span className="flex items-center gap-2">
            <Badge tone={stateTone(endpoint.status)}>{endpoint.status}</Badge>
            {endpoint.dockerVersion && <>Docker {endpoint.dockerVersion} · {endpoint.os} · {endpoint.cpus} CPU · {formatBytes(endpoint.memoryBytes)}</>}
            {endpoint.status !== "online" && endpoint.lastError && <span className="text-danger">{endpoint.lastError}</span>}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" loading={busy === "refresh"} onClick={refresh}><RefreshCw className="w-4 h-4" /></Button>
            <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="w-4 h-4" /> Edit</Button>
            <Button variant="danger" onClick={deleteEndpoint}><Trash2 className="w-4 h-4" /></Button>
          </>
        }
      />

      <div className="flex items-center justify-between mb-4 gap-4">
        <div className="flex gap-1 bg-bg-secondary border border-border rounded-lg p-1">
          {(["containers", "images", "volumes", "networks"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx("px-3 py-1.5 rounded-md text-sm capitalize", tab === t ? "bg-bg-card text-text-primary" : "text-text-muted hover:text-text-secondary")}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="px-3 py-1.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent w-56"
          />
          <Button variant="secondary" loading={busy === "prune"} onClick={() => prune(tab)}><Eraser className="w-4 h-4" /> Prune</Button>
        </div>
      </div>

      <ErrorText>{error}</ErrorText>

      <Card className="overflow-hidden mt-2">
        {rows === null ? (
          <p className="text-sm text-text-muted p-4">Loading…</p>
        ) : tab === "containers" ? (
          <table className="w-full">
            <thead className="border-b border-border"><tr><th className={th}>Name</th><th className={th}>State</th><th className={th}>Image</th><th className={th}>Ports</th><th className={th}>Created</th><th className={th}></th></tr></thead>
            <tbody className="divide-y divide-border">
              {(rows as ContainerRow[]).filter((c) => match(c.name, c.image, c.composeProject)).map((c) => (
                <tr key={c.id} className="hover:bg-bg-card-hover">
                  <td className={td}>
                    <Link href={`/endpoints/${id}/containers/${c.id}`} className="text-accent hover:underline font-medium">{c.name}</Link>
                    {c.composeProject && <span className="block text-xs text-text-muted">stack {c.composeProject}</span>}
                  </td>
                  <td className={td}><Badge tone={stateTone(c.state)}>{c.state}</Badge><span className="block text-xs text-text-muted mt-0.5">{c.status}</span></td>
                  <td className={clsx(td, "font-mono text-xs max-w-xs truncate")}>{c.image}</td>
                  <td className={clsx(td, "text-xs")}>{c.ports.filter((p) => p.public).map((p) => `${p.public}→${p.private}`).filter((v, i, a) => a.indexOf(v) === i).join(", ")}</td>
                  <td className={clsx(td, "text-xs text-text-muted")}>{timeAgo(c.created)}</td>
                  <td className={clsx(td, "text-right whitespace-nowrap")}>
                    {c.state === "running" ? (
                      <>
                        <Button variant="ghost" title="Restart" loading={busy === `${c.id}:restart`} onClick={() => containerAction(c, "restart")}><RotateCw className="w-4 h-4" /></Button>
                        <Button variant="ghost" title="Stop" loading={busy === `${c.id}:stop`} onClick={() => containerAction(c, "stop")}><Square className="w-4 h-4" /></Button>
                      </>
                    ) : (
                      <Button variant="ghost" title="Start" loading={busy === `${c.id}:start`} onClick={() => containerAction(c, "start")}><Play className="w-4 h-4" /></Button>
                    )}
                    <Button variant="ghost" title="Remove" loading={busy === `${c.id}:remove`} onClick={() => removeContainer(c)}><Trash2 className="w-4 h-4" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "images" ? (
          <table className="w-full">
            <thead className="border-b border-border"><tr><th className={th}>Tags</th><th className={th}>Id</th><th className={th}>Size</th><th className={th}>Created</th><th className={th}></th></tr></thead>
            <tbody className="divide-y divide-border">
              {(rows as ImageRow[]).filter((i) => match(i.id, ...i.tags)).map((i) => (
                <tr key={i.id}>
                  <td className={clsx(td, "font-mono text-xs")}>{i.tags.length ? i.tags.join(", ") : <span className="text-text-muted">untagged</span>} {i.inUse && <Badge tone="accent">in use</Badge>}</td>
                  <td className={clsx(td, "font-mono text-xs text-text-muted")}>{i.id.replace("sha256:", "").slice(0, 12)}</td>
                  <td className={clsx(td, "text-xs")}>{formatBytes(i.size)}</td>
                  <td className={clsx(td, "text-xs text-text-muted")}>{timeAgo(i.created)}</td>
                  <td className={clsx(td, "text-right")}>{!i.inUse && <Button variant="ghost" loading={busy === `${i.id}:remove`} onClick={() => removeResource("images", i.id, i.tags[0] ?? i.id.slice(7, 19))}><Trash2 className="w-4 h-4" /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "volumes" ? (
          <table className="w-full">
            <thead className="border-b border-border"><tr><th className={th}>Name</th><th className={th}>Driver</th><th className={th}>Used by</th><th className={th}>Created</th><th className={th}></th></tr></thead>
            <tbody className="divide-y divide-border">
              {(rows as VolumeRow[]).filter((v) => match(v.name, ...v.usedBy)).map((v) => (
                <tr key={v.id}>
                  <td className={clsx(td, "font-mono text-xs max-w-sm truncate")}>{v.name}</td>
                  <td className={clsx(td, "text-xs")}>{v.driver}</td>
                  <td className={clsx(td, "text-xs")}>{v.usedBy.join(", ") || <span className="text-text-muted">unused</span>}</td>
                  <td className={clsx(td, "text-xs text-text-muted")}>{v.created ? timeAgo(v.created) : ""}</td>
                  <td className={clsx(td, "text-right")}>{v.usedBy.length === 0 && <Button variant="ghost" loading={busy === `${v.id}:remove`} onClick={() => removeResource("volumes", v.name, v.name)}><Trash2 className="w-4 h-4" /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full">
            <thead className="border-b border-border"><tr><th className={th}>Name</th><th className={th}>Driver</th><th className={th}>Subnet</th><th className={th}>Containers</th><th className={th}></th></tr></thead>
            <tbody className="divide-y divide-border">
              {(rows as NetworkRow[]).filter((n) => match(n.name, ...n.usedBy)).map((n) => (
                <tr key={n.id}>
                  <td className={clsx(td, "font-mono text-xs")}>{n.name} {n.builtin && <Badge>built-in</Badge>}</td>
                  <td className={clsx(td, "text-xs")}>{n.driver}</td>
                  <td className={clsx(td, "text-xs font-mono")}>{n.subnet ?? ""}</td>
                  <td className={clsx(td, "text-xs")}>{n.usedBy.join(", ")}</td>
                  <td className={clsx(td, "text-right")}>{!n.builtin && n.usedBy.length === 0 && <Button variant="ghost" loading={busy === `${n.id}:remove`} onClick={() => removeResource("networks", n.id, n.name)}><Trash2 className="w-4 h-4" /></Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows !== null && rows.length === 0 && !error && <p className="text-sm text-text-muted p-4">Nothing here.</p>}
      </Card>

      {editing && (
        <Modal title={`Edit ${endpoint.name}`} onClose={() => setEditing(false)} wide>
          <EndpointForm
            api={api}
            existing={endpoint}
            onCancel={() => setEditing(false)}
            onSaved={(e) => {
              setEndpoint(e);
              setEditing(false);
              loadTab();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
