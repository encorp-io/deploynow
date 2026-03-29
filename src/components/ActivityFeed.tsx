"use client";

import { clsx } from "clsx";
import {
  CheckCircle,
  AlertCircle,
  ArrowUpCircle,
  Search,
  AlertTriangle,
} from "lucide-react";

interface LogEntry {
  id: string;
  serviceId: string | null;
  action: string;
  message: string;
  details: string;
  createdAt: string;
}

const actionConfig: Record<string, { icon: typeof CheckCircle; color: string }> = {
  check: { icon: Search, color: "text-text-muted" },
  update: { icon: CheckCircle, color: "text-success" },
  update_available: { icon: ArrowUpCircle, color: "text-warning" },
  error: { icon: AlertCircle, color: "text-danger" },
  manual_update: { icon: AlertTriangle, color: "text-accent" },
};

function formatTime(date: string): string {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function ActivityFeed({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) {
    return (
      <div className="text-center py-8 text-text-muted text-sm">
        No activity yet. Sync your services to get started.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {logs.map((log) => {
        const config = actionConfig[log.action] || actionConfig.check;
        const Icon = config.icon;

        return (
          <div
            key={log.id}
            className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-bg-card transition-colors"
          >
            <Icon className={clsx("w-4 h-4 mt-0.5 flex-shrink-0", config.color)} />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-text-primary truncate">{log.message}</p>
              {log.details && (
                <p className="text-xs text-text-muted truncate mt-0.5">
                  {log.details}
                </p>
              )}
            </div>
            <span className="text-xs text-text-muted flex-shrink-0">
              {formatTime(log.createdAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
