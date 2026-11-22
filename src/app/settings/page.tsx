"use client";

import { NotificationSettings, VaultSettings } from "@/components/IntegrationSettings";
import { useState, useEffect } from "react";
import { Save, Loader2, CheckCircle, Wifi, AlertCircle } from "lucide-react";

interface SettingsData {
  githubUser: string;
  githubToken: string;
  pollingInterval: number;
  autoUpdateLatest: boolean;
  require2faForAdmins: boolean;
  agentPublicUrl: string;
  agentDefaultUrl?: string;
}

interface HealthMonitorData {
  enabled: boolean;
  prefixes: string;
  logWindow: number;
  cooldown: number;
  logPatterns: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData>({
    githubUser: "",
    githubToken: "",
    pollingInterval: 60,
    autoUpdateLatest: false,
    require2faForAdmins: true,
    agentPublicUrl: "",
  });
  const [healthMonitor, setHealthMonitor] = useState<HealthMonitorData>({
    enabled: false,
    prefixes: "",
    logWindow: 300,
    cooldown: 10,
    logPatterns: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testingGithub, setTestingGithub] = useState(false);
  const [githubTestResult, setGithubTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/health-monitor").then((r) => r.json()),
    ]).then(([s, h]) => {
      setSettings(s);
      setHealthMonitor(h);
    }).finally(() => setLoading(false));
  }, []);

  const [saveError, setSaveError] = useState("");

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError("");

    try {
      const [res, healthRes] = await Promise.all([
        fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings),
        }),
        fetch("/api/health-monitor", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(healthMonitor),
        }),
      ]);

      const failed = [res, healthRes].find((r) => !r.ok);
      if (failed) {
        const text = await failed.text();
        let errMsg: string;
        try {
          const d = JSON.parse(text);
          errMsg = d.error || `HTTP ${failed.status}`;
        } catch {
          errMsg = `HTTP ${failed.status}: ${text.substring(0, 200)}`;
        }
        setSaveError(errMsg);
        setSaving(false);
        return;
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving(false);
    }
  }



  async function handleTestGithub() {
    setTestingGithub(true);
    setGithubTestResult(null);

    try {
      // Send credentials directly to the test endpoint — no save needed
      const res = await fetch("/api/github/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubUser: settings.githubUser,
          githubToken: settings.githubToken,
        }),
      });
      const data = await res.json();
      if (data.success) {
        // Auto-fill username if it was detected
        if (data.user && !settings.githubUser) {
          setSettings({ ...settings, githubUser: data.user });
        }
        setGithubTestResult({ success: true, message: data.message });
      } else {
        setGithubTestResult({ success: false, message: data.error });
      }
    } catch (err) {
      setGithubTestResult({
        success: false,
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingGithub(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Settings</h1>
        <p className="text-sm text-text-muted mt-1">
          Registry access, update checks, health monitor and security
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-8">
        {/* Security */}
        <section className="bg-bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-4">Security</h2>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.require2faForAdmins}
              onChange={(e) => setSettings({ ...settings, require2faForAdmins: e.target.checked })}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm text-text-primary">Require two-factor authentication for admins and owners</span>
              <span className="block text-xs text-text-muted mt-0.5">
                Admins without 2FA are sent to set it up before they can do anything else. Only an owner can turn this off.
              </span>
            </span>
          </label>
        </section>

        {/* Agents */}
        <section className="bg-bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-1">Agents</h2>
          <p className="text-xs text-text-muted mb-4">
            Agents on remote servers connect out to this address over mutual TLS (port 8444 by default, set with AGENT_PORT).
            It must reach this DeployNow directly, not through a proxy that terminates TLS.
          </p>
          <label className="block text-xs font-medium text-text-secondary mb-1.5">Agent address</label>
          <input
            value={settings.agentPublicUrl ?? ""}
            onChange={(e) => setSettings({ ...settings, agentPublicUrl: e.target.value })}
            placeholder={settings.agentDefaultUrl || "https://deploynow.example.com:8444"}
            className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
          />
        </section>

        {/* GitHub */}
        <section className="bg-bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-4">
            GitHub Container Registry
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                GitHub Username
              </label>
              <input
                type="text"
                value={settings.githubUser}
                onChange={(e) =>
                  setSettings({ ...settings, githubUser: e.target.value })
                }
                className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                placeholder="your-github-username"
              />
              <p className="text-xs text-text-muted mt-1">
                Your GitHub username — used with the PAT for GHCR authentication
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Personal Access Token (PAT)
              </label>
              <input
                type="password"
                value={settings.githubToken}
                onChange={(e) =>
                  setSettings({ ...settings, githubToken: e.target.value })
                }
                className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                placeholder="ghp_xxxxxxxxxxxx"
              />
              <p className="text-xs text-text-muted mt-1">
                Needs <code className="text-accent">read:packages</code> scope.
                Used to check for new image versions on ghcr.io
              </p>
            </div>
            <button
              type="button"
              onClick={handleTestGithub}
              disabled={testingGithub}
              className="flex items-center gap-2 px-4 py-2 bg-bg-secondary border border-border rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all disabled:opacity-50"
            >
              {testingGithub ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wifi className="w-4 h-4" />
              )}
              Test Connection
            </button>
            {githubTestResult && (
              <div
                className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                  githubTestResult.success
                    ? "bg-success/10 text-success"
                    : "bg-danger/10 text-danger"
                }`}
              >
                {githubTestResult.success ? (
                  <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                )}
                <span>{githubTestResult.message}</span>
              </div>
            )}
          </div>
        </section>

        {/* Polling */}
        <section className="bg-bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-4">
            Auto-Update Behavior
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Polling Interval (seconds)
              </label>
              <input
                type="number"
                min="30"
                max="3600"
                value={settings.pollingInterval}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    pollingInterval: parseInt(e.target.value) || 60,
                  })
                }
                className="w-32 px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
              />
              <p className="text-xs text-text-muted mt-1">
                How often to check registries for new images (30-3600)
              </p>
            </div>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.autoUpdateLatest}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    autoUpdateLatest: e.target.checked,
                  })
                }
                className="w-4 h-4 rounded bg-bg-secondary border-border text-accent focus:ring-accent/30"
              />
              <div>
                <span className="text-sm text-text-primary">
                  Auto-update floating tags
                </span>
                <p className="text-xs text-text-muted">
                  Automatically pull and recreate containers using tags like{" "}
                  <code className="text-accent">latest</code>,{" "}
                  <code className="text-accent">main</code>,{" "}
                  <code className="text-accent">dev</code>
                </p>
              </div>
            </label>
          </div>
        </section>

        {/* Container Health Monitor */}
        <section className="bg-bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-1">
            Container Health Monitor
          </h2>
          <p className="text-xs text-text-muted mb-4">
            Scans container logs every 5 minutes and auto-restarts any container whose logs
            match the configured patterns. Works with any container type.
          </p>
          <div className="space-y-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={healthMonitor.enabled}
                onChange={(e) =>
                  setHealthMonitor({ ...healthMonitor, enabled: e.target.checked })
                }
                className="w-4 h-4 rounded bg-bg-secondary border-border text-accent focus:ring-accent/30"
              />
              <div>
                <span className="text-sm text-text-primary">
                  Enable automatic restart on log pattern match
                </span>
                <p className="text-xs text-text-muted">
                  Runs independently every 5 minutes, separate from the image-update polling
                  interval
                </p>
              </div>
            </label>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Container name prefixes
              </label>
              <textarea
                rows={3}
                value={healthMonitor.prefixes}
                onChange={(e) =>
                  setHealthMonitor({ ...healthMonitor, prefixes: e.target.value })
                }
                className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors resize-none"
                placeholder={"n8n-worker\nglances\nmy-service"}
              />
              <p className="text-xs text-text-muted mt-1">
                One prefix per line. Only containers whose names start with one of these
                prefixes are checked. Leave empty to monitor all running containers.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Log patterns (triggers restart)
              </label>
              <textarea
                rows={4}
                value={healthMonitor.logPatterns}
                onChange={(e) =>
                  setHealthMonitor({ ...healthMonitor, logPatterns: e.target.value })
                }
                className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary font-mono placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors resize-none"
              />
              <p className="text-xs text-text-muted mt-1">
                One keyword or phrase per line (case-insensitive). A container is restarted
                when any pattern appears in its recent logs.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Log window (seconds)
                </label>
                <input
                  type="number"
                  min="60"
                  max="900"
                  value={healthMonitor.logWindow}
                  onChange={(e) =>
                    setHealthMonitor({
                      ...healthMonitor,
                      logWindow: parseInt(e.target.value) || 300,
                    })
                  }
                  className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                />
                <p className="text-xs text-text-muted mt-1">
                  How far back to scan logs each check (60–900)
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Cooldown (minutes)
                </label>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={healthMonitor.cooldown}
                  onChange={(e) =>
                    setHealthMonitor({
                      ...healthMonitor,
                      cooldown: parseInt(e.target.value) || 10,
                    })
                  }
                  className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                />
                <p className="text-xs text-text-muted mt-1">
                  Minimum time between restarts per container (1–60)
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save Settings
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-xs text-success">
              <CheckCircle className="w-3.5 h-3.5" />
              Saved!
            </span>
          )}
          {saveError && (
            <span className="flex items-center gap-1 text-xs text-danger">
              <AlertCircle className="w-3.5 h-3.5" />
              {saveError}
            </span>
          )}
        </div>
      </form>

      <div className="space-y-8 mt-8">
        <VaultSettings />
        <NotificationSettings />
      </div>
    </div>
  );
}
