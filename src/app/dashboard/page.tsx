"use client";

import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Activity,
  Box,
  ArrowUpCircle,
  CheckCircle,
  Loader2,
  AlertCircle,
} from "lucide-react";
import ServiceCard from "@/components/ServiceCard";
import ActivityFeed from "@/components/ActivityFeed";

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
  currentDigest: string;
  remoteDigest: string;
  lastChecked: string | null;
  lastUpdated: string | null;
}

interface LogEntry {
  id: string;
  serviceId: string | null;
  action: string;
  message: string;
  details: string;
  createdAt: string;
}

export default function DashboardPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updatingService, setUpdatingService] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [servicesRes, logsRes] = await Promise.all([
        fetch("/api/services"),
        fetch("/api/polling"),
      ]);
      if (servicesRes.ok) setServices(await servicesRes.json());
      if (logsRes.ok) setLogs(await logsRes.json());
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000); // refresh UI every 10s
    return () => clearInterval(interval);
  }, [fetchData]);

  async function handleSync() {
    setSyncing(true);
    try {
      await fetch("/api/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      });
      await fetchData();
    } finally {
      setSyncing(false);
    }
  }

  async function handleCheck() {
    setChecking(true);
    try {
      await fetch("/api/polling", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      await fetchData();
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate(serviceId: string) {
    setUpdatingService(serviceId);
    try {
      await fetch("/api/services/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId }),
      });
      await fetchData();
    } finally {
      setUpdatingService(null);
    }
  }

  const totalServices = services.length;
  const runningServices = services.filter((s) => s.status === "running").length;
  const updatesAvailable = services.filter((s) => s.updateAvailable).length;
  const errorServices = services.filter((s) => s.status === "error").length;

  const stats = [
    {
      label: "Total Services",
      value: totalServices,
      icon: Box,
      color: "text-accent",
    },
    {
      label: "Running",
      value: runningServices,
      icon: CheckCircle,
      color: "text-success",
    },
    {
      label: "Updates Available",
      value: updatesAvailable,
      icon: ArrowUpCircle,
      color: "text-warning",
    },
    {
      label: "Errors",
      value: errorServices,
      icon: AlertCircle,
      color: "text-danger",
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>
          <p className="text-sm text-text-muted mt-1">
            Monitor and manage your Docker deployments
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCheck}
            disabled={checking}
            className="flex items-center gap-2 px-4 py-2 bg-bg-card border border-border rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all disabled:opacity-50"
          >
            {checking ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Activity className="w-4 h-4" />
            )}
            Check Updates
          </button>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Sync Portainer
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              className="bg-bg-card border border-border rounded-xl p-4"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">{stat.label}</span>
                <Icon className={`w-4 h-4 ${stat.color}`} />
              </div>
              <p className="text-2xl font-bold text-text-primary mt-2">
                {stat.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Main content */}
      <div className="grid grid-cols-3 gap-8">
        {/* Services grid */}
        <div className="col-span-2">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4">
            Services
          </h2>
          {services.length === 0 ? (
            <div className="bg-bg-card border border-border rounded-xl p-12 text-center">
              <Box className="w-12 h-12 text-text-muted mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-text-primary mb-2">
                No services found
              </h3>
              <p className="text-sm text-text-muted mb-6">
                Configure your Portainer connection in Settings, then click
                &ldquo;Sync Portainer&rdquo; to discover your services.
              </p>
              <button
                onClick={handleSync}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors"
              >
                Sync Now
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {services.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  onUpdate={handleUpdate}
                  updating={updatingService === service.id}
                />
              ))}
            </div>
          )}
        </div>

        {/* Activity feed */}
        <div>
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wider mb-4">
            Recent Activity
          </h2>
          <div className="bg-bg-card border border-border rounded-xl p-3 max-h-[600px] overflow-y-auto">
            <ActivityFeed logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}
