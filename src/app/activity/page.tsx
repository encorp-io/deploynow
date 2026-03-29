"use client";

import { useState, useEffect, useCallback } from "react";
import { clsx } from "clsx";
import {
  Search,
  Filter,
  ArrowUpDown,
  CheckCircle,
  AlertCircle,
  ArrowUpCircle,
  AlertTriangle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  History,
  X,
} from "lucide-react";

interface LogEntry {
  id: string;
  serviceId: string | null;
  action: string;
  message: string;
  details: string;
  createdAt: string;
}

interface ActivityResponse {
  logs: LogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  actionTypes: string[];
}

const ACTION_LABELS: Record<string, { label: string; icon: typeof CheckCircle; color: string; bg: string }> = {
  check:            { label: "Check",     icon: Search,         color: "text-text-muted",  bg: "bg-bg-secondary" },
  update:           { label: "Updated",   icon: CheckCircle,    color: "text-success",     bg: "bg-success/10" },
  update_available: { label: "Available", icon: ArrowUpCircle,  color: "text-warning",     bg: "bg-warning/10" },
  error:            { label: "Error",     icon: AlertCircle,    color: "text-danger",      bg: "bg-danger/10" },
  manual_update:    { label: "Manual",    icon: AlertTriangle,  color: "text-accent",      bg: "bg-accent/10" },
};

function formatDateTime(date: string): string {
  const d = new Date(date);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  }) + " " + d.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function ActivityPage() {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [page, setPage] = useState(1);
  const limit = 30;

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, actionFilter, sortOrder]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sort: sortOrder,
      });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (actionFilter) params.set("action", actionFilter);

      const res = await fetch(`/api/activity?${params}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch activity:", err);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, actionFilter, sortOrder]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Activity Log</h1>
        <p className="text-sm text-text-muted mt-1">
          History of all update checks, deployments, and errors
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-6">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-9 py-2.5 bg-bg-card border border-border rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
            placeholder="Search activity..."
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Action filter */}
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" />
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="appearance-none pl-10 pr-8 py-2.5 bg-bg-card border border-border rounded-xl text-sm text-text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors cursor-pointer"
          >
            <option value="">All types</option>
            {(data?.actionTypes || []).map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]?.label || a}
              </option>
            ))}
          </select>
        </div>

        {/* Sort toggle */}
        <button
          onClick={() => setSortOrder(sortOrder === "desc" ? "asc" : "desc")}
          className="flex items-center gap-2 px-4 py-2.5 bg-bg-card border border-border rounded-xl text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all"
        >
          <ArrowUpDown className="w-4 h-4" />
          {sortOrder === "desc" ? "Newest first" : "Oldest first"}
        </button>

        {/* Total count */}
        {data && (
          <span className="text-xs text-text-muted ml-auto">
            {data.total} event{data.total !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Activity list */}
      {loading && !data ? (
        <div className="flex items-center justify-center h-[40vh]">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
        </div>
      ) : data && data.logs.length > 0 ? (
        <div className="bg-bg-card border border-border rounded-2xl overflow-hidden">
          {data.logs.map((log, i) => {
            const config = ACTION_LABELS[log.action] || ACTION_LABELS.check;
            const Icon = config.icon;

            return (
              <div
                key={log.id}
                className={clsx(
                  "flex items-start gap-4 px-5 py-4 hover:bg-bg-card-hover transition-colors",
                  i > 0 && "border-t border-border"
                )}
              >
                {/* Icon */}
                <div
                  className={clsx(
                    "w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5",
                    config.bg
                  )}
                >
                  <Icon className={clsx("w-4 h-4", config.color)} />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span
                      className={clsx(
                        "px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider",
                        config.bg,
                        config.color
                      )}
                    >
                      {config.label}
                    </span>
                    <span className="text-xs text-text-muted" title={formatDateTime(log.createdAt)}>
                      {timeAgo(log.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm text-text-primary">{log.message}</p>
                  {log.details && (
                    <p className="text-xs text-text-muted mt-1 font-mono">
                      {log.details}
                    </p>
                  )}
                </div>

                {/* Timestamp */}
                <span className="text-xs text-text-muted flex-shrink-0 hidden sm:block">
                  {formatDateTime(log.createdAt)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-bg-card border border-border rounded-2xl p-12 text-center">
          <History className="w-12 h-12 text-text-muted mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-text-primary mb-2">
            {debouncedSearch || actionFilter ? "No matching events" : "No activity yet"}
          </h3>
          <p className="text-sm text-text-muted">
            {debouncedSearch || actionFilter
              ? "Try adjusting your search or filters."
              : "Activity will appear here when update checks and deployments run."}
          </p>
        </div>
      )}

      {/* Pagination */}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between mt-6">
          <p className="text-xs text-text-muted">
            Showing {(page - 1) * limit + 1}–{Math.min(page * limit, data.total)} of{" "}
            {data.total}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
              className="flex items-center gap-1 px-3 py-2 bg-bg-card border border-border rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Previous
            </button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(data.totalPages, 7) }, (_, i) => {
                let p: number;
                if (data.totalPages <= 7) {
                  p = i + 1;
                } else if (page <= 4) {
                  p = i + 1;
                } else if (page >= data.totalPages - 3) {
                  p = data.totalPages - 6 + i;
                } else {
                  p = page - 3 + i;
                }
                return (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={clsx(
                      "w-8 h-8 rounded-lg text-xs font-medium transition-all",
                      p === page
                        ? "bg-accent text-white"
                        : "text-text-secondary hover:text-text-primary hover:bg-bg-card"
                    )}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => setPage(page + 1)}
              disabled={page >= data.totalPages}
              className="flex items-center gap-1 px-3 py-2 bg-bg-card border border-border rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
