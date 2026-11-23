"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Server, RefreshCw, Cpu, MemoryStick, Boxes } from "lucide-react";
import { useApi } from "@/components/AppShell";
import EndpointForm, { type EndpointView } from "@/components/EndpointForm";
import { Badge, Button, Card, Modal, PageHeader, formatBytes, stateTone, timeAgo } from "@/components/ui";

const TYPE_LABEL = { socket: "Local socket", ssh: "SSH", tls: "TLS API", agent: "Agent" } as const;

export default function EndpointsPage() {
  const api = useApi();
  const [endpoints, setEndpoints] = useState<EndpointView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const res = await api<EndpointView[]>("/api/endpoints");
    if (res.ok) setEndpoints(res.data as unknown as EndpointView[]);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function refreshAll() {
    setRefreshing(true);
    await Promise.all((endpoints ?? []).map((e) => api(`/api/endpoints/${e.id}/refresh`, { method: "POST" })));
    await load();
    setRefreshing(false);
  }

  return (
    <div>
      <PageHeader
        title="Endpoints"
        subtitle="The Docker machines this deployer manages"
        actions={
          <>
            <Button variant="secondary" loading={refreshing} onClick={refreshAll}>
              <RefreshCw className="w-4 h-4" /> Refresh
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus className="w-4 h-4" /> Add endpoint
            </Button>
          </>
        }
      />

      {endpoints === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : endpoints.length === 0 ? (
        <Card className="p-10 text-center">
          <Server className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p className="text-text-primary font-medium">No endpoints yet</p>
          <p className="text-sm text-text-muted mt-1 mb-4">Connect the local Docker socket or a remote machine over SSH.</p>
          <Button onClick={() => setAdding(true)}><Plus className="w-4 h-4" /> Add endpoint</Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {endpoints.map((e) => (
            <Link key={e.id} href={`/endpoints/${e.id}`}>
              <Card className="p-5 hover:border-border-bright transition-colors h-full">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-text-primary truncate">{e.name}</h3>
                    <p className="text-xs text-text-muted truncate mt-0.5">
                      {TYPE_LABEL[e.type]} · {e.type === "socket" ? e.host : `${e.username ? e.username + "@" : ""}${e.host}:${e.port}`}
                    </p>
                  </div>
                  <Badge tone={stateTone(e.status)}>{e.status}</Badge>
                </div>
                {e.status === "online" ? (
                  <div className="flex gap-5 mt-4 text-xs text-text-secondary">
                    <span className="flex items-center gap-1.5"><Boxes className="w-3.5 h-3.5" /> {e.containers} containers</span>
                    <span className="flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5" /> {e.cpus} CPU</span>
                    <span className="flex items-center gap-1.5"><MemoryStick className="w-3.5 h-3.5" /> {formatBytes(e.memoryBytes)}</span>
                  </div>
                ) : (
                  e.lastError && <p className="text-xs text-danger mt-4 line-clamp-2">{e.lastError}</p>
                )}
                <div className="flex items-center justify-between mt-4 text-xs text-text-muted">
                  <span>{e.dockerVersion ? `Docker ${e.dockerVersion}` : ""}</span>
                  <span>seen {timeAgo(e.lastSeenAt)}</span>
                </div>
                {e.labels.length > 0 && (
                  <div className="flex gap-1.5 mt-3 flex-wrap">
                    {e.labels.map((l) => <Badge key={l}>{l}</Badge>)}
                  </div>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}

      {adding && (
        <Modal title="Add endpoint" onClose={() => setAdding(false)} wide>
          <EndpointForm
            api={api}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              load();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
