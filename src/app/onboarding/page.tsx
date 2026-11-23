"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Container, GitBranch, Server, Rocket, CheckCircle, HardDrive } from "lucide-react";
import { clsx } from "clsx";
import EndpointForm from "@/components/EndpointForm";
import { Button, Card, ErrorText, Field, Input } from "@/components/ui";

const STEPS = [
  { id: "endpoint", label: "First machine", icon: Server },
  { id: "github", label: "GitHub", icon: GitBranch },
  { id: "done", label: "Done", icon: Rocket },
];

async function api<T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) {
  const res = await fetch(url, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

interface Status {
  needsOnboarding: boolean;
  localSocketAvailable: boolean;
  hadPortainer: boolean;
  hasGithubToken: boolean;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState({ user: "", token: "" });
  const [ghResult, setGhResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    api<Status>("/api/onboarding").then((r) => {
      if (r.status === 403 && (r.data as { mfaSetupRequired?: boolean }).mfaSetupRequired) return router.push("/account?setup=2fa");
      if (r.ok) {
        setStatus(r.data);
        if (!r.data.needsOnboarding) setStep(1);
      }
    });
  }, [router]);

  async function useLocalSocket() {
    setBusy(true);
    setError("");
    const res = await api("/api/endpoints", { body: { name: "local", type: "socket", host: "/var/run/docker.sock", labels: "local" } });
    setBusy(false);
    if (res.ok) setStep(1);
    else setError(res.data.error ?? "Could not connect to the local socket");
  }

  async function testGithub() {
    setBusy(true);
    const res = await api<{ success?: boolean; error?: string; user?: string }>("/api/github/test", { body: { githubUser: github.user, githubToken: github.token } });
    setBusy(false);
    setGhResult(res.data.success ? { ok: true, message: `Token works${res.data.user ? ` for ${res.data.user}` : ""}` } : { ok: false, message: res.data.error ?? "Token check failed" });
  }

  async function saveGithub() {
    setBusy(true);
    setError("");
    const res = await api("/api/settings", { method: "PUT", body: { githubUser: github.user, githubToken: github.token } });
    setBusy(false);
    if (res.ok) setStep(2);
    else setError(res.data.error ?? "Could not save");
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-accent/20 flex items-center justify-center mx-auto mb-3">
            <Container className="w-7 h-7 text-accent" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Set up DeployNow</h1>
          <p className="text-sm text-text-muted mt-1">Connect a Docker machine and, optionally, GitHub Container Registry.</p>
        </div>

        <div className="flex justify-center gap-6 mb-6">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <div key={s.id} className={clsx("flex items-center gap-2 text-sm", i === step ? "text-accent" : i < step ? "text-success" : "text-text-muted")}>
                {i < step ? <CheckCircle className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                {s.label}
              </div>
            );
          })}
        </div>

        <Card className="p-6">
          {step === 0 && (
            <div className="space-y-4">
              {status?.hadPortainer && (
                <p className="text-xs text-text-secondary bg-accent/10 rounded-lg p-3">
                  v2 talks to Docker directly and no longer needs Portainer. Your update settings and history were kept.
                </p>
              )}
              {status?.localSocketAvailable && !manual ? (
                <>
                  <div className="flex items-start gap-3">
                    <HardDrive className="w-5 h-5 text-accent mt-0.5" />
                    <div>
                      <p className="text-sm text-text-primary font-medium">The Docker socket is mounted</p>
                      <p className="text-xs text-text-muted">Manage the machine this deployer runs on. You can add remote machines afterwards.</p>
                    </div>
                  </div>
                  <ErrorText>{error}</ErrorText>
                  <div className="flex justify-between">
                    <Button variant="ghost" onClick={() => setManual(true)}>Connect a different machine</Button>
                    <Button loading={busy} onClick={useLocalSocket}>Use this machine</Button>
                  </div>
                </>
              ) : (
                <>
                  {!status?.localSocketAvailable && (
                    <p className="text-xs text-text-muted">
                      To manage this machine, mount <span className="font-mono">/var/run/docker.sock</span> into the deployer container and reload. Or connect a remote machine:
                    </p>
                  )}
                  <EndpointForm api={api} onSaved={() => setStep(1)} onCancel={() => setManual(false)} />
                </>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-text-secondary">
                Add a GitHub token with <span className="font-mono">read:packages</span> to pull and check private GHCR images. You can skip this for public images.
              </p>
              <Field label="GitHub username"><Input value={github.user} onChange={(e) => setGithub({ ...github, user: e.target.value })} placeholder="your-github-username" /></Field>
              <Field label="Personal access token"><Input type="password" value={github.token} onChange={(e) => setGithub({ ...github, token: e.target.value })} placeholder="ghp_…" /></Field>
              {ghResult && <p className={clsx("text-xs rounded-lg px-3 py-2", ghResult.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>{ghResult.message}</p>}
              <ErrorText>{error}</ErrorText>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => setStep(2)}>Skip</Button>
                <div className="flex gap-2">
                  <Button variant="secondary" loading={busy} disabled={!github.token} onClick={testGithub}>Test</Button>
                  <Button loading={busy} disabled={!github.token} onClick={saveGithub}>Save</Button>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="text-center space-y-4 py-4">
              <Rocket className="w-10 h-10 text-accent mx-auto" />
              <p className="text-text-primary font-medium">You&apos;re set up</p>
              <p className="text-sm text-text-muted">Containers are picked up within a minute. Turn on 2FA under Account if you haven&apos;t yet.</p>
              <Button onClick={() => router.push("/projects")}>Go to your projects</Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
