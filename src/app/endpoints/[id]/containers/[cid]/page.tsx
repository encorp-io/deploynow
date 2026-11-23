"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Play, Square, RotateCw, Trash2, Pause } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, IconButton, PageHeader, PageSkeleton, Tabs, formatBytes, stateTone, timeAgo } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";

const ContainerConsole = dynamic(() => import("@/components/ContainerConsole"), { ssr: false });

interface Detail {
  id: string;
  name: string;
  image: string;
  imageId: string;
  created: string;
  state: { status: string; running: boolean; startedAt: string; exitCode: number; health: string | null; restartCount: number };
  cmd: string;
  restartPolicy: string;
  env: { key: string; value: string | null }[];
  envHidden: boolean;
  ports: { container: string; host: string[] }[];
  mounts: { type: string; source: string; destination: string; readOnly: boolean }[];
  networks: { name: string; ip: string; aliases: string[] }[];
  labels: Record<string, string>;
}

interface Stats {
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRx: number;
  networkTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
}

type Tab = "overview" | "logs" | "console";

function Logs({ endpointId, containerId }: { endpointId: string; containerId: string }) {
  const [lines, setLines] = useState<{ s: string; t: string }[]>([]);
  const [follow, setFollow] = useState(true);
  const [tail, setTail] = useState(300);
  const [error, setError] = useState("");
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLines([]);
    setError("");
    const url = `/api/endpoints/${endpointId}/containers/${containerId}/logs?tail=${tail}&timestamps=1`;
    if (!follow) {
      fetch(url).then(async (r) => {
        const d = await r.json();
        if (r.ok) setLines([{ s: "stdout", t: d.text }]);
        else setError(d.error ?? "Could not read logs");
      });
      return;
    }
    const es = new EventSource(`${url}&follow=1`);
    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as { s: string; t: string };
      setLines((prev) => (prev.length > 5000 ? [...prev.slice(-4000), msg] : [...prev, msg]));
    };
    es.addEventListener("end", () => es.close());
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
  }, [endpointId, containerId, follow, tail]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-text-secondary">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <select value={tail} onChange={(e) => setTail(Number(e.target.value))} className="px-2 py-1 bg-bg-secondary border border-border rounded-md text-text-primary">
          {[100, 300, 1000, 5000].map((n) => <option key={n} value={n}>last {n} lines</option>)}
        </select>
      </div>
      <ErrorText>{error}</ErrorText>
      <pre ref={box} className="h-[480px] overflow-auto bg-bg-primary border border-border rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all">
        {lines.map((l, i) => (
          <span key={i} className={l.s === "stderr" ? "text-danger/90" : "text-text-secondary"}>{l.t}</span>
        ))}
      </pre>
    </div>
  );
}

export default function ContainerPage({ params }: { params: Promise<{ id: string; cid: string }> }) {
  const { id, cid } = use(params);
  const api = useApi();
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const res = await api<Detail>(`/api/endpoints/${id}/containers/${cid}`);
    if (res.ok) setD(res.data as Detail);
    else setError(res.data.error ?? "Container not found");
  }, [api, id, cid]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!d?.state.running || tab !== "overview") return;
    let stop = false;
    const tick = async () => {
      const res = await api<Stats>(`/api/endpoints/${id}/containers/${cid}/stats`);
      if (!stop && res.ok) setStats(res.data as Stats);
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [api, id, cid, d?.state.running, tab]);

  async function action(a: string) {
    setBusy(a);
    const res = await api(`/api/endpoints/${id}/containers/${cid}`, { body: { action: a } });
    setBusy("");
    if (!res.ok) toast.error(res.data.error ?? "Action failed");
    load();
  }

  async function remove() {
    if (!(await confirm({ title: `Remove container ${d?.name}?`, message: "This can't be undone.", confirmLabel: "Remove" }))) return;
    const res = await api(`/api/endpoints/${id}/containers/${cid}`, { method: "DELETE" });
    if (res.ok) {
      toast.success(`Removed ${d?.name}`);
      router.push(`/endpoints/${id}`);
    } else toast.error(res.data.error ?? "Could not remove");
  }

  if (!d) return error ? <ErrorText>{error}</ErrorText> : <PageSkeleton />;

  const kv = "grid grid-cols-[120px_1fr] sm:grid-cols-[160px_1fr] gap-y-2 text-sm [&>*]:min-w-0 [&>*]:break-words";

  return (
    <div className="max-w-6xl">
      <PageHeader
        crumbs={[{ label: "Endpoints", href: "/endpoints" }, { label: "Containers", href: `/endpoints/${id}` }, { label: d.name }]}
        title={d.name}
        subtitle={
          <span className="flex items-center flex-wrap gap-2">
            <Badge tone={stateTone(d.state.status)}>{d.state.status}</Badge>
            {d.state.health && <Badge tone={d.state.health === "healthy" ? "success" : "warning"}>{d.state.health}</Badge>}
            <span className="font-mono text-xs">{d.image}</span>
          </span>
        }
        actions={
          <>
            {d.state.running ? (
              <>
                <Button variant="secondary" loading={busy === "restart"} onClick={() => action("restart")}><RotateCw className="w-4 h-4" /> Restart</Button>
                <IconButton label="Pause" variant="secondary" loading={busy === "pause"} onClick={() => action("pause")}><Pause className="w-4 h-4" /></IconButton>
                <Button variant="secondary" loading={busy === "stop"} onClick={() => action("stop")}><Square className="w-4 h-4" /> Stop</Button>
              </>
            ) : d.state.status === "paused" ? (
              <Button loading={busy === "unpause"} onClick={() => action("unpause")}><Play className="w-4 h-4" /> Resume</Button>
            ) : (
              <Button loading={busy === "start"} onClick={() => action("start")}><Play className="w-4 h-4" /> Start</Button>
            )}
            <IconButton label="Remove container" variant="danger" onClick={remove}><Trash2 className="w-4 h-4" /></IconButton>
          </>
        }
      />
      <ErrorText>{error}</ErrorText>

      <div className="mb-4 mt-2">
        <Tabs tabs={[{ value: "overview", label: "Overview" }, { value: "logs", label: "Logs" }, { value: "console", label: "Console" }]} value={tab} onChange={setTab} />
      </div>

      {tab === "overview" && (
        <div className="space-y-4">
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                ["CPU", `${stats.cpuPercent}%`],
                ["Memory", `${formatBytes(stats.memoryUsage)}${stats.memoryLimit ? ` / ${formatBytes(stats.memoryLimit)}` : ""}`],
                ["Network in / out", `${formatBytes(stats.networkRx)} / ${formatBytes(stats.networkTx)}`],
                ["Processes", String(stats.pids)],
              ].map(([label, value]) => (
                <Card key={label} className="p-4">
                  <p className="text-xs text-text-muted">{label}</p>
                  <p className="text-lg font-semibold text-text-primary mt-1">{value}</p>
                </Card>
              ))}
            </div>
          )}
          <Card className="p-5">
            <div className={kv}>
              <span className="text-text-muted">Container id</span><span className="font-mono text-xs">{d.id.slice(0, 12)}</span>
              <span className="text-text-muted">Created</span><span>{timeAgo(d.created)}</span>
              <span className="text-text-muted">Started</span><span>{d.state.running ? timeAgo(d.state.startedAt) : `exited with code ${d.state.exitCode}`}</span>
              <span className="text-text-muted">Restart policy</span><span>{d.restartPolicy} · restarted {d.state.restartCount} times</span>
              <span className="text-text-muted">Command</span><span className="font-mono text-xs break-all">{d.cmd || "image default"}</span>
              <span className="text-text-muted">Image id</span><span className="font-mono text-xs">{d.imageId.replace("sha256:", "").slice(0, 12)}</span>
            </div>
          </Card>
          <div className="grid md:grid-cols-2 gap-4">
            <Card className="p-5">
              <h3 className="font-semibold text-sm mb-3">Ports</h3>
              {d.ports.length ? d.ports.map((p) => (
                <p key={p.container} className="text-xs font-mono text-text-secondary">{p.container} {p.host.length ? `← ${p.host.join(", ")}` : "(not published)"}</p>
              )) : <p className="text-xs text-text-muted">None</p>}
              <h3 className="font-semibold text-sm mb-3 mt-5">Networks</h3>
              {d.networks.map((n) => (
                <p key={n.name} className="text-xs font-mono text-text-secondary">{n.name} {n.ip}</p>
              ))}
            </Card>
            <Card className="p-5">
              <h3 className="font-semibold text-sm mb-3">Mounts</h3>
              {d.mounts.length ? d.mounts.map((m) => (
                <p key={m.destination} className="text-xs font-mono text-text-secondary break-all">
                  {m.type}: {m.source} → {m.destination}{m.readOnly ? " (read-only)" : ""}
                </p>
              )) : <p className="text-xs text-text-muted">None</p>}
            </Card>
          </div>
          <Card className="p-5">
            <h3 className="font-semibold text-sm mb-3">Environment {d.envHidden && <span className="text-xs text-text-muted font-normal">(values hidden for your role)</span>}</h3>
            <div className="grid grid-cols-[minmax(160px,auto)_1fr] gap-x-4 gap-y-1 text-xs font-mono">
              {d.env.map((e) => (
                <EnvRow key={e.key} name={e.key} value={e.value} />
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab === "logs" && <Logs endpointId={id} containerId={cid} />}
      {tab === "console" && (d.state.running ? <ContainerConsole api={api} endpointId={id} containerId={cid} /> : <p className="text-sm text-text-muted">Start the container to open a console.</p>)}
    </div>
  );
}

function EnvRow({ name, value }: { name: string; value: string | null }) {
  const [show, setShow] = useState(false);
  const sensitive = /pass|secret|token|key|auth|credential|private|dsn|url/i.test(name);
  return (
    <>
      <span className="text-text-secondary">{name}</span>
      <span className="text-text-primary break-all">
        {value === null ? (
          <span className="text-text-muted">hidden</span>
        ) : sensitive && !show ? (
          <button className="text-text-muted hover:text-text-secondary" onClick={() => setShow(true)}>•••••• show</button>
        ) : (
          value
        )}
      </span>
    </>
  );
}
