"use client";

import { useCallback, useEffect, useState } from "react";
import { clsx } from "clsx";
import { Activity, ExternalLink, HeartPulse, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, EmptyState, ErrorText, Field, IconButton, Input, Modal, PageHeader, PageSkeleton, Select, Tabs, formatTime, timeAgo } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";
import { DayBars } from "@/components/Uptime";

interface Day { day: string; total: number; up: number; avgLatencyMs: number | null }
interface Check {
  id: string;
  name: string;
  type: "http" | "tcp";
  target: string;
  intervalSec: number;
  timeoutMs: number;
  expectStatus: string;
  keyword: string;
  failThreshold: number;
  certWarnDays: number;
  enabled: boolean;
  public: boolean;
  status: string;
  lastCheckedAt: string | null;
  lastChangeAt: string | null;
  lastLatencyMs: number | null;
  lastError: string;
  certExpiresAt: string | null;
  series: Day[];
  uptime7d: number | null;
  uptime30d: number | null;
  uptime90d: number | null;
}
interface Detail extends Check {
  results: { at: string; ok: boolean; latencyMs: number | null; statusCode: number | null; error: string }[];
  incidents: { id: string; startedAt: string; endedAt: string | null; error: string }[];
  stats: { checks: number; uptime: number | null; avgLatencyMs: number | null; p95LatencyMs: number | null };
}
type Form = { id?: string; name: string; type: "http" | "tcp"; target: string; intervalSec: string; timeoutMs: string; expectStatus: string; keyword: string; failThreshold: string; certWarnDays: string; public: boolean; enabled: boolean };

const emptyForm: Form = { name: "", type: "http", target: "", intervalSec: "60", timeoutMs: "10000", expectStatus: "", keyword: "", failThreshold: "2", certWarnDays: "14", public: false, enabled: true };
const RANGES = [{ value: "1h", label: "1 hour" }, { value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "14d", label: "14 days" }] as const;

function pct(v: number | null) {
  return v === null ? "–" : `${v.toFixed(v === 100 ? 0 : 2)}%`;
}
function statusTone(s: string, enabled: boolean): "success" | "danger" | "muted" | "warning" {
  if (!enabled) return "muted";
  return s === "up" ? "success" : s === "down" ? "danger" : "warning";
}
function LatencyChart({ results }: { results: Detail["results"] }) {
  const w = 600;
  const h = 120;
  if (results.length < 2) return <p className="text-xs text-text-muted">Not enough results yet.</p>;
  const t0 = new Date(results[0].at).getTime();
  const t1 = new Date(results[results.length - 1].at).getTime() || t0 + 1;
  const max = Math.max(50, ...results.map((r) => r.latencyMs ?? 0)) * 1.1;
  const x = (at: string) => ((new Date(at).getTime() - t0) / Math.max(1, t1 - t0)) * w;
  const ok = results.filter((r) => r.ok && r.latencyMs !== null);
  const pts = ok.map((r) => `${x(r.at).toFixed(1)},${(h - ((r.latencyMs as number) / max) * h).toFixed(1)}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-32" preserveAspectRatio="none" role="img" aria-label="Response time">
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="currentColor" className="text-border" strokeDasharray="2 4" />)}
        {results.filter((r) => !r.ok).map((r) => <line key={r.at} x1={x(r.at)} x2={x(r.at)} y1="0" y2={h} stroke="var(--dn-danger, #ef4444)" strokeOpacity="0.5" vectorEffect="non-scaling-stroke" />)}
        <polyline points={pts} fill="none" stroke="var(--dn-accent, #6366f1)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[11px] text-text-muted mt-1">
        <span>{formatTime(results[0].at)}</span>
        <span>max {Math.round(max / 1.1)} ms</span>
        <span>{formatTime(results[results.length - 1].at)}</span>
      </div>
    </div>
  );
}

export default function UptimePage() {
  const api = useApi();
  const confirm = useConfirm();
  const toast = useToast();
  const [data, setData] = useState<{ checks: Check[]; statusPage: { enabled: boolean; title: string } } | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]["value"]>("24h");
  const [domains, setDomains] = useState<{ host: string; https: boolean; app: string }[]>([]);

  const load = useCallback(async () => {
    const r = await api<{ checks: Check[]; statusPage: { enabled: boolean; title: string } }>("/api/uptime");
    if (r.ok) setData(r.data as unknown as { checks: Check[]; statusPage: { enabled: boolean; title: string } });
    else setError(r.data.error ?? "Couldn't load the checks");
  }, [api]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    fetch("/api/account").then((r) => (r.ok ? r.json() : null)).then((me) => setCanManage(me?.role === "admin" || me?.role === "owner")).catch(() => {});
    api<{ environments: { apps: { name: string; domains: { host: string; https: boolean; redirectTo?: string }[] }[] }[] }[]>("/api/projects").then((r) => {
      if (!r.ok || !Array.isArray(r.data)) return;
      const list: { host: string; https: boolean; app: string }[] = [];
      for (const p of r.data as unknown as { environments?: { apps?: { name: string; domains?: { host: string; https: boolean }[] }[] }[] }[]) for (const e of p.environments ?? []) for (const a of e.apps ?? []) for (const d of a.domains ?? []) list.push({ host: d.host, https: d.https, app: a.name });
      setDomains(list);
    });
    return () => clearInterval(t);
  }, [load, api]);

  useEffect(() => {
    if (!open) return setDetail(null);
    api<Detail>(`/api/uptime/${open}?range=${range}`).then((r) => r.ok && setDetail(r.data as unknown as Detail));
  }, [open, range, api, data]);

  const save = async () => {
    if (!form) return;
    setBusy("save");
    setFormError("");
    const body = { ...form, intervalSec: Number(form.intervalSec), timeoutMs: Number(form.timeoutMs), failThreshold: Number(form.failThreshold), certWarnDays: Number(form.certWarnDays) };
    const r = form.id ? await api(`/api/uptime/${form.id}`, { method: "PATCH", body }) : await api("/api/uptime", { method: "POST", body });
    setBusy("");
    if (!r.ok) return setFormError(r.data.error ?? "Couldn't save");
    setForm(null);
    load();
  };
  const remove = async (c: Check) => {
    if (!(await confirm({ title: `Remove ${c.name}?`, message: "Its response times and incidents are deleted too.", confirmLabel: "Remove check" }))) return;
    const r = await api(`/api/uptime/${c.id}`, { method: "DELETE" });
    if (!r.ok) return toast.error(r.data.error ?? "Couldn't remove");
    if (open === c.id) setOpen(null);
    load();
  };
  const runNow = async (c: Check) => {
    setBusy(c.id);
    const r = await api<Check>(`/api/uptime/${c.id}/run`, { method: "POST" });
    setBusy("");
    if (!r.ok) return toast.error(r.data.error ?? "Couldn't run the check");
    const res = r.data as unknown as Check;
    if (res.lastError) toast.error(`${c.name}: ${res.lastError}`);
    else toast.success(`${c.name} answered in ${res.lastLatencyMs} ms`);
    load();
  };
  const statusPage = async (patch: { enabled?: boolean; title?: string }) => {
    const r = await api("/api/uptime/status-page", { method: "PATCH", body: patch });
    if (!r.ok) return toast.error(r.data.error ?? "Couldn't save");
    load();
  };

  if (!data) return error ? <div className="max-w-6xl"><ErrorText>{error}</ErrorText></div> : <PageSkeleton />;
  const unmonitored = domains.filter((d) => !data.checks.some((c) => c.target.includes(`//${d.host}`)));
  const down = data.checks.filter((c) => c.enabled && c.status === "down").length;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Uptime"
        subtitle={data.checks.length ? (down ? `${down} of ${data.checks.length} checks down` : `All ${data.checks.length} checks up`) : "HTTP(S) and TCP checks from this DeployNow, with alerts and a public status page"}
        actions={canManage && <Button onClick={() => { setFormError(""); setForm({ ...emptyForm }); }}><Plus className="w-4 h-4" /> Add check</Button>}
      />

      {data.checks.length === 0 ? (
        <Card>
          <EmptyState icon={HeartPulse} title="No uptime checks yet">
            DeployNow requests each URL on an interval, keeps the response times, and alerts your notification channels when it stops answering and when it is back.
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {data.checks.map((c, i) => (
            <div key={c.id} className={clsx(i && "border-t border-border")}>
              <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)} className="w-full text-left px-4 py-3 hover:bg-bg-secondary grid grid-cols-1 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] gap-x-6 gap-y-2 items-center">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={clsx("w-2.5 h-2.5 rounded-full flex-shrink-0", !c.enabled ? "bg-text-muted" : c.status === "up" ? "bg-success" : c.status === "down" ? "bg-danger animate-pulse" : "bg-warning")} />
                    <span className="font-medium text-text-primary truncate">{c.name}</span>
                    <Badge tone={statusTone(c.status, c.enabled)}>{c.enabled ? c.status : "paused"}</Badge>
                    {c.public && <Badge tone="muted">public</Badge>}
                  </div>
                  <p className="text-xs text-text-muted font-mono truncate mt-0.5">{c.type.toUpperCase()} · {c.target}</p>
                  {c.enabled && c.status === "down" && c.lastError && <p className="text-xs text-danger mt-0.5 truncate">{c.lastError}{c.lastChangeAt ? ` · since ${timeAgo(c.lastChangeAt)}` : ""}</p>}
                </div>
                <DayBars days={c.series.slice(-30)} />
                <div className="flex md:block gap-3 text-xs text-text-muted md:text-right md:w-40">
                  <p><span className="text-text-primary font-medium">{pct(c.uptime30d)}</span> 30 days</p>
                  <p>{c.lastLatencyMs !== null && c.status === "up" ? `${c.lastLatencyMs} ms` : "–"} · {c.lastCheckedAt ? timeAgo(c.lastCheckedAt) : "not run yet"}</p>
                </div>
              </button>

              {open === c.id && (
                <div className="px-4 pb-4 pt-1 border-t border-border bg-bg-secondary/40">
                  <div className="flex flex-wrap items-center justify-between gap-3 my-3">
                    <Tabs tabs={RANGES} value={range} onChange={setRange} />
                    {canManage && (
                      <div className="flex gap-1">
                        <Button variant="secondary" onClick={() => runNow(c)} loading={busy === c.id}>{busy !== c.id && <Play className="w-4 h-4" />} Check now</Button>
                        <IconButton label="Edit" onClick={() => { setFormError(""); setForm({ id: c.id, name: c.name, type: c.type, target: c.target, intervalSec: String(c.intervalSec), timeoutMs: String(c.timeoutMs), expectStatus: c.expectStatus, keyword: c.keyword, failThreshold: String(c.failThreshold), certWarnDays: String(c.certWarnDays), public: c.public, enabled: c.enabled }); }}><Pencil className="w-4 h-4" /></IconButton>
                        <IconButton label="Remove" variant="danger" onClick={() => remove(c)}><Trash2 className="w-4 h-4" /></IconButton>
                      </div>
                    )}
                  </div>
                  {!detail || detail.id !== c.id ? (
                    <p className="text-xs text-text-muted">Loading…</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-4 text-sm">
                        {[
                          ["Uptime", pct(detail.stats.uptime)],
                          ["Average", detail.stats.avgLatencyMs !== null ? `${detail.stats.avgLatencyMs} ms` : "–"],
                          ["95th percentile", detail.stats.p95LatencyMs !== null ? `${detail.stats.p95LatencyMs} ms` : "–"],
                          ["7 / 90 days", `${pct(c.uptime7d)} / ${pct(c.uptime90d)}`],
                          ["Certificate", detail.certExpiresAt ? `until ${new Date(detail.certExpiresAt).toLocaleDateString()}` : "–"],
                        ].map(([k, v]) => (
                          <div key={k}><p className="text-xs text-text-muted">{k}</p><p className="text-text-primary font-medium">{v}</p></div>
                        ))}
                      </div>
                      <LatencyChart results={detail.results} />
                      <div className="mt-4">
                        <p className="text-xs text-text-muted mb-1">Last 90 days</p>
                        <DayBars days={c.series} />
                      </div>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted mt-5 mb-2">Incidents</h3>
                      {detail.incidents.length === 0 ? (
                        <p className="text-xs text-text-muted">No downtime recorded.</p>
                      ) : (
                        <ul className="text-xs space-y-1">
                          {detail.incidents.map((i) => (
                            <li key={i.id} className="flex flex-wrap gap-x-3">
                              <span className={i.endedAt ? "text-text-secondary" : "text-danger font-medium"}>{formatTime(i.startedAt)}</span>
                              <span className="text-text-muted">{i.endedAt ? `down ${Math.max(1, Math.round((new Date(i.endedAt).getTime() - new Date(i.startedAt).getTime()) / 60000))} min` : "ongoing"}</span>
                              <span className="text-text-muted truncate">{i.error}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </Card>
      )}

      {canManage && unmonitored.length > 0 && (
        <Card className="p-4 mt-6">
          <h2 className="text-sm font-semibold text-text-primary mb-1">App domains without a check</h2>
          <p className="text-xs text-text-muted mb-3">Add a check for each one in a click.</p>
          <div className="flex flex-wrap gap-2">
            {unmonitored.slice(0, 20).map((d) => (
              <Button key={d.host} variant="secondary" onClick={() => { setFormError(""); setForm({ ...emptyForm, name: d.app === d.host ? d.host : `${d.app} (${d.host})`, target: `${d.https ? "https" : "http"}://${d.host}/` }); }}>
                <Plus className="w-4 h-4" /> {d.host}
              </Button>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4 mt-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-text-primary">Public status page</h2>
            <p className="text-xs text-text-muted">Shows the checks marked public, with their names and uptime only (never the URLs), at <code>/status</code>.</p>
          </div>
          {data.statusPage.enabled && (
            <a href="/status" target="_blank" rel="noreferrer" className="text-xs text-accent hover:underline inline-flex items-center gap-1">Open <ExternalLink className="w-3 h-3" /></a>
          )}
          {canManage && (
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input type="checkbox" role="switch" checked={data.statusPage.enabled} onChange={(e) => statusPage({ enabled: e.target.checked })} /> On
            </label>
          )}
        </div>
        {canManage && data.statusPage.enabled && (
          <div className="mt-3 max-w-sm">
            <Field label="Title">
              <Input defaultValue={data.statusPage.title} placeholder="Status" onBlur={(e) => e.target.value !== data.statusPage.title && statusPage({ title: e.target.value })} />
            </Field>
          </div>
        )}
      </Card>

      {form && (
        <Modal icon={Activity}
          title={form.id ? "Edit check" : "Add uptime check"}
          wide
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button onClick={save} loading={busy === "save"} disabled={!form.name.trim() || !form.target.trim()}>Save</Button>
            </>
          }
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Shop" autoFocus /></Field>
            <Field label="Type">
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as Form["type"] })}>
                <option value="http">HTTP(S): request a URL</option>
                <option value="tcp">TCP: open a port</option>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label={form.type === "http" ? "URL" : "Host and port"}>
                <Input value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder={form.type === "http" ? "https://shop.example.com/health" : "db.example.com:5432"} />
              </Field>
            </div>
            <Field label="Check every">
              <Select value={form.intervalSec} onChange={(e) => setForm({ ...form, intervalSec: e.target.value })}>
                {[["30", "30 seconds"], ["60", "minute"], ["120", "2 minutes"], ["300", "5 minutes"], ["900", "15 minutes"], ["3600", "hour"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Down after" hint="Failed checks in a row before it alerts">
              <Select value={form.failThreshold} onChange={(e) => setForm({ ...form, failThreshold: e.target.value })}>
                {["1", "2", "3", "5"].map((v) => <option key={v} value={v}>{v} failed check{v === "1" ? "" : "s"}</option>)}
              </Select>
            </Field>
            <Field label="Timeout (ms)"><Input type="number" min={1000} max={60000} value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: e.target.value })} /></Field>
            {form.type === "http" && (
              <>
                <Field label="Expected status" hint="Empty: any 2xx or 3xx"><Input value={form.expectStatus} onChange={(e) => setForm({ ...form, expectStatus: e.target.value })} placeholder="200" /></Field>
                <Field label="Page must contain" hint="Optional text, e.g. a word from the page footer"><Input value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} /></Field>
                <Field label="Warn before the certificate expires">
                  <Select value={form.certWarnDays} onChange={(e) => setForm({ ...form, certWarnDays: e.target.value })}>
                    {[["0", "Off"], ["7", "7 days"], ["14", "14 days"], ["21", "21 days"], ["30", "30 days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </Select>
                </Field>
              </>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-4 text-sm text-text-secondary">
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.public} onChange={(e) => setForm({ ...form, public: e.target.checked })} /> Show on the status page</label>
            <label className="flex items-center gap-2"><input type="checkbox" role="switch" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Active</label>
          </div>
          <p className="mt-3 text-xs text-text-muted">Alerts go to the notification channels that subscribe to the uptime events (Settings → Notifications).</p>
          <div className="mt-3"><ErrorText>{formError}</ErrorText></div>
        </Modal>
      )}
    </div>
  );
}
