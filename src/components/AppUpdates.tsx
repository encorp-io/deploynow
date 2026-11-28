"use client";

import { useState } from "react";
import { ArrowUpCircle, RefreshCw, Rocket } from "lucide-react";
import { useApi } from "./AppShell";
import { Button, timeAgo } from "./ui";
import { useToast } from "./feedback";

export interface UpdateChange {
  kind: "commit" | "image";
  name: string;
  from: string;
  to: string;
}

export interface TagUpdate {
  service: string;
  image: string;
  from: string;
  to: string;
  kind: "minor" | "major" | "build";
  via?: string;
  variable?: string;
}

export interface AppUpdatesValue {
  updates: { changes: UpdateChange[]; tags: TagUpdate[] };
  updateError: string;
  updateCheckedAt: string | null;
}

/** "ghcr.io/acme/web:sha-1" + "sha-2" → "ghcr.io/acme/web:sha-2" */
function withTag(image: string, tag: string): string {
  const at = image.lastIndexOf(":");
  return `${at > image.lastIndexOf("/") ? image.slice(0, at) : image}:${tag}`;
}

function tagLabel(t: TagUpdate): string {
  if (t.kind === "build") return t.to === t.via ? `a newer build on :${t.via}` : `${t.to}, the newer build on :${t.via}`;
  return t.kind === "major" ? `${t.to} (new major version)` : t.to;
}

/**
 * What the last update check found for the app: a new image or commit (deploy
 * to apply) or a newer tag (change the image first). Shown on every tab.
 */
export function AppUpdates({
  appId,
  sourceType,
  value,
  canDeploy,
  canManage,
  deploying,
  onDeploy,
  onUseTag,
  onChecked,
}: {
  appId: string;
  sourceType: string;
  value: AppUpdatesValue;
  canDeploy: boolean;
  canManage: boolean;
  deploying: boolean;
  onDeploy: () => void;
  /** Point the app (its image, or the compose variable the image comes from) at the new tag */
  onUseTag: (t: TagUpdate, image: string) => Promise<void>;
  onChecked: (v: AppUpdatesValue) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [using, setUsing] = useState("");
  const { changes, tags } = value.updates;

  const check = async () => {
    setChecking(true);
    const res = await api<{ changes: UpdateChange[]; tags: TagUpdate[]; summary: string; error: string; checkedAt: string }>(`/api/apps/${appId}/updates`, { method: "POST", body: {} });
    setChecking(false);
    if (!res.ok) return toast.error(res.data.error ?? "Could not check for updates");
    const d = res.data as { changes: UpdateChange[]; tags: TagUpdate[]; summary: string; error: string; checkedAt: string };
    onChecked({ updates: { changes: d.changes, tags: d.tags }, updateError: d.error, updateCheckedAt: d.checkedAt });
    if (d.changes.length || d.tags.length) toast.success("Update found");
    else if (d.error) toast.error(d.error);
    else toast.success("Up to date");
  };

  const checkedLine = (
    <span className="text-xs text-text-muted">
      {value.updateCheckedAt ? `Checked ${timeAgo(value.updateCheckedAt)}` : "Not checked yet"}
      {value.updateError && <span className="text-warning"> · {value.updateError}</span>}
    </span>
  );

  if (!changes.length && !tags.length) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {checkedLine}
        <button onClick={check} disabled={checking} className="text-xs text-text-muted hover:text-accent inline-flex items-center gap-1 disabled:opacity-50">
          <RefreshCw className={`w-3 h-3 ${checking ? "animate-spin" : ""}`} /> Check for updates
        </button>
      </div>
    );
  }

  const isImage = sourceType === "image";
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <ArrowUpCircle className="w-4 h-4 text-warning flex-shrink-0" />
        <p className="text-sm font-medium text-text-primary flex-1 min-w-[12rem]">Update available</p>
        {checkedLine}
        <Button variant="ghost" onClick={check} loading={checking}><RefreshCw className="w-4 h-4" /> Check again</Button>
      </div>

      {changes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <ul className="text-sm text-text-secondary flex-1 min-w-[12rem] space-y-0.5">
            {changes.map((c) => (
              <li key={`${c.kind}:${c.name}`}>
                {c.kind === "commit" ? (
                  <>New commit <code className="text-xs">{c.to.slice(0, 12)}</code> on {c.name}</>
                ) : (
                  <>New image for <code className="text-xs">{c.name}</code> (same tag)</>
                )}
              </li>
            ))}
          </ul>
          {canDeploy && <Button onClick={onDeploy} loading={deploying}><Rocket className="w-4 h-4" /> Deploy to update</Button>}
        </div>
      )}

      {tags.length > 0 && (
        <ul className="text-sm text-text-secondary space-y-1.5">
          {tags.map((t) => {
            const key = `${t.service}:${t.image}:${t.to}`;
            const next = withTag(t.image, t.to);
            // An image app or a compose image that comes from one variable can be switched from here
            const canSwitch = canManage && (isImage || !!t.variable);
            return (
              <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex-1 min-w-[12rem]">
                  {t.service && <span className="font-mono text-xs text-text-primary">{t.service}: </span>}
                  <code className="text-xs">{t.image}</code> → {tagLabel(t)}
                  {!canSwitch && !isImage && (
                    <span className="block text-xs text-text-muted">
                      {t.variable ? `Set ${t.variable} to ${next}, then deploy.` : `Change the image in the compose file to ${next}, then deploy.`}
                    </span>
                  )}
                </span>
                {canSwitch && (
                  <Button
                    variant="secondary"
                    loading={using === key}
                    onClick={async () => {
                      setUsing(key);
                      try {
                        await onUseTag(t, next);
                      } finally {
                        setUsing("");
                      }
                    }}
                  >
                    {isImage ? `Use ${t.to}` : `Set ${t.variable} to ${t.to}`}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
