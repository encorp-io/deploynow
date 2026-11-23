"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpCircle, ExternalLink, RefreshCw, X } from "lucide-react";
import { useApi } from "./AppShell";
import { Button, ErrorText } from "./ui";

export interface UpdateInfo {
  current: string;
  latest?: string;
  url?: string;
  notes?: string;
  available?: boolean;
  enabled?: boolean;
  envDisabled?: boolean;
  checkedAt?: string | null;
}

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

/** Settings → Updates and health: the running version, the newest release and its notes. */
export function DeployNowUpdates() {
  const api = useApi();
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const r = await api<UpdateInfo>("/api/updates");
    if (r.ok) setInfo(r.data as UpdateInfo);
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  if (!info) return null;
  const post = async (body: Record<string, unknown>, what: string) => {
    setBusy(what);
    setError("");
    const r = await api<UpdateInfo>("/api/updates", { method: "POST", body });
    setBusy("");
    if (!r.ok) return setError(r.data.error ?? "Couldn't check");
    setInfo(r.data as UpdateInfo);
  };
  const tag = info.latest ?? "";

  return (
    <section className="dn-surface border border-border rounded-2xl p-6">
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><ArrowUpCircle className="w-4 h-4" /> DeployNow version</h2>
      <p className="text-xs text-text-muted mb-4">
        Twice a day DeployNow reads the releases on GitHub and tells admins, and the notification channels that subscribe to &quot;New DeployNow version&quot;, when a newer one is out.
        Nothing about this instance is sent.
      </p>
      <div className="text-sm space-y-1">
        <p className="text-text-secondary">Running <strong className="text-text-primary">{info.current}</strong></p>
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
      {info.available && (
        <div className="mt-4 space-y-3">
          {info.notes && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-secondary p-3 text-xs text-text-secondary font-sans">{info.notes}</pre>}
          <div className="text-xs text-text-secondary">
            <p className="mb-1">To upgrade, next to your <code>docker-compose.yml</code>:</p>
            <pre className="rounded-lg bg-bg-secondary p-3 font-mono overflow-x-auto">{`sed -i 's/^DEPLOYNOW_TAG=.*/DEPLOYNOW_TAG=${tag}/' .env\ndocker compose pull && docker compose up -d`}</pre>
            <p className="mt-1">The database is backed up before it migrates.</p>
          </div>
          {info.url && (
            <a href={info.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
              Release on GitHub <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={() => post({ check: true }, "check")} loading={busy === "check"} disabled={info.envDisabled || !info.enabled}>
          {busy !== "check" && <RefreshCw className="w-4 h-4" />} Check now
        </Button>
        {info.envDisabled ? (
          <span className="text-xs text-text-muted">Turned off with DEPLOYNOW_UPDATE_CHECK=off.</span>
        ) : (
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={!!info.enabled} onChange={(e) => post({ enabled: e.target.checked }, "toggle")} disabled={busy === "toggle"} />
            Check for new releases
          </label>
        )}
      </div>
      <div className="mt-2"><ErrorText>{error}</ErrorText></div>
    </section>
  );
}
