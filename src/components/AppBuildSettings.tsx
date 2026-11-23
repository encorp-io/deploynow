"use client";

import { useEffect, useState } from "react";
import { GitPullRequest, Hammer } from "lucide-react";
import { useApi } from "./AppShell";
import { Button, Card, Field, Input, Select } from "./ui";

export interface BuildPreviewValue {
  buildEndpointId: string | null;
  registryId: string | null;
  previewsEnabled: boolean;
  previewDomain: string;
}

/** Build server, registry and pull request previews for a Git app. */
export function AppBuildSettings({
  app,
  onSave,
  busy,
}: {
  app: BuildPreviewValue & { sourceType: string; endpoint: { id: string; name: string }; previewOfId: string | null; webhookUrl: string | null };
  onSave: (body: Record<string, unknown>, what: string) => void;
  busy: boolean;
}) {
  const api = useApi();
  const [v, setV] = useState<BuildPreviewValue>({ buildEndpointId: app.buildEndpointId, registryId: app.registryId, previewsEnabled: app.previewsEnabled, previewDomain: app.previewDomain });
  const [endpoints, setEndpoints] = useState<{ id: string; name: string }[]>([]);
  const [registries, setRegistries] = useState<{ id: string; name: string; namespace: string }[] | null>(null);

  useEffect(() => {
    api<{ id: string; name: string }[]>("/api/endpoints").then((r) => r.ok && setEndpoints(r.data as unknown as { id: string; name: string }[]));
    api<{ id: string; name: string; namespace: string }[]>("/api/registries").then((r) => setRegistries(r.ok ? (r.data as unknown as { id: string; name: string; namespace: string }[]) : null));
  }, [api]);

  const isDockerfile = app.sourceType === "git-dockerfile";
  return (
    <Card className="p-5 space-y-4">
      {isDockerfile && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2"><Hammer className="w-4 h-4" /> Build</h3>
          <p className="text-xs text-text-muted">Build on another machine so heavy builds don&apos;t slow down {app.endpoint.name}. The image is pushed to a registry and pulled by {app.endpoint.name}.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Build on">
              <Select value={v.buildEndpointId ?? ""} onChange={(e) => setV({ ...v, buildEndpointId: e.target.value || null })}>
                <option value="">{app.endpoint.name} (where it runs)</option>
                {endpoints.filter((e) => e.id !== app.endpoint.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
            </Field>
            <Field label="Push to registry" hint={registries === null ? "Only admins can list registries" : "Needs a push namespace"}>
              <Select value={v.registryId ?? ""} onChange={(e) => setV({ ...v, registryId: e.target.value || null })} disabled={registries === null}>
                <option value="">Don&apos;t push (keep the image local)</option>
                {(registries ?? []).filter((r) => r.namespace).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.namespace})</option>)}
              </Select>
            </Field>
          </div>
        </div>
      )}
      {!app.previewOfId && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2"><GitPullRequest className="w-4 h-4" /> Pull request previews</h3>
          <p className="text-xs text-text-muted">
            Each pull request from this repository gets its own copy at <code>pr-&lt;number&gt;.{v.previewDomain || "preview.example.com"}</code>, removed when the PR closes. Point <code>*.{v.previewDomain || "preview.example.com"}</code> at {app.endpoint.name}, and send GitHub&apos;s <b>pull request</b> events to the webhook{app.webhookUrl ? <> (<code>{app.webhookUrl}</code>)</> : null}. Pull requests from forks are ignored.
          </p>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={v.previewsEnabled} onChange={(e) => setV({ ...v, previewsEnabled: e.target.checked })} /> Create previews for pull requests
          </label>
          {v.previewsEnabled && (
            <Field label="Preview domain"><Input value={v.previewDomain} onChange={(e) => setV({ ...v, previewDomain: e.target.value })} placeholder="preview.example.com" /></Field>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button onClick={() => onSave({ ...v }, "Build and preview settings")} loading={busy}>Save</Button>
      </div>
    </Card>
  );
}
