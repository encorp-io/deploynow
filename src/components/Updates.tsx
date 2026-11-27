"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, RotateCcw, X } from "lucide-react";
import { useApi } from "./AppShell";
import { Button, Checkbox, ErrorText, Select } from "./ui";
import { useConfirm } from "./feedback";

export interface UpdateInfo {
  current: string;
  latest?: string;
  url?: string;
  notes?: string;
  available?: boolean;
  enabled?: boolean;
  envDisabled?: boolean;
  checkedAt?: string | null;
  selfUpdate?: SelfUpdateInfo;
}

export interface SelfUpdateRun {
  id: string;
  state: "starting" | "replacing" | "checking" | "succeeded" | "rolled_back" | "failed";
  fromVersion: string;
  targetRef: string;
  targetVersion: string;
  startedAt: string;
  finishedAt?: string;
  message?: string;
  logs?: string;
  actor?: string;
  envFile?: string;
}

export interface SelfUpdateInfo {
  supported: boolean;
  reason: string;
  image: string;
  pinned: boolean;
  auto: boolean;
  hour: number;
  envDisabled: boolean;
  status: SelfUpdateRun | null;
}

const RUNNING = ["starting", "replacing", "checking"];
const STEP: Record<string, string> = {
  starting: "Starting the updater…",
  replacing: "Replacing the DeployNow container…",
  checking: "Waiting for the new version's health check…",
};

const DISMISS_KEY = "deploynow.update.dismissed";

/** A thin bar at the top of every page for admins when a newer release is out. */
export function UpdateBanner({ role }: { role?: string }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (role !== "admin" && role !== "owner") return;
    fetch("/api/updates")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: UpdateInfo | null) => {
        if (!d?.available || !d.latest) return;
        setInfo(d);
        let dismissed = "";
        try {
          dismissed = localStorage.getItem(DISMISS_KEY) ?? "";
        } catch {
          /* storage blocked */
        }
        setHidden(dismissed === d.latest);
      })
      .catch(() => {});
  }, [role]);

  if (!info || hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, info.latest ?? "");
    } catch {
      /* storage blocked */
    }
    setHidden(true);
  };

  return (
    <div role="status" className="mb-6 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm">
      <ArrowUpCircle className="w-4 h-4 text-accent flex-shrink-0" />
      <span className="text-text-primary">
        DeployNow <strong>{info.latest}</strong> is available. You run {info.current}.
      </span>
      <Link href="/settings?section=updates" className="text-accent hover:underline whitespace-nowrap">
        What&apos;s new
      </Link>
      <button onClick={dismiss} aria-label="Hide until the next release" className="ml-auto p-1 rounded text-text-muted hover:text-text-primary">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/** Settings → Updates and health: the running version, the newest release, and updating DeployNow itself. */
export function DeployNowUpdates() {
  const api = useApi();
  const confirm = useConfirm();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [step, setStep] = useState("");
  const wentDown = useRef(false);

  const load = useCallback(async () => {
    const r = await api<UpdateInfo>("/api/updates");
    if (r.ok) {
      const d = r.data as UpdateInfo;
      setInfo(d);
      if (d.selfUpdate?.status && RUNNING.includes(d.selfUpdate.status.state)) setWaiting(true);
    }
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  // While an update runs: follow the status until DeployNow goes away, then wait for it to answer again
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const res = await fetch("/api/updates", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as UpdateInfo;
          const st = d.selfUpdate?.status;
          if (st && RUNNING.includes(st.state)) {
            setStep(STEP[st.state] ?? "");
          } else {
            setInfo(d);
            setWaiting(false);
            wentDown.current = false;
            return;
          }
        } else if (res.status >= 500) {
          wentDown.current = true;
          setStep("DeployNow is restarting…");
        }
      } catch {
        wentDown.current = true;
        setStep("DeployNow is restarting…");
      }
      if (!stop) setTimeout(tick, 3000);
    };
    const t = setTimeout(tick, 2000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [waiting]);

  if (!info) return null;
  const post = async (body: Record<string, unknown>, what: string) => {
    setBusy(what);
    setError("");
    const r = await api<UpdateInfo>("/api/updates", { method: "POST", body });
    setBusy("");
    if (!r.ok) {
      setError(r.data.error ?? "That didn't work");
      return false;
    }
    setInfo(r.data as UpdateInfo);
    return true;
  };
  const tag = info.latest ?? "";
  const su = info.selfUpdate;
  const last = su?.status && !RUNNING.includes(su.status.state) ? su.status : null;
  // A moving tag (latest, edge) can always be pulled again; a pinned one only moves to a newer release
  const canInstall = !!su?.supported && !su.envDisabled && (su.pinned ? !!info.available : true);
  const install = async () => {
    const what = su?.pinned || info.available ? `DeployNow ${tag}` : `the newest ${su?.image.split(":").pop() ?? ""} image`;
    const ok = await confirm({
      title: `Update to ${what}?`,
      message:
        "DeployNow pulls the image, then a helper container replaces DeployNow and waits for its health check. The UI is away for about a minute. If the new version doesn't come up healthy, the previous one starts again with the database as it was.",
      confirmLabel: "Update now",
      danger: false,
    });
    if (!ok) return;
    if (await post({ install: true }, "install")) {
      setStep(STEP.starting);
      setWaiting(true);
    }
  };

  return (
    <section className="dn-surface border border-border rounded-2xl p-6">
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><ArrowUpCircle className="w-4 h-4" /> DeployNow version</h2>
      <p className="text-xs text-text-muted mb-4">
        Twice a day DeployNow reads the releases on GitHub and tells admins, and the notification channels that subscribe to &quot;New DeployNow version&quot;, when a newer one is out.
        Nothing about this instance is sent.
      </p>
      <div className="text-sm space-y-1">
        <p className="text-text-secondary">
          Running <strong className="text-text-primary">{info.current}</strong>
          {su?.image && <span className="ml-2 text-xs text-text-muted font-mono">{su.image}</span>}
        </p>
        {tag ? (
          <p className="text-text-secondary">
            Newest release <strong className="text-text-primary">{tag}</strong>
            {info.available ? <span className="ml-2 text-accent">update available</span> : <span className="ml-2 text-success">up to date</span>}
          </p>
        ) : (
          <p className="text-text-muted">No release seen yet.</p>
        )}
        {info.checkedAt && <p className="text-xs text-text-muted">Checked {new Date(info.checkedAt).toLocaleString()}</p>}
      </div>

      {waiting && (
        <div role="status" className="mt-4 flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-text-primary">
          <Loader2 className="w-4 h-4 animate-spin text-accent flex-shrink-0" />
          <span>{step || STEP.starting} This page reconnects on its own.</span>
        </div>
      )}

      {!waiting && last && <LastRun run={last} />}

      {info.available && info.notes && (
        <pre className="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-secondary p-3 text-xs text-text-secondary font-sans">{info.notes}</pre>
      )}
      {info.available && info.url && (
        <a href={info.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">
          Release on GitHub <ExternalLink className="w-3 h-3" />
        </a>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {su?.supported && !su.envDisabled && (
          <Button type="button" onClick={install} loading={busy === "install"} disabled={!canInstall || waiting}>
            {busy !== "install" && <ArrowUpCircle className="w-4 h-4" />} {su.pinned || info.available ? "Update now" : "Pull and update"}
          </Button>
        )}
        <Button type="button" variant="secondary" onClick={() => post({ check: true }, "check")} loading={busy === "check"} disabled={info.envDisabled || !info.enabled || waiting}>
          {busy !== "check" && <RefreshCw className="w-4 h-4" />} Check now
        </Button>
        {info.envDisabled ? (
          <span className="text-xs text-text-muted">Turned off with DEPLOYNOW_UPDATE_CHECK=off.</span>
        ) : (
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" role="switch" checked={!!info.enabled} onChange={(e) => post({ enabled: e.target.checked }, "toggle")} disabled={busy === "toggle"} />
            Check for new releases
          </label>
        )}
      </div>

      {su && su.supported && !su.envDisabled && (
        <div className="mt-5 border-t border-border pt-4 space-y-3">
          <Checkbox
            variant="switch"
            checked={su.auto}
            disabled={busy === "auto"}
            onChange={(e) => post({ auto: e.target.checked }, "auto")}
            label="Install updates automatically"
            hint={
              su.pinned
                ? "When a newer release is out, DeployNow updates itself and moves DEPLOYNOW_TAG in your compose .env along. A version that fails its health check is rolled back and not tried again."
                : `When a new ${su.image.split(":").pop()} image is published, DeployNow pulls it and updates itself. A version that fails its health check is rolled back and not tried again.`
            }
          />
          {su.auto && (
            <div className="flex flex-wrap items-center gap-3 pl-7 text-xs text-text-secondary">
              <span>Only during</span>
              <Select size="sm" value={String(su.hour)} onChange={(e) => post({ hour: Number(e.target.value) }, "hour")} disabled={busy === "hour"} aria-label="Hour for auto-update">
                <option value="-1">any time</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={String(h)}>{`${String(h).padStart(2, "0")}:00–${String(h).padStart(2, "0")}:59`}</option>
                ))}
              </Select>
              <span className="text-text-muted">server time</span>
            </div>
          )}
        </div>
      )}

      {su && (!su.supported || su.envDisabled) && (
        <div className="mt-4 text-xs text-text-secondary">
          <p className="mb-1">{su.envDisabled ? "Updating from the UI is turned off with DEPLOYNOW_SELF_UPDATE=off." : su.reason} To upgrade by hand, next to your <code>docker-compose.yml</code>:</p>
          <pre className="rounded-lg bg-bg-secondary p-3 font-mono overflow-x-auto">{`${tag ? `sed -i 's/^DEPLOYNOW_TAG=.*/DEPLOYNOW_TAG=${tag}/' .env\n` : ""}docker compose pull && docker compose up -d`}</pre>
          <p className="mt-1">The database is backed up before it migrates.</p>
        </div>
      )}
      <div className="mt-2"><ErrorText>{error}</ErrorText></div>
    </section>
  );
}

function LastRun({ run }: { run: SelfUpdateRun }) {
  const ok = run.state === "succeeded";
  const when = run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "";
  return (
    <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${ok ? "border-success/30 bg-success/10" : "border-danger/30 bg-danger/10"}`}>
      <p className="flex items-center gap-2 text-text-primary">
        {ok ? <CheckCircle2 className="w-4 h-4 text-success" /> : <RotateCcw className="w-4 h-4 text-danger" />}
        {ok
          ? `Updated from ${run.fromVersion} to ${run.targetVersion || run.targetRef}`
          : `The update to ${run.targetVersion || run.targetRef} didn't go through`}
        {when && <span className="text-xs text-text-muted">{when}{run.actor === "auto" ? " · automatic" : ""}</span>}
      </p>
      {!ok && run.message && <p className="mt-1 text-xs text-text-secondary">{run.message}</p>}
      {ok && run.envFile && <p className="mt-1 text-xs text-text-secondary">DEPLOYNOW_TAG was moved in {run.envFile}.</p>}
      {run.logs && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-text-muted">What the new version printed</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-secondary p-3 text-xs font-mono text-text-secondary">{run.logs}</pre>
        </details>
      )}
    </div>
  );
}
