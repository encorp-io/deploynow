"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, History, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select, TextArea, formatTime, timeAgo, IconButton, Skeleton } from "@/components/ui";
import { useConfirm } from "@/components/feedback";

interface Task {
  id: string;
  name: string;
  endpointId: string;
  endpointName: string;
  schedule: string;
  mode: "exec" | "run";
  container: string;
  image: string;
  command: string;
  env: string;
  timeoutSec: number;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string;
}
interface TaskRun {
  id: string;
  status: string;
  trigger: string;
  exitCode: number | null;
  log: string;
  startedAt: string;
  finishedAt: string | null;
}
interface EndpointLite {
  id: string;
  name: string;
}

type Api = ReturnType<typeof useApi>;

export default function TasksPage() {
  const api = useApi();
  const confirm = useConfirm();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointLite[]>([]);
  const [editing, setEditing] = useState<Task | "new" | null>(null);
  const [history, setHistory] = useState<Task | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [t, e] = await Promise.all([api<Task[]>("/api/tasks"), api<EndpointLite[]>("/api/endpoints")]);
    if (t.ok) setTasks(t.data as unknown as Task[]);
    else setError(t.data.error ?? "Could not load tasks");
    if (e.ok) setEndpoints(e.data as unknown as EndpointLite[]);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function runNow(t: Task) {
    setBusy(t.id);
    setError("");
    const res = await api<TaskRun>(`/api/tasks/${t.id}`, { method: "POST" });
    setBusy("");
    if (!res.ok) setError(res.data.error ?? "Could not run the task");
    await load();
    setHistory({ ...t });
  }

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Scheduled tasks"
        subtitle="Commands on a cron schedule: run inside a running container, or in a one-off container"
        actions={<Button onClick={() => setEditing("new")} disabled={!endpoints.length}><Plus className="w-4 h-4" /> New task</Button>}
      />
      <ErrorText>{error}</ErrorText>
      <Card className="overflow-hidden mt-2">
        {tasks.length === 0 ? (
          <div className="p-10 text-center">
            <CalendarClock className="w-10 h-10 text-text-muted mx-auto mb-3" />
            <p className="text-text-primary font-medium mb-1">No scheduled tasks yet</p>
            <p className="text-sm text-text-muted max-w-md mx-auto">For example: clear a cache nightly inside the app container, or run a report in a one-off container.</p>
            {endpoints.length > 0 && <Button className="mt-5" onClick={() => setEditing("new")}><Plus className="w-4 h-4" /> New task</Button>}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {tasks.map((t) => (
              <div key={t.id} className="p-4 flex flex-col md:flex-row md:items-start justify-between gap-3 md:gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary flex items-center gap-2">
                    {t.name}
                    {!t.enabled && <Badge>paused</Badge>}
                    {t.lastStatus && <Badge tone={t.lastStatus === "success" ? "success" : "danger"}>{t.lastStatus === "success" ? "last run OK" : "last run failed"}</Badge>}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {t.endpointName} · {t.mode === "exec" ? `exec in ${t.container}` : `one-off ${t.image}`} · <span className="font-mono">{t.schedule}</span>
                  </p>
                  <p className="text-xs font-mono text-text-secondary mt-1 truncate max-w-2xl">{t.command}</p>
                  <p className="text-xs text-text-muted mt-1">Last run {timeAgo(t.lastRunAt)}{t.enabled && t.nextRunAt ? ` · next ${formatTime(t.nextRunAt)}` : ""}</p>
                </div>
                <div className="flex flex-wrap gap-1 flex-shrink-0">
                  <Button variant="secondary" loading={busy === t.id} onClick={() => runNow(t)}><Play className="w-4 h-4" /> Run now</Button>
                  <Button variant="ghost" onClick={() => setHistory(t)}>History</Button>
                  <IconButton label="Edit" onClick={() => setEditing(t)}><Pencil className="w-4 h-4" /></IconButton>
                  <IconButton
                    label="Remove"
                    onClick={async () => {
                      if (!(await confirm({ title: `Remove task ${t.name}?`, confirmLabel: "Remove" }))) return;
                      await api(`/api/tasks/${t.id}`, { method: "DELETE" });
                      load();
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {editing && (
        <Modal icon={CalendarClock} title={editing === "new" ? "New scheduled task" : `Edit ${editing.name}`} onClose={() => setEditing(null)} wide>
          <TaskForm api={api} existing={editing === "new" ? undefined : editing} endpoints={endpoints} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        </Modal>
      )}
      {history && <HistoryModal api={api} task={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function TaskForm({ api, existing, endpoints, onSaved, onCancel }: { api: Api; existing?: Task; endpoints: EndpointLite[]; onSaved: () => void; onCancel: () => void }) {
  const [f, setF] = useState({
    name: existing?.name ?? "",
    endpointId: existing?.endpointId ?? endpoints[0]?.id ?? "",
    schedule: existing?.schedule ?? "0 4 * * *",
    mode: existing?.mode ?? "exec",
    container: existing?.container ?? "",
    image: existing?.image ?? "alpine:3.20",
    command: existing?.command ?? "",
    env: existing?.env ?? "",
    timeoutSec: existing?.timeoutSec ?? 3600,
    enabled: existing?.enabled ?? true,
  });
  const [containers, setContainers] = useState<{ name: string; state: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!f.endpointId) return;
    api<{ name: string; state: string }[]>(`/api/endpoints/${f.endpointId}/containers`).then((r) => setContainers(r.ok ? (r.data as unknown as { name: string; state: string }[]) : []));
  }, [api, f.endpointId]);

  async function save() {
    setBusy(true);
    setError("");
    const res = await api(existing ? `/api/tasks/${existing.id}` : "/api/tasks", { method: existing ? "PATCH" : "POST", body: f });
    setBusy(false);
    if (res.ok) onSaved();
    else setError(res.data.error ?? "Could not save");
  }

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="clear cache" /></Field>
        <Field label="Endpoint">
          <Select value={f.endpointId} disabled={!!existing} onChange={(e) => setF({ ...f, endpointId: e.target.value })}>
            {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Schedule" hint="Cron: minute hour day month weekday"><Input value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} className="font-mono" /></Field>
        <Field label="Timeout (seconds)"><Input type="number" value={f.timeoutSec} onChange={(e) => setF({ ...f, timeoutSec: Number(e.target.value) })} /></Field>
      </div>
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={f.mode === "exec"} onChange={() => setF({ ...f, mode: "exec" })} /> Exec in a running container</label>
        <label className="flex items-center gap-2"><input type="radio" checked={f.mode === "run"} onChange={() => setF({ ...f, mode: "run" })} /> One-off container</label>
      </div>
      {f.mode === "exec" ? (
        <Field label="Container">
          <Select value={f.container} onChange={(e) => setF({ ...f, container: e.target.value })}>
            <option value="">Choose…</option>
            {containers.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.state})</option>)}
          </Select>
        </Field>
      ) : (
        <>
          <Field label="Image"><Input value={f.image} onChange={(e) => setF({ ...f, image: e.target.value })} className="font-mono" /></Field>
          <Field label="Environment" hint="KEY=value, one per line"><TextArea rows={3} value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })} /></Field>
        </>
      )}
      <Field label="Command" hint="Run with sh -c"><TextArea rows={3} value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="php artisan cache:clear" /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" role="switch" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Run on schedule</label>
      <ErrorText>{error}</ErrorText>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button loading={busy} onClick={save}>{existing ? "Save" : "Create task"}</Button>
      </div>
    </div>
  );
}

function HistoryModal({ api, task, onClose }: { api: Api; task: Task; onClose: () => void }) {
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const res = await api<{ runs: TaskRun[]; running: boolean }>(`/api/tasks/${task.id}`);
      if (stop || !res.ok) return;
      const d = res.data as { runs: TaskRun[]; running: boolean };
      setRuns(d.runs);
      setOpen((o) => o ?? d.runs[0]?.id ?? null);
      if (d.running) setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stop = true;
    };
  }, [api, task.id]);
  return (
    <Modal icon={History} title={`${task.name}: recent runs`} onClose={onClose} wide>
      {!runs ? (
        <div className="space-y-2" aria-busy="true"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
      ) : runs.length === 0 ? (
        <p className="text-sm text-text-muted">It hasn&apos;t run yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => (
            <div key={r.id} className="border border-border rounded-lg">
              <button className="w-full flex items-center justify-between px-3 py-2 text-sm" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <span>{formatTime(r.startedAt)} <span className="text-text-muted text-xs">{r.trigger}</span></span>
                <Badge tone={r.status === "success" ? "success" : r.status === "failed" ? "danger" : "accent"}>{r.status}{r.exitCode !== null ? ` (${r.exitCode})` : ""}</Badge>
              </button>
              {open === r.id && <pre className="border-t border-border bg-bg-primary p-3 text-xs font-mono text-text-secondary whitespace-pre-wrap max-h-80 overflow-y-auto">{r.log || "(no output)"}</pre>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
