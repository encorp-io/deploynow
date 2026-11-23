"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import { Archive, Play, Pencil, Trash2, Plus, RotateCcw, ShieldCheck, Download, FlaskConical, KeyRound, X, PlugZap } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select, Tabs, TextArea, formatBytes, formatTime, timeAgo } from "@/components/ui";

// ─── Types ─────────────────────────────────────────────────────────────────────

type Source =
  | { type: "volume"; name: string }
  | { type: "bind"; path: string }
  | { type: "db"; engine: string; container: string; database?: string; command?: string }
  | { type: "app"; applicationId: string }
  | { type: "instance" };

interface Policy {
  id: string;
  name: string;
  endpointId: string | null;
  endpointName: string;
  destinationId: string;
  destinationName: string;
  sources: Source[];
  mode: string;
  preHook: { container: string; command: string } | null;
  postHook: { container: string; command: string } | null;
  schedule: string;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string;
  repoId?: string;
  kitAvailable?: boolean;
}
interface Destination {
  id: string;
  name: string;
  provider: string;
  endpointUrl: string;
  bucket: string;
  prefix: string;
  region: string;
  accessKeyId: string;
  secretKey: string;
  pruneKeyId: string;
  pruneSecretKey: string;
  objectLock: boolean;
}
interface Repo {
  id: string;
  scope: string;
  scopeName: string;
  destinationName: string;
  url: string;
  initializedAt: string | null;
  kitAvailable: boolean;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastDrillAt: string | null;
  lastDrillOk: boolean | null;
}
interface Run {
  id: string;
  policyId: string | null;
  repoId: string;
  kind: string;
  status: string;
  trigger: string;
  bytes: number;
  error: string;
  actorEmail: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  snapshots: { source: string; id: string }[];
  log?: string;
}
interface Snapshot {
  id: string;
  shortId: string;
  time: string;
  host: string;
  source: string;
  policyName: string;
  files: number | null;
  bytes: number | null;
}
interface EndpointLite {
  id: string;
  name: string;
  status: string;
}

const SCHEDULES = [
  { value: "0 3 * * *", label: "Daily at 03:00" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 * * * *", label: "Hourly" },
  { value: "0 3 * * 0", label: "Weekly, Sunday 03:00" },
];
const MODE_LABEL: Record<string, string> = {
  stop: "Stop containers while copying",
  dump: "Run hooks, copy live",
  live: "Copy live",
};

function sourceLabel(s: Source, apps: Map<string, string>): string {
  switch (s.type) {
    case "volume":
      return `volume ${s.name}`;
    case "bind":
      return `path ${s.path}`;
    case "db":
      return `${s.engine} in ${s.container}${s.database ? ` (${s.database})` : ""}`;
    case "app":
      return `app ${apps.get(s.applicationId) ?? s.applicationId}`;
    case "instance":
      return "DeployNow itself";
  }
}

function statusTone(s: string) {
  return s === "success" ? "success" : s === "failed" ? "danger" : s === "running" ? "accent" : "muted";
}

// ─── Page ──────────────────────────────────────────────────────────────────────

type Tab = "policies" | "snapshots" | "runs" | "destinations";

export default function BackupsPage() {
  const api = useApi();
  const [tab, setTab] = useState<Tab>("policies");
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointLite[]>([]);
  const [apps, setApps] = useState<{ id: string; name: string; endpointId: string }[]>([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const [editingDest, setEditingDest] = useState<Destination | "new" | null>(null);
  const [kitRepo, setKitRepo] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, d, r, ru, e, pr] = await Promise.all([
      api<Policy[]>("/api/backups/policies"),
      api<Destination[]>("/api/backups/destinations"),
      api<Repo[]>("/api/backups/repos"),
      api<Run[]>("/api/backups/runs?limit=100"),
      api<EndpointLite[]>("/api/endpoints"),
      api<{ environments: { apps: { id: string; name: string; endpointId: string }[] }[] }[]>("/api/projects"),
    ]);
    if (!p.ok) return setError(p.data.error ?? "Could not load backups");
    setPolicies(p.data as unknown as Policy[]);
    if (d.ok) setDestinations(d.data as unknown as Destination[]);
    if (r.ok) setRepos(r.data as unknown as Repo[]);
    if (ru.ok) setRuns(ru.data as unknown as Run[]);
    if (e.ok) setEndpoints(e.data as unknown as EndpointLite[]);
    if (pr.ok) setApps((pr.data as unknown as { environments: { apps: { id: string; name: string; endpointId: string }[] }[] }[]).flatMap((x) => x.environments.flatMap((env) => env.apps)));
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh while something is running
  const active = runs.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  const appNames = useMemo(() => new Map(apps.map((a) => [a.id, a.name])), [apps]);

  async function runNow(p: Policy) {
    const res = await api(`/api/backups/policies/${p.id}`, { body: { action: "run" } });
    if (!res.ok) setError(res.data.error ?? "Could not start the backup");
    else {
      setTab("runs");
      load();
    }
  }

  async function removePolicy(p: Policy) {
    if (!confirm(`Remove backup policy ${p.name}? Existing snapshots stay in the bucket.`)) return;
    const res = await api(`/api/backups/policies/${p.id}`, { method: "DELETE" });
    if (!res.ok) setError(res.data.error ?? "Could not remove");
    load();
  }

  return (
    <div>
      <PageHeader
        title="Backups"
        subtitle="Volumes, bind paths, databases and DeployNow itself, with restic to S3-compatible storage"
        actions={
          tab === "destinations" ? (
            <Button onClick={() => setEditingDest("new")}><Plus className="w-4 h-4" /> Add destination</Button>
          ) : (
            <Button onClick={() => (destinations.length ? setEditing("new") : setEditingDest("new"))}><Plus className="w-4 h-4" /> New policy</Button>
          )
        }
      />
      <div className="mb-4">
        <Tabs
          tabs={[
            { value: "policies", label: "Policies" },
            { value: "snapshots", label: "Snapshots and restore" },
            { value: "runs", label: "Activity" },
            { value: "destinations", label: "Destinations" },
          ] as const}
          value={tab}
          onChange={setTab}
        />
      </div>
      <ErrorText>{error}</ErrorText>

      {tab === "policies" && (
        <Card className="overflow-hidden mt-2">
          {policies.length === 0 ? (
            <div className="p-8 text-center">
              <Archive className="w-8 h-8 text-text-muted mx-auto mb-2" />
              <p className="text-sm text-text-secondary">No backup policies yet.</p>
              <p className="text-xs text-text-muted mt-1">
                {destinations.length ? "Create a policy to choose what to back up and when." : "Start by adding a destination: a Cloudflare R2 or other S3 bucket."}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {policies.map((p) => (
                <div key={p.id} className="p-4 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary flex items-center gap-2">
                      {p.name}
                      {!p.enabled && <Badge>paused</Badge>}
                      {p.lastStatus && <Badge tone={statusTone(p.lastStatus)}>{p.lastStatus === "success" ? "last run OK" : "last run failed"}</Badge>}
                    </p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {p.endpointName} → {p.destinationName} · {SCHEDULES.find((s) => s.value === p.schedule)?.label ?? p.schedule} · keep {p.keepDaily}d/{p.keepWeekly}w/{p.keepMonthly}m · {MODE_LABEL[p.mode]}
                    </p>
                    <p className="text-xs text-text-secondary mt-1">{p.sources.map((s) => sourceLabel(s, appNames)).join(" · ")}</p>
                    <p className="text-xs text-text-muted mt-1">
                      Last run {timeAgo(p.lastRunAt)}{p.enabled && p.nextRunAt ? ` · next ${formatTime(p.nextRunAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button variant="secondary" onClick={() => runNow(p)}><Play className="w-4 h-4" /> Back up now</Button>
                    <Button variant="ghost" title="Edit" onClick={() => setEditing(p)}><Pencil className="w-4 h-4" /></Button>
                    <Button variant="ghost" title="Remove" onClick={() => removePolicy(p)}><Trash2 className="w-4 h-4" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {tab === "snapshots" && <SnapshotsTab api={api} repos={repos} endpoints={endpoints} onKit={setKitRepo} onStarted={() => { setTab("runs"); load(); }} />}

      {tab === "runs" && (
        <Card className="overflow-hidden mt-2">
          {runs.length === 0 ? (
            <p className="text-sm text-text-muted p-4">Nothing has run yet.</p>
          ) : (
            <table className="w-full">
              <thead className="border-b border-border">
                <tr>{["What", "Status", "Started", "Took", "Data added", ""].map((h) => <th key={h} className="text-left text-xs font-medium text-text-muted px-4 py-2.5">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => {
                  const pol = policies.find((p) => p.id === r.policyId);
                  const repo = repos.find((x) => x.id === r.repoId);
                  const took = r.startedAt && r.finishedAt ? Math.max(1, Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000)) : null;
                  return (
                    <tr key={r.id} className="hover:bg-bg-card-hover cursor-pointer" onClick={() => setOpenRun(r.id)}>
                      <td className="px-4 py-2.5 text-sm">
                        <span className="capitalize">{r.kind}</span> <span className="text-text-muted">{pol ? pol.name : repo ? repo.scopeName : ""}</span>
                        {r.error && <span className="block text-xs text-danger truncate max-w-md">{r.error}</span>}
                      </td>
                      <td className="px-4 py-2.5"><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                      <td className="px-4 py-2.5 text-xs text-text-muted">{formatTime(r.startedAt ?? r.createdAt)}{r.trigger === "manual" && r.actorEmail ? ` · ${r.actorEmail}` : ""}</td>
                      <td className="px-4 py-2.5 text-xs text-text-muted">{took ? `${took}s` : ""}</td>
                      <td className="px-4 py-2.5 text-xs text-text-muted">{r.kind === "backup" && r.status === "success" ? formatBytes(r.bytes) : ""}</td>
                      <td className="px-4 py-2.5 text-xs text-accent text-right">Log</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "destinations" && (
        <Card className="overflow-hidden mt-2">
          {destinations.length === 0 ? (
            <p className="text-sm text-text-muted p-4">No destinations yet. Cloudflare R2 is the default: create a bucket and an API token with Object Read & Write on it.</p>
          ) : (
            <div className="divide-y divide-border">
              {destinations.map((d) => (
                <div key={d.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary flex items-center gap-2">
                      {d.name} <Badge>{d.provider.toUpperCase()}</Badge>
                      {d.objectLock && <Badge tone="accent">Object Lock</Badge>}
                      {d.pruneKeyId ? <Badge tone="success">separate prune key</Badge> : <Badge tone="warning">one key</Badge>}
                    </p>
                    <p className="text-xs text-text-muted font-mono mt-0.5 truncate">{d.endpointUrl}/{d.bucket}/{d.prefix}</p>
                  </div>
                  <div className="flex gap-1">
                    <TestButton api={api} url={`/api/backups/destinations/${d.id}`} />
                    <Button variant="ghost" onClick={() => setEditingDest(d)}><Pencil className="w-4 h-4" /></Button>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm(`Remove destination ${d.name}? Its policies are removed too. The data in the bucket is not deleted.`)) return;
                        const res = await api(`/api/backups/destinations/${d.id}`, { method: "DELETE" });
                        if (!res.ok) setError(res.data.error ?? "Could not remove");
                        load();
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {editing && (
        <Modal title={editing === "new" ? "New backup policy" : `Edit ${editing.name}`} onClose={() => setEditing(null)} wide>
          <PolicyForm
            api={api}
            existing={editing === "new" ? undefined : editing}
            destinations={destinations}
            endpoints={endpoints}
            apps={apps}
            onCancel={() => setEditing(null)}
            onSaved={(p) => {
              setEditing(null);
              if (p.kitAvailable && p.repoId) setKitRepo(p.repoId);
              load();
            }}
          />
        </Modal>
      )}
      {editingDest && (
        <Modal title={editingDest === "new" ? "Add a destination" : `Edit ${editingDest.name}`} onClose={() => setEditingDest(null)} wide>
          <DestinationForm api={api} existing={editingDest === "new" ? undefined : editingDest} onCancel={() => setEditingDest(null)} onSaved={() => { setEditingDest(null); load(); }} />
        </Modal>
      )}
      {kitRepo && <KitModal api={api} repoId={kitRepo} onClose={() => { setKitRepo(null); load(); }} />}
      {openRun && <RunModal api={api} runId={openRun} onClose={() => setOpenRun(null)} />}
    </div>
  );
}

type Api = ReturnType<typeof useApi>;

function TestButton({ api, url, body }: { api: Api; url: string; body?: unknown }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {result && <span className={clsx("text-xs max-w-xs truncate", result.ok ? "text-success" : "text-danger")} title={result.message}>{result.message}</span>}
      <Button
        type="button"
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const res = await api<{ ok: boolean; message: string }>(url, { body: body ?? {} });
          setBusy(false);
          setResult(res.ok ? (res.data as { ok: boolean; message: string }) : { ok: false, message: res.data.error ?? "Test failed" });
        }}
      >
        <PlugZap className="w-4 h-4" /> Test
      </Button>
    </span>
  );
}

// ─── Destination form ──────────────────────────────────────────────────────────

function DestinationForm({ api, existing, onSaved, onCancel }: { api: Api; existing?: Destination; onSaved: () => void; onCancel: () => void }) {
  const [f, setF] = useState({
    name: existing?.name ?? "Cloudflare R2",
    provider: existing?.provider ?? "r2",
    endpointUrl: existing?.endpointUrl ?? "",
    bucket: existing?.bucket ?? "",
    prefix: existing?.prefix ?? "deploynow",
    region: existing?.region ?? "auto",
    accessKeyId: existing?.accessKeyId ?? "",
    secretKey: existing?.secretKey ?? "",
    pruneKeyId: existing?.pruneKeyId ?? "",
    pruneSecretKey: existing?.pruneSecretKey ?? "",
    objectLock: existing?.objectLock ?? false,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save() {
    setBusy(true);
    setError("");
    const res = await api(existing ? `/api/backups/destinations/${existing.id}` : "/api/backups/destinations", { method: existing ? "PATCH" : "POST", body: f });
    setBusy(false);
    if (res.ok) onSaved();
    else setError(res.data.error ?? "Could not save");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><Input value={f.name} onChange={set("name")} /></Field>
        <Field label="Provider">
          <Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value, region: e.target.value === "r2" ? "auto" : f.region === "auto" ? "us-east-1" : f.region })}>
            <option value="r2">Cloudflare R2</option>
            <option value="s3">Amazon S3</option>
            <option value="b2">Backblaze B2</option>
            <option value="other">Other S3-compatible</option>
          </Select>
        </Field>
      </div>
      <Field label={f.provider === "r2" ? "Account id or endpoint URL" : "Endpoint URL"} hint={f.provider === "r2" ? "Your Cloudflare account id, or https://<account id>.r2.cloudflarestorage.com" : "e.g. https://s3.eu-central-1.amazonaws.com"}>
        <Input value={f.endpointUrl} onChange={set("endpointUrl")} placeholder={f.provider === "r2" ? "0123456789abcdef0123456789abcdef" : "https://s3.amazonaws.com"} />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Bucket"><Input value={f.bucket} onChange={set("bucket")} placeholder="backups" disabled={!!existing} /></Field>
        <Field label="Folder"><Input value={f.prefix} onChange={set("prefix")} disabled={!!existing} /></Field>
        <Field label="Region"><Input value={f.region} onChange={set("region")} /></Field>
      </div>
      <p className="text-xs font-medium text-text-secondary pt-1">Backup key: read and write, ideally without delete</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Access key id"><Input value={f.accessKeyId} onChange={set("accessKeyId")} autoComplete="off" /></Field>
        <Field label="Secret access key"><Input type="password" value={f.secretKey} onChange={set("secretKey")} autoComplete="new-password" /></Field>
      </div>
      <p className="text-xs font-medium text-text-secondary pt-1">Prune key (optional): may delete, used only for retention and checks</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Access key id"><Input value={f.pruneKeyId} onChange={set("pruneKeyId")} autoComplete="off" /></Field>
        <Field label="Secret access key"><Input type="password" value={f.pruneSecretKey} onChange={set("pruneSecretKey")} autoComplete="new-password" /></Field>
      </div>
      <label className="flex items-start gap-2 text-sm text-text-primary">
        <input type="checkbox" className="mt-1" checked={f.objectLock} onChange={(e) => setF({ ...f, objectLock: e.target.checked })} />
        <span>
          The bucket uses Object Lock
          <span className="block text-xs text-text-muted">Locked objects can't be deleted until the lock expires, so set the lock period shorter than your monthly retention. Prune skips what it can't delete yet.</span>
        </span>
      </label>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-between pt-2">
        <TestButton api={api} url="/api/backups/destinations/test" body={f} />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button loading={busy} onClick={save}>{existing ? "Save" : "Add destination"}</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Policy form ───────────────────────────────────────────────────────────────

interface ContainerRow { id: string; name: string; image: string; state: string }
interface VolumeRow { name: string; usedBy: string[] }

function guessEngine(image: string): string {
  if (/postgres|postgis|timescale/i.test(image)) return "postgres";
  if (/mysql|mariadb/i.test(image)) return "mysql";
  if (/mongo/i.test(image)) return "mongo";
  if (/redis|valkey|keydb/i.test(image)) return "redis";
  return "";
}

function PolicyForm({
  api,
  existing,
  destinations,
  endpoints,
  apps,
  onSaved,
  onCancel,
}: {
  api: Api;
  existing?: Policy;
  destinations: Destination[];
  endpoints: EndpointLite[];
  apps: { id: string; name: string; endpointId: string }[];
  onSaved: (p: Policy) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState({
    name: existing?.name ?? "",
    endpointId: existing ? (existing.endpointId ?? "instance") : (endpoints[0]?.id ?? "instance"),
    destinationId: existing?.destinationId ?? destinations[0]?.id ?? "",
    mode: existing?.mode ?? "live",
    schedule: existing?.schedule ?? "0 3 * * *",
    keepDaily: existing?.keepDaily ?? 7,
    keepWeekly: existing?.keepWeekly ?? 4,
    keepMonthly: existing?.keepMonthly ?? 6,
    enabled: existing?.enabled ?? true,
    preContainer: existing?.preHook?.container ?? "",
    preCommand: existing?.preHook?.command ?? "",
    postContainer: existing?.postHook?.container ?? "",
    postCommand: existing?.postHook?.command ?? "",
  });
  const [sources, setSources] = useState<Source[]>(existing?.sources ?? []);
  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [volumes, setVolumes] = useState<VolumeRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bindPath, setBindPath] = useState("");
  const instance = f.endpointId === "instance";

  useEffect(() => {
    if (instance) {
      setSources([{ type: "instance" }]);
      return;
    }
    if (sources.some((s) => s.type === "instance")) setSources([]);
    Promise.all([api<ContainerRow[]>(`/api/endpoints/${f.endpointId}/containers`), api<VolumeRow[]>(`/api/endpoints/${f.endpointId}/volumes`)]).then(([c, v]) => {
      setContainers(c.ok ? (c.data as unknown as ContainerRow[]) : []);
      setVolumes(v.ok ? (v.data as unknown as VolumeRow[]) : []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.endpointId, instance, api]);

  const has = (s: Source) => sources.some((x) => JSON.stringify(x) === JSON.stringify(s));
  const toggle = (s: Source) => setSources(has(s) ? sources.filter((x) => JSON.stringify(x) !== JSON.stringify(s)) : [...sources, s]);
  const dbCandidates = containers.filter((c) => guessEngine(c.image));

  async function save() {
    setBusy(true);
    setError("");
    const body = {
      name: f.name,
      endpointId: instance ? null : f.endpointId,
      destinationId: f.destinationId,
      sources,
      mode: f.mode,
      schedule: f.schedule,
      keepDaily: f.keepDaily,
      keepWeekly: f.keepWeekly,
      keepMonthly: f.keepMonthly,
      enabled: f.enabled,
      preHook: instance ? null : { container: f.preContainer, command: f.preCommand },
      postHook: instance ? null : { container: f.postContainer, command: f.postCommand },
    };
    const res = await api<Policy>(existing ? `/api/backups/policies/${existing.id}` : "/api/backups/policies", { method: existing ? "PATCH" : "POST", body });
    setBusy(false);
    if (res.ok) onSaved(res.data as Policy);
    else setError(res.data.error ?? "Could not save");
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="nightly" /></Field>
        <Field label="Destination">
          <Select value={f.destinationId} disabled={!!existing} onChange={(e) => setF({ ...f, destinationId: e.target.value })}>
            {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="What to back up from">
        <Select value={f.endpointId} disabled={!!existing} onChange={(e) => setF({ ...f, endpointId: e.target.value })}>
          {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          <option value="instance">DeployNow itself (its database and certificates)</option>
        </Select>
      </Field>

      {!instance && (
        <div className="space-y-3">
          <p className="text-xs font-medium text-text-secondary">Sources</p>
          {apps.filter((a) => a.endpointId === f.endpointId).length > 0 && (
            <div>
              <p className="text-xs text-text-muted mb-1">Apps (all their volumes)</p>
              <div className="flex flex-wrap gap-2">
                {apps.filter((a) => a.endpointId === f.endpointId).map((a) => {
                  const s: Source = { type: "app", applicationId: a.id };
                  return <Chip key={a.id} on={has(s)} onClick={() => toggle(s)}>{a.name}</Chip>;
                })}
              </div>
            </div>
          )}
          <div>
            <p className="text-xs text-text-muted mb-1">Volumes</p>
            <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
              {volumes.length === 0 && <span className="text-xs text-text-muted">No volumes on this endpoint</span>}
              {volumes.map((v) => {
                const s: Source = { type: "volume", name: v.name };
                return <Chip key={v.name} on={has(s)} onClick={() => toggle(s)} title={v.usedBy.join(", ")}>{v.name.length > 40 ? v.name.slice(0, 37) + "…" : v.name}</Chip>;
              })}
            </div>
          </div>
          <div>
            <p className="text-xs text-text-muted mb-1">Databases (dumped with the database&apos;s own tools)</p>
            <div className="flex flex-wrap gap-2">
              {dbCandidates.length === 0 && <span className="text-xs text-text-muted">No Postgres, MySQL/MariaDB, MongoDB or Redis containers found</span>}
              {dbCandidates.map((c) => {
                const s: Source = { type: "db", engine: guessEngine(c.image), container: c.name };
                const on = sources.some((x) => x.type === "db" && x.container === c.name);
                return (
                  <Chip key={c.id} on={on} onClick={() => (on ? setSources(sources.filter((x) => !(x.type === "db" && x.container === c.name))) : setSources([...sources, s]))}>
                    {c.name} <span className="opacity-60">{guessEngine(c.image)}</span>
                  </Chip>
                );
              })}
            </div>
            {sources.filter((s): s is Extract<Source, { type: "db" }> => s.type === "db").map((s) => (
              <div key={s.container} className="grid grid-cols-[10rem_1fr] gap-2 items-center mt-2">
                <span className="text-xs text-text-secondary truncate">{s.container} database</span>
                <Input
                  value={s.database ?? ""}
                  placeholder="all databases"
                  onChange={(e) => setSources(sources.map((x) => (x.type === "db" && x.container === s.container ? { ...x, database: e.target.value || undefined } : x)))}
                />
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs text-text-muted mb-1">Host paths (opt in; the path on the server)</p>
            <div className="flex gap-2">
              <Input value={bindPath} onChange={(e) => setBindPath(e.target.value)} placeholder="/srv/app/uploads" />
              <Button variant="secondary" type="button" onClick={() => { if (bindPath.trim()) { toggle({ type: "bind", path: bindPath.trim().replace(/\/+$/, "") }); setBindPath(""); } }}>Add</Button>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {sources.filter((s): s is Extract<Source, { type: "bind" }> => s.type === "bind").map((s) => (
                <Chip key={s.path} on onClick={() => toggle(s)}>{s.path} <X className="w-3 h-3" /></Chip>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Schedule" hint="Cron, in the server's time zone">
          <div className="flex gap-2">
            <Select value={SCHEDULES.some((s) => s.value === f.schedule) ? f.schedule : "custom"} onChange={(e) => e.target.value !== "custom" && setF({ ...f, schedule: e.target.value })} className="w-1/2">
              {SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              <option value="custom">Custom</option>
            </Select>
            <Input value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} className="font-mono w-1/2" />
          </div>
        </Field>
        <Field label="Keep (daily / weekly / monthly)">
          <div className="grid grid-cols-3 gap-2">
            <Input type="number" min={0} value={f.keepDaily} onChange={(e) => setF({ ...f, keepDaily: Number(e.target.value) })} />
            <Input type="number" min={0} value={f.keepWeekly} onChange={(e) => setF({ ...f, keepWeekly: Number(e.target.value) })} />
            <Input type="number" min={0} value={f.keepMonthly} onChange={(e) => setF({ ...f, keepMonthly: Number(e.target.value) })} />
          </div>
        </Field>
      </div>

      {!instance && (
        <>
          <Field label="Consistency" hint="Databases are always dumped. Stop briefly stops containers that use the volumes or paths, then starts them again.">
            <Select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
              <option value="live">{MODE_LABEL.live}</option>
              <option value="dump">{MODE_LABEL.dump}</option>
              <option value="stop">{MODE_LABEL.stop}</option>
            </Select>
          </Field>
          <details className="text-sm" open={!!(f.preCommand || f.postCommand)}>
            <summary className="text-xs text-text-secondary cursor-pointer">Pre and post hooks</summary>
            <div className="grid grid-cols-[12rem_1fr] gap-2 mt-2">
              <Input placeholder="container" value={f.preContainer} onChange={(e) => setF({ ...f, preContainer: e.target.value })} />
              <Input placeholder="before, e.g. redis-cli BGSAVE" value={f.preCommand} onChange={(e) => setF({ ...f, preCommand: e.target.value })} className="font-mono" />
              <Input placeholder="container" value={f.postContainer} onChange={(e) => setF({ ...f, postContainer: e.target.value })} />
              <Input placeholder="after" value={f.postCommand} onChange={(e) => setF({ ...f, postCommand: e.target.value })} className="font-mono" />
            </div>
          </details>
        </>
      )}
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Run on schedule
      </label>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button loading={busy} onClick={save}>{existing ? "Save" : "Create policy"}</Button>
      </div>
    </div>
  );
}

function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx("inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border font-mono", on ? "border-accent bg-accent/10 text-accent" : "border-border text-text-secondary hover:border-border-bright")}
    >
      {children}
    </button>
  );
}

// ─── Snapshots and restore ─────────────────────────────────────────────────────

function SnapshotsTab({ api, repos, endpoints, onKit, onStarted }: { api: Api; repos: Repo[]; endpoints: EndpointLite[]; onKit: (id: string) => void; onStarted: () => void }) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState<Snapshot | null>(null);
  const repo = repos.find((r) => r.id === repoId);

  useEffect(() => {
    if (!repoId && repos[0]) setRepoId(repos[0].id);
  }, [repos, repoId]);

  useEffect(() => {
    if (!repoId) return;
    setSnaps(null);
    setError("");
    api<Snapshot[]>(`/api/backups/repos/${repoId}`).then((res) => {
      if (res.ok) setSnaps(res.data as unknown as Snapshot[]);
      else {
        setSnaps([]);
        setError(res.data.error ?? "Could not list snapshots");
      }
    });
  }, [api, repoId]);

  async function action(a: "check" | "drill") {
    const res = await api(`/api/backups/repos/${repoId}`, { body: { action: a } });
    if (res.ok) onStarted();
    else setError(res.data.error ?? "Could not start");
  }

  if (repos.length === 0) return <Card className="p-4 mt-2"><p className="text-sm text-text-muted">No repositories yet. They are created with the first backup policy for each endpoint.</p></Card>;

  const health = (ok: boolean | null, at: string | null, label: string) =>
    at ? <Badge tone={ok ? "success" : "danger"}>{label} {ok ? "passed" : "failed"} {timeAgo(at)}</Badge> : <Badge>{label}: not yet</Badge>;

  return (
    <div className="space-y-3 mt-2">
      <Card className="p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Select value={repoId} onChange={(e) => setRepoId(e.target.value)} className="w-72">
              {repos.map((r) => <option key={r.id} value={r.id}>{r.scopeName} → {r.destinationName}</option>)}
            </Select>
            {repo && health(repo.lastCheckOk, repo.lastCheckAt, "Check")}
            {repo && health(repo.lastDrillOk, repo.lastDrillAt, "Restore drill")}
          </div>
          <div className="flex gap-2">
            {repo?.kitAvailable && <Button variant="secondary" onClick={() => onKit(repo.id)}><KeyRound className="w-4 h-4" /> Recovery kit</Button>}
            <Button variant="secondary" onClick={() => action("check")}><ShieldCheck className="w-4 h-4" /> Check</Button>
            <Button variant="secondary" onClick={() => action("drill")}><FlaskConical className="w-4 h-4" /> Restore drill</Button>
          </div>
        </div>
        {repo && <p className="text-xs text-text-muted font-mono mt-2 truncate">{repo.url}</p>}
      </Card>
      <ErrorText>{error}</ErrorText>
      <Card className="overflow-hidden">
        {snaps === null ? (
          <p className="text-sm text-text-muted p-4">Loading snapshots…</p>
        ) : snaps.length === 0 ? (
          <p className="text-sm text-text-muted p-4">No snapshots in this repository yet.</p>
        ) : (
          <table className="w-full">
            <thead className="border-b border-border">
              <tr>{["Snapshot", "Source", "Policy", "Size", ""].map((h) => <th key={h} className="text-left text-xs font-medium text-text-muted px-4 py-2.5">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {snaps.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 text-sm"><span className="font-mono text-xs text-text-muted">{s.shortId}</span> {formatTime(s.time)}</td>
                  <td className="px-4 py-2.5 text-xs font-mono">{s.source}</td>
                  <td className="px-4 py-2.5 text-xs text-text-muted">{s.policyName}</td>
                  <td className="px-4 py-2.5 text-xs text-text-muted">{s.bytes !== null ? `${formatBytes(s.bytes)}, ${s.files} files` : ""}</td>
                  <td className="px-4 py-2.5 text-right">
                    {s.source !== "instance" && <Button variant="ghost" onClick={() => setRestoring(s)}><RotateCcw className="w-4 h-4" /> Restore</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {restoring && repo && (
        <Modal title={`Restore ${restoring.source}`} onClose={() => setRestoring(null)} wide>
          <RestoreForm api={api} repo={repo} snap={restoring} endpoints={endpoints} onCancel={() => setRestoring(null)} onStarted={() => { setRestoring(null); onStarted(); }} />
        </Modal>
      )}
    </div>
  );
}

function RestoreForm({ api, repo, snap, endpoints, onStarted, onCancel }: { api: Api; repo: Repo; snap: Snapshot; endpoints: EndpointLite[]; onStarted: () => void; onCancel: () => void }) {
  const kind = snap.source.split(":")[0];
  const original = snap.source.slice(kind.length + 1);
  const [target, setTarget] = useState<"same" | "volume" | "path" | "container">("same");
  const [endpointId, setEndpointId] = useState(repo.scope);
  const [name, setName] = useState(kind === "volume" ? `${original}-restored` : kind === "bind" ? `${original}-restored` : "");
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const other = kind === "volume" ? "volume" : kind === "bind" ? "path" : "container";

  async function start() {
    const msg =
      target === "same"
        ? `Restore ${snap.source} from ${formatTime(snap.time)} in place? ${kind === "db" ? "The dump is loaded into the running database." : "Current contents are replaced and containers using it are stopped while it runs."}`
        : `Restore ${snap.source} to ${name}?`;
    if (!confirm(msg)) return;
    setBusy(true);
    setError("");
    const res = await api(`/api/backups/repos/${repo.id}`, {
      body: { action: "restore", snapshotId: snap.id, target, endpointId: endpointId !== repo.scope ? endpointId : undefined, name: target === "same" ? undefined : name, overwrite },
    });
    setBusy(false);
    if (res.ok) onStarted();
    else setError(res.data.error ?? "Could not start the restore");
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">Snapshot {snap.shortId} from {formatTime(snap.time)}.</p>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="radio" checked={target === "same"} onChange={() => { setTarget("same"); setEndpointId(repo.scope); }} /> Back where it came from ({original})</label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={target !== "same"} onChange={() => setTarget(other)} />
          {kind === "volume" ? "To a new volume" : kind === "bind" ? "To another path" : "Into another database container"}, on this or another endpoint
        </label>
      </div>
      {target !== "same" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Endpoint">
            <Select value={endpointId} onChange={(e) => setEndpointId(e.target.value)}>
              {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}{e.id === repo.scope ? " (original)" : ""}</option>)}
            </Select>
          </Field>
          <Field label={kind === "volume" ? "Volume name" : kind === "bind" ? "Path" : "Container"}>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />
          </Field>
          {kind !== "db" && (
            <label className="flex items-center gap-2 text-sm col-span-2"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Overwrite it if it already exists</label>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button loading={busy} onClick={start}><RotateCcw className="w-4 h-4" /> Restore</Button>
      </div>
    </div>
  );
}

// ─── Recovery kit and run log ──────────────────────────────────────────────────

function KitModal({ api, repoId, onClose }: { api: Api; repoId: string; onClose: () => void }) {
  const [kit, setKit] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reveal() {
    setBusy(true);
    const res = await api<{ kit: string }>(`/api/backups/repos/${repoId}`, { body: { action: "kit" } });
    setBusy(false);
    if (res.ok) setKit((res.data as { kit: string }).kit);
    else setError(res.data.error ?? "Could not show the kit");
  }
  function download() {
    const url = URL.createObjectURL(new Blob([kit], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "deploynow-recovery-kit.txt";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <Modal title="Recovery kit" onClose={() => { if (!kit || confirm("Did you save the kit? It can't be shown again.")) onClose(); }} wide>
      {!kit ? (
        <div className="space-y-3">
          <p className="text-sm text-text-secondary">
            Backups are encrypted with a password DeployNow keeps for you. The recovery kit has that password and the commands to restore
            without DeployNow, for when this server is gone. It is shown <strong>once</strong>: download it and keep it offline, with the secret key in your password manager.
          </p>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Later</Button>
            <Button loading={busy} onClick={reveal}><KeyRound className="w-4 h-4" /> Show the kit</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <TextArea readOnly rows={16} value={kit} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={download}><Download className="w-4 h-4" /> Download</Button>
            <Button onClick={onClose}>I saved it</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RunModal({ api, runId, onClose }: { api: Api; runId: string; onClose: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const res = await api<Run>(`/api/backups/runs/${runId}`);
      if (stop || !res.ok) return;
      const r = res.data as Run;
      setRun(r);
      if (r.status === "queued" || r.status === "running") setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [api, runId]);
  return (
    <Modal title={run ? `${run.kind[0].toUpperCase()}${run.kind.slice(1)}: ${run.status}` : "Run"} onClose={onClose} wide>
      {run?.error && <ErrorText>{run.error}</ErrorText>}
      <pre className="mt-3 bg-bg-primary border border-border rounded-lg p-3 text-xs font-mono text-text-secondary whitespace-pre-wrap max-h-[60vh] overflow-y-auto">{run?.log || "Waiting…"}</pre>
    </Modal>
  );
}
