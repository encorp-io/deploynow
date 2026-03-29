"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Container,
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  Loader2,
  Wifi,
  AlertCircle,
  GitBranch,
  Server,
  Rocket,
} from "lucide-react";

const STEPS = [
  { id: "portainer", label: "Portainer", icon: Server },
  { id: "github", label: "GitHub", icon: GitBranch },
  { id: "complete", label: "Complete", icon: Rocket },
];

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  // Portainer fields
  const [portainerUrl, setPortainerUrl] = useState("");
  const [portainerApiKey, setPortainerApiKey] = useState("");
  const [portainerTestResult, setPortainerTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testingPortainer, setTestingPortainer] = useState(false);

  // GitHub fields
  const [githubUser, setGithubUser] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubTestResult, setGithubTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testingGithub, setTestingGithub] = useState(false);

  // Submission
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function saveSettings() {
    const res = await fetch("/api/onboarding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ portainerUrl, portainerApiKey, githubUser, githubToken }),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || "Failed to save");
    }
  }

  async function handleTestPortainer() {
    setTestingPortainer(true);
    setPortainerTestResult(null);

    try {
      await saveSettings();
      const res = await fetch("/api/portainer/test", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setPortainerTestResult({
          success: true,
          message: `Connected! Found ${data.endpoints.length} endpoint(s): ${data.endpoints.map((e: { name: string }) => e.name).join(", ")}`,
        });
      } else {
        setPortainerTestResult({ success: false, message: data.error });
      }
    } catch (err) {
      setPortainerTestResult({
        success: false,
        message: err instanceof Error ? err.message : "Connection failed",
      });
    } finally {
      setTestingPortainer(false);
    }
  }

  async function handleTestGithub() {
    setTestingGithub(true);
    setGithubTestResult(null);

    try {
      // Send credentials directly — no save needed for testing
      const res = await fetch("/api/github/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUser, githubToken }),
      });
      const data = await res.json();
      if (data.success) {
        // Auto-fill username if detected
        if (data.user && !githubUser) {
          setGithubUser(data.user);
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

  async function handleFinish() {
    setSaving(true);
    setError("");

    try {
      await saveSettings();
      setStep(2); // go to complete step
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  function goToDashboard() {
    router.push("/dashboard");
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/20 mb-5">
            <Container className="w-8 h-8 text-accent" />
          </div>
          <h1 className="text-3xl font-bold text-text-primary">
            Welcome to Deployer
          </h1>
          <p className="text-sm text-text-muted mt-2">
            Let&apos;s connect your Portainer instance and get you set up
          </p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            const isActive = i === step;
            const isDone = i < step;
            return (
              <div key={s.id} className="flex items-center gap-2">
                {i > 0 && (
                  <div
                    className={`w-10 h-px ${isDone ? "bg-accent" : "bg-border"}`}
                  />
                )}
                <div
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                    isActive
                      ? "bg-accent/20 text-accent"
                      : isDone
                      ? "bg-success/20 text-success"
                      : "bg-bg-card text-text-muted"
                  }`}
                >
                  {isDone ? (
                    <CheckCircle className="w-3.5 h-3.5" />
                  ) : (
                    <Icon className="w-3.5 h-3.5" />
                  )}
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* ───── Step 0: Portainer ────────────────────────────────────────────── */}
        {step === 0 && (
          <div className="bg-bg-card border border-border rounded-2xl p-8 space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                Connect Portainer
              </h2>
              <p className="text-sm text-text-muted mt-1">
                Deployer needs access to your Portainer CE instance to manage
                containers.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Portainer URL
                </label>
                <input
                  type="url"
                  value={portainerUrl}
                  onChange={(e) => setPortainerUrl(e.target.value)}
                  className="w-full px-4 py-3 bg-bg-secondary border border-border rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                  placeholder="https://portainer.example.com:9443"
                />
                <p className="text-xs text-text-muted mt-1.5">
                  Full URL including port — do not include <code className="text-accent">/api</code>
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  API Key
                </label>
                <input
                  type="password"
                  value={portainerApiKey}
                  onChange={(e) => setPortainerApiKey(e.target.value)}
                  className="w-full px-4 py-3 bg-bg-secondary border border-border rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                  placeholder="ptr_xxxxxxxxxxxx"
                />
                <p className="text-xs text-text-muted mt-1.5">
                  Generate one in Portainer → Settings → Access control → API keys
                </p>
              </div>

              {/* Test connection */}
              <button
                type="button"
                onClick={handleTestPortainer}
                disabled={testingPortainer || !portainerUrl || !portainerApiKey}
                className="flex items-center gap-2 px-4 py-2.5 bg-bg-secondary border border-border rounded-xl text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {testingPortainer ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Wifi className="w-4 h-4" />
                )}
                Test Connection
              </button>

              {portainerTestResult && (
                <div
                  className={`flex items-start gap-2 px-4 py-3 rounded-xl text-xs ${
                    portainerTestResult.success
                      ? "bg-success/10 text-success border border-success/20"
                      : "bg-danger/10 text-danger border border-danger/20"
                  }`}
                >
                  {portainerTestResult.success ? (
                    <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  )}
                  <span>{portainerTestResult.message}</span>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setStep(1)}
                disabled={!portainerUrl || !portainerApiKey}
                className="flex items-center gap-2 px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ───── Step 1: GitHub ───────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="bg-bg-card border border-border rounded-2xl p-8 space-y-6">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">
                GitHub Container Registry
              </h2>
              <p className="text-sm text-text-muted mt-1">
                A Personal Access Token lets Deployer check for new image
                versions on ghcr.io. You can skip this and add it later.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  GitHub Username
                </label>
                <input
                  type="text"
                  value={githubUser}
                  onChange={(e) => setGithubUser(e.target.value)}
                  className="w-full px-4 py-3 bg-bg-secondary border border-border rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                  placeholder="your-github-username"
                />
                <p className="text-xs text-text-muted mt-1.5">
                  Your GitHub username — used together with the PAT for GHCR
                  authentication
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">
                  Personal Access Token (PAT)
                </label>
                <input
                  type="password"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  className="w-full px-4 py-3 bg-bg-secondary border border-border rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
                  placeholder="ghp_xxxxxxxxxxxx"
                />
                <p className="text-xs text-text-muted mt-1.5">
                  Needs <code className="text-accent">read:packages</code> scope.
                  Create one at{" "}
                  <a
                    href="https://github.com/settings/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    github.com/settings/tokens
                  </a>
                </p>
              </div>

              {/* Test GitHub connection */}
              <button
                type="button"
                onClick={handleTestGithub}
                disabled={testingGithub || !githubUser || !githubToken}
                className="flex items-center gap-2 px-4 py-2.5 bg-bg-secondary border border-border rounded-xl text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all disabled:opacity-40 disabled:cursor-not-allowed"
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
                  className={`flex items-start gap-2 px-4 py-3 rounded-xl text-xs ${
                    githubTestResult.success
                      ? "bg-success/10 text-success border border-success/20"
                      : "bg-danger/10 text-danger border border-danger/20"
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

            {error && (
              <div className="flex items-start gap-2 px-4 py-3 rounded-xl text-xs bg-danger/10 text-danger border border-danger/20">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex justify-between pt-2">
              <button
                onClick={() => setStep(0)}
                className="flex items-center gap-2 px-5 py-2.5 bg-bg-secondary border border-border rounded-xl text-sm font-medium text-text-secondary hover:text-text-primary hover:border-border-bright transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
              <div className="flex gap-3">
                <button
                  onClick={handleFinish}
                  disabled={saving}
                  className="flex items-center gap-2 px-6 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      {githubToken ? "Finish Setup" : "Skip & Finish"}
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ───── Step 2: Complete ─────────────────────────────────────────────── */}
        {step === 2 && (
          <div className="bg-bg-card border border-border rounded-2xl p-8 text-center space-y-6">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success/20">
              <CheckCircle className="w-8 h-8 text-success" />
            </div>

            <div>
              <h2 className="text-xl font-semibold text-text-primary">
                You&apos;re all set!
              </h2>
              <p className="text-sm text-text-muted mt-2">
                Deployer is connected to your Portainer instance. Head to the
                dashboard to sync your containers and start monitoring.
              </p>
            </div>

            <div className="space-y-2 text-left bg-bg-secondary rounded-xl p-4">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle className="w-4 h-4 text-success" />
                <span className="text-text-primary">Portainer connected</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                {githubToken ? (
                  <CheckCircle className="w-4 h-4 text-success" />
                ) : (
                  <div className="w-4 h-4 rounded-full border border-text-muted" />
                )}
                <span className={githubToken ? "text-text-primary" : "text-text-muted"}>
                  GitHub {githubToken ? `configured (${githubUser})` : "skipped — add later in Settings"}
                </span>
              </div>
            </div>

            <button
              onClick={goToDashboard}
              className="flex items-center gap-2 px-8 py-3 bg-accent hover:bg-accent-hover text-white rounded-xl text-sm font-semibold transition-colors mx-auto"
            >
              <Rocket className="w-4 h-4" />
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
