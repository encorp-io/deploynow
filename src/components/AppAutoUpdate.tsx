"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { clsx } from "clsx";
import { useApi } from "./AppShell";
import { Badge, Button, Card, Checkbox, Field, Input, Select, timeAgo } from "./ui";
import { useToast } from "./feedback";

export interface AutoUpdateValue {
  autoUpdate: boolean;
  autoUpdateEvery: number;
  autoUpdateDays: number[];
  autoUpdateFrom: string;
  autoUpdateTo: string;
  autoUpdateTimezone: string;
  autoUpdateRollback: boolean;
}

interface Run {
  id: string;
  status: string;
  summary: string;
  error: string;
  deploymentId: string;
  createdAt: string;
  finishedAt: string | null;
}

interface Status {
  serverTimezone: string;
  window: string;
  inWindowNow: boolean;
  checkedAt: string | null;
  pending: string;
  error: string;
  runs: Run[];
}

const EVERY: [number, string][] = [
  [1, "Every minute"],
  [5, "Every 5 minutes"],
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Every hour"],
  [360, "Every 6 hours"],
  [1440, "Once a day"],
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Monday first
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const RUN_LABELS: Record<string, [string, "success" | "warning" | "danger" | "accent" | "muted"]> = {
  deploying: ["Deploying", "accent"],
  verifying: ["Checking health", "accent"],
  "rolling-back": ["Rolling back", "warning"],
  success: ["Updated", "success"],
  "rolled-back": ["Rolled back", "warning"],
  "rollback-failed": ["Rollback failed", "danger"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "muted"],
  superseded: ["Replaced", "muted"],
};

function watches(sourceType: string): string {
  switch (sourceType) {
    case "image":
      return "a new digest for the image tag (e.g. a new :latest)";
    case "compose":
      return "new digests for the images in the compose file";
    case "git-dockerfile":
      return "new commits on the branch";
    default:
      return "new commits on the branch and new digests for the compose file's images";
  }
}

/** Auto-update settings, status and history for one app (Settings tab). */
export function AppAutoUpdate({
  app,
  canManage,
  canDeploy,
  onSave,
  busy,
  onDeployment,
}: {
  app: AutoUpdateValue & { id: string; sourceType: string; gitBranch: string; updatePolicy: string; currentDeploymentId: string | null };
  canManage: boolean;
  canDeploy: boolean;
  onSave: (body: Record<string, unknown>, what: string) => Promise<boolean>;
  busy: boolean;
  onDeployment: (id: string) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [v, setV] = useState<AutoUpdateValue>({
    autoUpdate: app.autoUpdate,
    autoUpdateEvery: app.autoUpdateEvery,
    autoUpdateDays: app.autoUpdateDays,
    autoUpdateFrom: app.autoUpdateFrom,
    autoUpdateTo: app.autoUpdateTo,
    autoUpdateTimezone: app.autoUpdateTimezone,
    autoUpdateRollback: app.autoUpdateRollback,
  });
  const [windowOn, setWindowOn] = useState(!!app.autoUpdateFrom || app.autoUpdateDays.length > 0);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    const r = await api<Status>(`/api/apps/${app.id}/auto-update`);
    if (r.ok) setStatus(r.data as unknown as Status);
  }, [api, app.id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const set = <K extends keyof AutoUpdateValue>(k: K, val: AutoUpdateValue[K]) => setV((p) => ({ ...p, [k]: val }));
  const toggleDay = (d: number) => {
    const next = v.autoUpdateDays.includes(d) ? v.autoUpdateDays.filter((x) => x !== d) : [...v.autoUpdateDays, d].sort();
    if (next.length) set("autoUpdateDays", next.length === 7 ? [] : next); // at least one day; all seven = every day
  };

  const save = async () => {
    const body = windowOn ? { ...v } : { ...v, autoUpdateDays: [], autoUpdateFrom: "", autoUpdateTo: "" };
    if (await onSave(body, "Auto-update")) void load();
  };

  const check = async (action: "check" | "retry") => {
    setChecking(true);
    const r = await api<{ state: string; summary: string }>(`/api/apps/${app.id}/auto-update`, { method: "POST", body: { action } });
    setChecking(false);
    if (!r.ok) {
      toast.error(r.data.error ?? "Check failed");
      return;
    }
    const res = r.data as unknown as { state: string; summary: string };
    if (res.state === "queued") toast.success("Update found: deploying it now");
    else if (res.state === "up-to-date") toast.success(res.summary || "Up to date");
    else if (res.state === "error") toast.error(res.summary);
    else toast.success(res.summary);
    void load();
  };

  const saved = app.autoUpdate;
  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2"><RefreshCw className="w-4 h-4" /> Auto-update</h3>
          <p className="text-xs text-text-muted mt-1">
            Checks for {watches(app.sourceType)} and redeploys through the normal pipeline. If the update fails or the app isn&apos;t healthy a minute later, it rolls back to the version that ran before.
            {(app.sourceType === "git-dockerfile" || app.sourceType === "git-compose") && <> Works without a GitHub webhook; with one, pushes deploy right away and this catches anything the webhook missed.</>}
          </p>
        </div>
        {saved && <Badge tone="success">On</Badge>}
      </div>

      <Checkbox
        variant="switch"
        label="Update this app automatically"
        checked={v.autoUpdate}
        onChange={(e) => set("autoUpdate", e.target.checked)}
        disabled={!canManage}
      />

      {v.autoUpdate && (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Check">
              <Select value={String(v.autoUpdateEvery)} onChange={(e) => set("autoUpdateEvery", Number(e.target.value))} disabled={!canManage}>
                {EVERY.map(([n, label]) => <option key={n} value={String(n)}>{label}</option>)}
              </Select>
            </Field>
            <Field label="Time zone" hint={`Empty: the server's (${status?.serverTimezone ?? "UTC"})`}>
              <Input value={v.autoUpdateTimezone} onChange={(e) => set("autoUpdateTimezone", e.target.value)} placeholder={status?.serverTimezone ?? "Europe/Sofia"} disabled={!canManage} />
            </Field>
          </div>

          <Checkbox
            label="Only update in a maintenance window"
            hint="Updates found outside it wait for the next window"
            checked={windowOn}
            onChange={(e) => setWindowOn(e.target.checked)}
            disabled={!canManage}
          />
          {windowOn && (
            <div className="space-y-3 pl-7">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
                {DAY_ORDER.map((d) => {
                  const on = v.autoUpdateDays.length === 0 || v.autoUpdateDays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      disabled={!canManage}
                      onClick={() => (v.autoUpdateDays.length === 0 ? set("autoUpdateDays", DAY_ORDER.filter((x) => x !== d).sort()) : toggleDay(d))}
                      className={clsx("px-2.5 py-1 rounded-md border text-xs", on ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-muted hover:border-border-bright")}
                    >
                      {DAYS[d]}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-3 max-w-sm">
                <Field label="From"><Input type="time" value={v.autoUpdateFrom} onChange={(e) => set("autoUpdateFrom", e.target.value)} disabled={!canManage} /></Field>
                <Field label="To"><Input type="time" value={v.autoUpdateTo} onChange={(e) => set("autoUpdateTo", e.target.value)} disabled={!canManage} /></Field>
              </div>
              <p className="text-xs text-text-muted">Leave the times empty to allow the whole day. A window like 22:00 to 04:00 runs past midnight.</p>
            </div>
          )}

          <Checkbox
            label="Roll back when an update fails or is unhealthy"
            hint="Redeploys the previous deployment, with the same image digests and commit"
            checked={v.autoUpdateRollback}
            onChange={(e) => set("autoUpdateRollback", e.target.checked)}
            disabled={!canManage}
          />
        </div>
      )}

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={save} loading={busy}>Save</Button>
        </div>
      )}

      {saved && status && (
        <div className="border-t border-border pt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-text-secondary">
              {status.checkedAt ? <>Last checked {timeAgo(status.checkedAt)}</> : "Not checked yet"}
              <span className="text-text-muted"> · window: {status.window}{status.inWindowNow ? " (open now)" : ""}</span>
            </p>
            {canDeploy && (
              <div className="flex gap-2">
                {status.pending.includes("Not tried again") && (
                  <Button variant="secondary" onClick={() => check("retry")} loading={checking}><RotateCcw className="w-4 h-4" /> Retry update</Button>
                )}
                <Button variant="secondary" onClick={() => check("check")} loading={checking} disabled={!app.currentDeploymentId}><RefreshCw className="w-4 h-4" /> Check now</Button>
              </div>
            )}
          </div>
          {!app.currentDeploymentId && <p className="text-sm text-text-muted">Deploy the app once; auto-update follows its current deployment.</p>}
          {status.error && <p className="text-sm text-danger">Last check failed: {status.error}</p>}
          {status.pending && <p className="text-sm text-warning">{status.pending}</p>}
          {status.runs.length > 0 && (
            <ul className="space-y-1.5">
              {status.runs.slice(0, 8).map((r) => {
                const [label, tone] = RUN_LABELS[r.status] ?? [r.status, "muted"];
                return (
                  <li key={r.id} className="flex items-start gap-2 text-sm">
                    <Badge tone={tone}>{label}</Badge>
                    <button type="button" className="min-w-0 text-left hover:text-accent" onClick={() => r.deploymentId && onDeployment(r.deploymentId)}>
                      <span className="block truncate text-text-secondary">{r.summary}</span>
                      {r.error && <span className="block text-xs text-danger truncate">{r.error}</span>}
                    </button>
                    <span className="ml-auto text-xs text-text-muted whitespace-nowrap">{timeAgo(r.createdAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
