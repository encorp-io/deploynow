"use client";

import { useState, useEffect } from "react";
import { Save, Loader2, CheckCircle, Wifi, AlertCircle } from "lucide-react";

interface SettingsData {
  portainerUrl: string;
  portainerApiKey: string;
  githubUser: string;
  githubToken: string;
  pollingInterval: number;
  autoUpdateLatest: boolean;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData>({
    portainerUrl: "",
    portainerApiKey: "",
    githubUser: "",
    githubToken: "",
    pollingInterval: 60,
    autoUpdateLatest: true,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testingGithub, setTestingGithub] = useState(false);
  const [githubTestResult, setGithubTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  const [saveError, setSaveError] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError("");

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (!res.ok) {
        const text = await res.text();
        let errMsg: string;
        try {
          const d = JSON.parse(text);
          errMsg = d.error || `HTTP ${res.status}`;
        } catch {
          errMsg = `HTTP ${res.status}: ${text.substring(0, 200)}`;
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

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);

    // Save first so the test uses current values
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });

    try {
      const res = await fetch("/api/portainer/test", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setTestResult({
          success: true,
          message: `Connected! Found ${data.endpoints.length} endpoint(s): ${data.endpoints.map((e: { name: string }) => e.name).join(", ")}`,
        });
      } else {
        setTestResult({ success: false, message: data.error });
      }
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTesting(false);
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
          Configure your Portainer and GitHub connections
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-8">
        {/* Portainer */}
        <section className="bg-bg-card border border-border rounded-xl p-6">
          <h2 className="text-sm font-semibold text-text-primary mb-4">
            Portainer Connection
          </h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                Portainer URL
              </label>
              <input
                type="url"
                value={settings.portainerUrl}
                onChange={(e) =>
                  setSettings({ ...settings, portainerUrl: e.target.value })
                }
                className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                placeholder="https://portainer.example.com"
              />
              <p className="text-xs text-text-muted mt-1">
                The URL of your Portainer CE instance (without /api)
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                API Key
              </label>
              <input
                type="password"
                value={settings.portainerApiKey}
                onChange={(e) =>
                  setSettings({ ...settings, portainerApiKey: e.target.value })
                }
                className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                placeholder="ptr_xxxxxxxxxxxx"
              />
              <p className="text-xs text-text-muted mt-1">
                Generate an API key in Portainer under Settings → API Keys
              </p>
            </div>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing}
              className="flex items-center gap-2 px-4 py-2 bg-bg-secondary border border-border rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all disabled:opacity-50"
            >
              {testing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wifi className="w-4 h-4" />
              )}
              Test Connection
            </button>
            {testResult && (
              <div
                className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                  testResult.success
                    ? "bg-success/10 text-success"
                    : "bg-danger/10 text-danger"
                }`}
              >
                {testResult.success ? (
                  <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                )}
                <span>{testResult.message}</span>
              </div>
            )}
          </div>
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
    </div>
  );
}
