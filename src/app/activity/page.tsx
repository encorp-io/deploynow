"use client";

import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import { Search, ArrowUpDown, ChevronLeft, ChevronRight, History, X, CheckCircle, AlertCircle } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, PageHeader, timeAgo, Skeleton } from "@/components/ui";

interface AuditRow {
  id: string;
  actorType: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  endpointId: string | null;
  ip: string | null;
  outcome: string;
  message: string;
  details: string | null;
  createdAt: string;
}

interface AuditResponse {
  logs: AuditRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  actionTypes: string[];
  endpoints: { id: string; name: string }[];
}

const select = "px-3 py-2 bg-bg-card border border-border rounded-lg text-sm text-text-primary";

function formatDateTime(date: string) {
  return new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function AuditPage() {
  const api = useApi();
  const [data, setData] = useState<AuditResponse | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [sort, setSort] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const limit = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [debounced, action, outcome, endpointId, sort]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit), sort });
    if (debounced) params.set("search", debounced);
    if (action) params.set("action", action);
    if (outcome) params.set("outcome", outcome);
    if (endpointId) params.set("endpointId", endpointId);
    const res = await api<AuditResponse>(`/api/activity?${params}`);
    if (res.ok) setData(res.data as AuditResponse);
  }, [api, page, sort, debounced, action, outcome, endpointId]);

  useEffect(() => {
    load();
  }, [load]);

  const endpointName = (id: string | null) => (id ? data?.endpoints.find((e) => e.id === id)?.name ?? null : null);
  const filtered = Boolean(debounced || action || outcome || endpointId);

  return (
    <div className="max-w-6xl">
      <PageHeader title="Audit log" subtitle="Sign-ins, console sessions, container actions, updates and settings changes" />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search message, details or person"
            className="w-full pl-9 pr-8 py-2 bg-bg-card border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"><X className="w-4 h-4" /></button>
          )}
        </div>
        <select value={action} onChange={(e) => setAction(e.target.value)} className={select}>
          <option value="">All actions</option>
          {(data?.actionTypes ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={select}>
          <option value="">Any outcome</option>
          <option value="success">Succeeded</option>
          <option value="failure">Failed</option>
        </select>
        {(data?.endpoints.length ?? 0) > 0 && (
          <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className={select}>
            <option value="">All endpoints</option>
            {data!.endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        )}
        <Button variant="secondary" onClick={() => setSort(sort === "desc" ? "asc" : "desc")}>
          <ArrowUpDown className="w-4 h-4" /> {sort === "desc" ? "Newest first" : "Oldest first"}
        </Button>
        {data && <span className="text-xs text-text-muted ml-auto">{data.total} event{data.total === 1 ? "" : "s"}</span>}
      </div>

      {!data ? (
        <div className="space-y-2" aria-busy="true"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
      ) : data.logs.length === 0 ? (
        <Card className="p-12 text-center">
          <History className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p className="text-text-primary font-medium">{filtered ? "No matching events" : "Nothing recorded yet"}</p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {data.logs.map((log, i) => {
            const failed = log.outcome === "failure";
            const ep = endpointName(log.endpointId);
            return (
              <div key={log.id} className={clsx("flex items-start gap-3 px-4 py-3", i > 0 && "border-t border-border")}>
                {failed ? <AlertCircle className="w-4 h-4 text-danger mt-0.5 shrink-0" /> : <CheckCircle className="w-4 h-4 text-success mt-0.5 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <Badge tone={failed ? "danger" : "muted"}>{log.action}</Badge>
                    <span className="text-xs text-text-secondary">{log.actorEmail ?? log.actorType}</span>
                    {ep && <Badge tone="accent">{ep}</Badge>}
                    {log.ip && <span className="text-xs text-text-muted font-mono">{log.ip}</span>}
                  </div>
                  <p className="text-sm text-text-primary break-words">{log.message}</p>
                  {log.details && <p className="text-xs text-text-muted mt-1 font-mono break-all">{log.details}</p>}
                </div>
                <span className="text-xs text-text-muted shrink-0 text-right" title={formatDateTime(log.createdAt)}>
                  {timeAgo(log.createdAt)}
                  <span className="hidden sm:block">{formatDateTime(log.createdAt)}</span>
                </span>
              </div>
            );
          })}
        </Card>
      )}

      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 mt-4">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="w-4 h-4" /> Previous</Button>
          <span className="text-xs text-text-muted">Page {page} of {data.totalPages}</span>
          <Button variant="secondary" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>Next <ChevronRight className="w-4 h-4" /></Button>
        </div>
      )}
    </div>
  );
}
