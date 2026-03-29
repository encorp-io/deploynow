"use client";

import { clsx } from "clsx";
import {
  CheckCircle,
  AlertCircle,
  ArrowUpCircle,
  Loader2,
  XCircle,
  RefreshCw,
  Clock,
  Box,
} from "lucide-react";

interface Service {
  id: string;
  containerId: string;
  containerName: string;
  image: string;
  registry: string;
  tag: string;
  isFloatingTag: boolean;
  status: string;
  updateAvailable: boolean;
  arch: string;
  currentDigest: string;
  remoteDigest: string;
  lastChecked: string | null;
  lastUpdated: string | null;
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; icon: typeof CheckCircle; label: string }> = {
    running: { color: "text-success", icon: CheckCircle, label: "Running" },
    stopped: { color: "text-text-muted", icon: XCircle, label: "Stopped" },
    updating: { color: "text-accent", icon: Loader2, label: "Updating" },
    error: { color: "text-danger", icon: AlertCircle, label: "Error" },
    unknown: { color: "text-text-muted", icon: AlertCircle, label: "Unknown" },
  };

  const c = config[status] || config.unknown;
  const Icon = c.icon;

  return (
    <div className={clsx("flex items-center gap-1.5 text-xs font-medium", c.color)}>
      <Icon className={clsx("w-3.5 h-3.5", status === "updating" && "animate-spin")} />
      {c.label}
    </div>
  );
}

function timeAgo(date: string | null): string {
  if (!date) return "Never";
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function ServiceCard({
  service,
  onUpdate,
  updating,
}: {
  service: Service;
  onUpdate: (id: string) => void;
  updating: boolean;
}) {
  const glowClass = service.updateAvailable
    ? service.isFloatingTag
      ? "glow-blue"
      : "glow-orange"
    : service.status === "running"
      ? ""
      : service.status === "error"
        ? "glow-red"
        : "";

  return (
    <div
      className={clsx(
        "bg-bg-card border border-border rounded-xl p-5 hover:border-border-bright transition-all duration-300",
        glowClass
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-bg-secondary flex items-center justify-center flex-shrink-0">
            <Box className="w-5 h-5 text-text-secondary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text-primary truncate">
              {service.containerName}
            </h3>
            <p className="text-xs text-text-muted truncate mt-0.5">
              {service.image}
            </p>
          </div>
        </div>
        <StatusBadge status={service.status} />
      </div>

      {/* Tag & Registry */}
      <div className="flex items-center gap-2 mb-4">
        <span
          className={clsx(
            "px-2 py-0.5 rounded text-xs font-mono",
            service.isFloatingTag
              ? "bg-accent/15 text-accent"
              : "bg-bg-secondary text-text-secondary"
          )}
        >
          {service.tag}
        </span>
        <span className="px-2 py-0.5 rounded text-xs bg-bg-secondary text-text-muted">
          {service.registry}
        </span>
        <span className="px-2 py-0.5 rounded text-xs bg-bg-secondary text-text-muted font-mono">
          {service.arch}
        </span>
        {service.isFloatingTag && (
          <span className="px-2 py-0.5 rounded text-xs bg-success/15 text-success">
            auto-update
          </span>
        )}
      </div>

      {/* Digest info */}
      {service.currentDigest && (
        <div className="text-xs text-text-muted mb-4 font-mono bg-bg-secondary rounded-lg px-3 py-2">
          <div className="flex justify-between">
            <span>Current</span>
            <span>{service.currentDigest.slice(0, 20)}...</span>
          </div>
          {service.remoteDigest && service.remoteDigest !== service.currentDigest && (
            <div className="flex justify-between mt-1 text-warning">
              <span>Remote</span>
              <span>{service.remoteDigest.slice(0, 20)}...</span>
            </div>
          )}
        </div>
      )}

      {/* Update available banner */}
      {service.updateAvailable && (
        <div
          className={clsx(
            "rounded-lg px-3 py-2.5 mb-4 flex items-center justify-between",
            service.isFloatingTag
              ? "bg-accent/10 border border-accent/20"
              : "bg-warning/10 border border-warning/20"
          )}
        >
          <div className="flex items-center gap-2">
            <ArrowUpCircle
              className={clsx(
                "w-4 h-4 pulse-dot",
                service.isFloatingTag ? "text-accent" : "text-warning"
              )}
            />
            <span
              className={clsx(
                "text-xs font-medium",
                service.isFloatingTag ? "text-accent" : "text-warning"
              )}
            >
              New version available
            </span>
          </div>
          <button
            onClick={() => onUpdate(service.id)}
            disabled={updating}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-50",
              service.isFloatingTag
                ? "bg-accent/20 text-accent hover:bg-accent/30"
                : "bg-warning/20 text-warning hover:bg-warning/30"
            )}
          >
            {updating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Update
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          Checked {timeAgo(service.lastChecked)}
        </div>
        {service.lastUpdated && (
          <span>Updated {timeAgo(service.lastUpdated)}</span>
        )}
      </div>
    </div>
  );
}
