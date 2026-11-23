"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { clsx } from "clsx";
import { Bell, Boxes, CheckCircle, AlertCircle, KeyRound, Loader2, RefreshCw, Server, ShieldCheck, Wifi } from "lucide-react";
import { NotificationSettings, VaultSettings } from "@/components/IntegrationSettings";
import { RegistrySettings, SsoSettings } from "@/components/AccessSettings";
import { useToast } from "@/components/feedback";
import { Button, Field, Input, PageHeader, Skeleton, TextArea } from "@/components/ui";

interface SettingsData {
  githubUser: string;
  githubToken: string;
  pollingInterval: number;
  autoUpdateLatest: boolean;
  require2faForAdmins: boolean;
  agentPublicUrl: string;
  agentDefaultUrl?: string;
  alertDiskPercent: number;
  alertMemPercent: number;
  alertCrashRestarts: number;
}

interface HealthMonitorData {
  enabled: boolean;
  prefixes: string;
  logWindow: number;
  cooldown: number;
  logPatterns: string;
}

const SECTIONS = [
  { id: "security", label: "Security and sign-in", icon: ShieldCheck },
  { id: "alerts", label: "Alerts and notifications", icon: Bell },
  { id: "updates", label: "Updates and health", icon: RefreshCw },
  { id: "registries", label: "Registries", icon: Boxes },
  { id: "agents", label: "Agents", icon: Server },
  { id: "vault", label: "Secrets vault", icon: KeyRound },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const cardClass = "bg-bg-card border border-border rounded-xl p-6";

/** Card with a title, a description and its own Save button that lights up once something changed */
function FormCard({
  title,
  description,
  dirty,
  saving,
  onSave,
  children,
}: {
  title: string;
  description?: ReactNode;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className={cardClass}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <h2 className="text-sm font-semibold text-text-primary mb-1">{title}</h2>
      {description && <p className="text-xs text-text-muted mb-4">{description}</p>}
      <div className="space-y-4">{children}</div>
      <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
        {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
        <Button type="submit" loading={saving} disabled={!dirty}>Save</Button>
      </div>
    </form>
  );
}

function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[var(--color-accent)]" />
      <span>
        <span className="block text-sm text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

function SettingsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toast = useToast();
  const sectionParam = search.get("section");
  const section: SectionId = SECTIONS.some((s) => s.id === sectionParam) ? (sectionParam as SectionId) : "security";
  const go = (id: SectionId) => router.replace(`${pathname}?section=${id}`, { scroll: false });

  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [savedSettings, setSavedSettings] = useState<SettingsData | null>(null);
  const [health, setHealth] = useState<HealthMonitorData | null>(null);
  const [savedHealth, setSavedHealth] = useState<HealthMonitorData | null>(null);
  const [saving, setSaving] = useState("");
  const [testingGithub, setTestingGithub] = useState(false);
  const [githubTestResult, setGithubTestResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    Promise.all([fetch("/api/settings").then((r) => r.json()), fetch("/api/health-monitor").then((r) => r.json())]).then(([s, h]) => {
      setSettings(s);
      setSavedSettings(s);
      setHealth(h);
      setSavedHealth(h);
    });
  }, []);

  if (!settings || !health || !savedSettings || !savedHealth) {
    return (
      <div className="max-w-5xl" aria-busy="true">
        <Skeleton className="h-8 w-48 mb-8" />
        <div className="grid lg:grid-cols-[220px_1fr] gap-8">
          <Skeleton className="h-64 hidden lg:block" />
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  }

  const changed = (keys: (keyof SettingsData)[]) => keys.some((k) => settings[k] !== savedSettings[k]);
  const healthChanged = JSON.stringify(health) !== JSON.stringify(savedHealth);
  const set = <K extends keyof SettingsData>(k: K, v: SettingsData[K]) => setSettings({ ...settings, [k]: v });

  async function readError(res: Response) {
    const text = await res.text();
    try {
      return (JSON.parse(text) as { error?: string }).error || `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}: ${text.slice(0, 200)}`;
    }
  }

  async function saveKeys(id: string, keys: (keyof SettingsData)[], label: string) {
    setSaving(id);
    try {
      const body = Object.fromEntries(keys.map((k) => [k, settings![k]]));
      const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) return toast.error(await readError(res));
      setSavedSettings({ ...savedSettings!, ...body });
      toast.success(`${label} saved`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving("");
    }
  }

  async function saveHealth() {
    setSaving("health");
    try {
      const res = await fetch("/api/health-monitor", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(health) });
      if (!res.ok) return toast.error(await readError(res));
      setSavedHealth(health);
      toast.success("Health monitor saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSaving("");
    }
  }

  async function handleTestGithub() {
    setTestingGithub(true);
    setGithubTestResult(null);
    try {
      // Send the credentials straight to the test endpoint: no save needed
      const res = await fetch("/api/github/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUser: settings!.githubUser, githubToken: settings!.githubToken }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.user && !settings!.githubUser) set("githubUser", data.user);
        setGithubTestResult({ success: true, message: data.message });
      } else {
        setGithubTestResult({ success: false, message: data.error });
      }
    } catch (err) {
      setGithubTestResult({ success: false, message: err instanceof Error ? err.message : "Connection failed" });
    } finally {
      setTestingGithub(false);
    }
  }

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="max-w-5xl">
      <PageHeader title="Settings" subtitle="Settings for this DeployNow instance. Each section saves on its own." />

      <div className="grid lg:grid-cols-[220px_1fr] gap-6 lg:gap-8 items-start">
        {/* Section menu: a list on desktop, a scrolling row on phones */}
        <nav aria-label="Settings sections" className="lg:sticky lg:top-8 flex lg:flex-col gap-1 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 pb-1 lg:pb-0">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                onClick={() => go(s.id)}
                aria-current={section === s.id ? "page" : undefined}
                className={clsx(
                  "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-left transition-colors",
                  section === s.id ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary hover:bg-bg-card",
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="space-y-6 min-w-0">
          <h2 className="text-lg font-semibold text-text-primary lg:hidden sr-only">{current.label}</h2>

          {section === "security" && (
            <>
              <FormCard
                title="Two-factor authentication"
                dirty={changed(["require2faForAdmins"])}
                saving={saving === "security"}
                onSave={() => saveKeys("security", ["require2faForAdmins"], "Security")}
              >
                <Checkbox
                  checked={settings.require2faForAdmins}
                  onChange={(v) => set("require2faForAdmins", v)}
                  label="Require two-factor authentication for admins and owners"
                  hint="Admins without 2FA are sent to set it up before they can do anything else. Only an owner can turn this off."
                />
              </FormCard>
              <SsoSettings />
            </>
          )}

          {section === "alerts" && (
            <>
              <FormCard
                title="Alert thresholds"
                description="When to raise an alert. Alerts go to the notification channels below that subscribe to them, when they start and when they clear."
                dirty={changed(["alertDiskPercent", "alertMemPercent", "alertCrashRestarts"])}
                saving={saving === "alerts"}
                onSave={() => saveKeys("alerts", ["alertDiskPercent", "alertMemPercent", "alertCrashRestarts"], "Alert thresholds")}
              >
                <div className="grid sm:grid-cols-3 gap-3">
                  <Field label="Disk full at (%)">
                    <Input type="number" min={1} max={100} value={settings.alertDiskPercent ?? ""} onChange={(e) => set("alertDiskPercent", Number(e.target.value))} />
                  </Field>
                  <Field label="Memory used at (%)">
                    <Input type="number" min={1} max={100} value={settings.alertMemPercent ?? ""} onChange={(e) => set("alertMemPercent", Number(e.target.value))} />
                  </Field>
                  <Field label="Crash loop after" hint="Restarts within 10 minutes">
                    <Input type="number" min={1} value={settings.alertCrashRestarts ?? ""} onChange={(e) => set("alertCrashRestarts", Number(e.target.value))} />
                  </Field>
                </div>
              </FormCard>
              <NotificationSettings />
            </>
          )}

          {section === "updates" && (
            <>
              <FormCard
                title="Image update checks"
                description="DeployNow checks the registries of running containers for newer images. Results show under Image updates."
                dirty={changed(["pollingInterval", "autoUpdateLatest"])}
                saving={saving === "updates"}
                onSave={() => saveKeys("updates", ["pollingInterval", "autoUpdateLatest"], "Update checks")}
              >
                <Field label="Check every (seconds)" hint="Between 30 and 3600">
                  <Input type="number" min={30} max={3600} className="!w-32" value={settings.pollingInterval} onChange={(e) => set("pollingInterval", parseInt(e.target.value) || 60)} />
                </Field>
                <Checkbox
                  checked={settings.autoUpdateLatest}
                  onChange={(v) => set("autoUpdateLatest", v)}
                  label="Update floating tags automatically"
                  hint={
                    <>
                      Pull and recreate containers on tags like <code className="text-accent">latest</code>, <code className="text-accent">main</code> or{" "}
                      <code className="text-accent">dev</code> when a new image appears.
                    </>
                  }
                />
              </FormCard>

              <FormCard
                title="Container health monitor"
                description="Every 5 minutes, scans container logs and restarts any container whose recent logs match one of the patterns."
                dirty={healthChanged}
                saving={saving === "health"}
                onSave={saveHealth}
              >
                <Checkbox checked={health.enabled} onChange={(v) => setHealth({ ...health, enabled: v })} label="Restart containers when a log pattern matches" />
                <Field label="Container name prefixes" hint="One per line. Only containers whose names start with one of these are checked. Leave empty to check all running containers.">
                  <TextArea rows={3} value={health.prefixes} onChange={(e) => setHealth({ ...health, prefixes: e.target.value })} placeholder={"n8n-worker\nglances\nmy-service"} />
                </Field>
                <Field label="Log patterns" hint="One keyword or phrase per line, case-insensitive.">
                  <TextArea rows={4} value={health.logPatterns} onChange={(e) => setHealth({ ...health, logPatterns: e.target.value })} />
                </Field>
                <div className="grid sm:grid-cols-2 gap-4">
                  <Field label="Log window (seconds)" hint="How far back to read logs at each check (60 to 900)">
                    <Input type="number" min={60} max={900} value={health.logWindow} onChange={(e) => setHealth({ ...health, logWindow: parseInt(e.target.value) || 300 })} />
                  </Field>
                  <Field label="Cooldown (minutes)" hint="Minimum time between restarts of one container (1 to 60)">
                    <Input type="number" min={1} max={60} value={health.cooldown} onChange={(e) => setHealth({ ...health, cooldown: parseInt(e.target.value) || 10 })} />
                  </Field>
                </div>
              </FormCard>
            </>
          )}

          {section === "registries" && (
            <>
              <RegistrySettings />
              <FormCard
                title="GitHub Container Registry (instance-wide)"
                description="A GitHub token used to pull and check private ghcr.io images when no other registry login matches."
                dirty={changed(["githubUser", "githubToken"])}
                saving={saving === "github"}
                onSave={() => saveKeys("github", ["githubUser", "githubToken"], "GitHub token")}
              >
                <Field label="GitHub user name">
                  <Input value={settings.githubUser} onChange={(e) => set("githubUser", e.target.value)} placeholder="your-github-username" autoComplete="off" />
                </Field>
                <Field label="Personal access token" hint={<>Needs the <code className="text-accent">read:packages</code> scope.</>}>
                  <Input type="password" value={settings.githubToken} onChange={(e) => set("githubToken", e.target.value)} placeholder="ghp_…" autoComplete="new-password" />
                </Field>
                <div className="flex flex-wrap items-start gap-3">
                  <Button type="button" variant="secondary" onClick={handleTestGithub} loading={testingGithub}>
                    {!testingGithub && <Wifi className="w-4 h-4" />} Test connection
                  </Button>
                  {githubTestResult && (
                    <div className={clsx("flex items-start gap-2 px-3 py-2 rounded-lg text-xs", githubTestResult.success ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
                      {githubTestResult.success ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                      <span>{githubTestResult.message}</span>
                    </div>
                  )}
                </div>
              </FormCard>
            </>
          )}

          {section === "agents" && (
            <FormCard
              title="Agent address"
              description="Agents on remote servers connect out to this address over mutual TLS (port 8444 by default, set with AGENT_PORT). It must reach DeployNow directly, not through a proxy that terminates TLS."
              dirty={changed(["agentPublicUrl"])}
              saving={saving === "agents"}
              onSave={() => saveKeys("agents", ["agentPublicUrl"], "Agent address")}
            >
              <Field label="Address" hint={settings.agentDefaultUrl ? <>Leave empty to use {settings.agentDefaultUrl}</> : undefined}>
                <Input value={settings.agentPublicUrl ?? ""} onChange={(e) => set("agentPublicUrl", e.target.value)} placeholder={settings.agentDefaultUrl || "https://deploynow.example.com:8444"} />
              </Field>
            </FormCard>
          )}

          {section === "vault" && <VaultSettings />}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Loader2 className="w-6 h-6 text-accent animate-spin" />}>
      <SettingsContent />
    </Suspense>
  );
}
