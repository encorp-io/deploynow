"use client";
import clsx from "clsx";

import { useState } from "react";
import { Eye, Lock, Plus, Trash2, Vault } from "lucide-react";
import { Button, Field, IconButton, Input, Select, TextArea } from "./ui";


export function appStatusTone(status: string): "success" | "warning" | "danger" | "accent" | "muted" {
  if (status === "running" || status === "success") return "success";
  if (status === "deploying" || status === "running-deploy" || status === "queued") return "accent";
  if (status === "failed") return "danger";
  if (status === "cancelled" || status === "stopped") return "warning";
  return "muted";
}

export const SOURCE_LABELS: Record<string, string> = {
  image: "Image (GHCR or Docker Hub)",
  "git-dockerfile": "Dockerfile from Git",
  "git-compose": "docker-compose from Git",
  compose: "docker-compose file",
};

const SOURCE_HINTS: Record<string, string> = {
  image: "Run a ready-made image from a registry",
  "git-dockerfile": "Build from a repository with a Dockerfile",
  "git-compose": "Run the compose file in a repository",
  compose: "Paste a compose file here",
};

export interface PortRow { host: number | null; container: number; protocol: "tcp" | "udp" }
export interface VolumeRow { name: string; path: string }

export interface AppFormValue {
  name: string;
  slug: string;
  sourceType: string;
  image: string;
  gitRepo: string;
  gitBranch: string;
  buildContext: string;
  dockerfilePath: string;
  composePath: string;
  composeInline: string;
  ports: PortRow[];
  volumes: VolumeRow[];
  command: string;
  restartPolicy: string;
  updatePolicy: string;
  endpointId: string;
}

export const emptyApp: AppFormValue = {
  name: "",
  slug: "",
  sourceType: "image",
  image: "",
  gitRepo: "",
  gitBranch: "main",
  buildContext: ".",
  dockerfilePath: "Dockerfile",
  composePath: "docker-compose.yml",
  composeInline: "",
  ports: [],
  volumes: [],
  command: "",
  restartPolicy: "unless-stopped",
  updatePolicy: "manual",
  endpointId: "",
};

export function slugify(name: string) {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42).replace(/-+$/, "");
}

/** Source and runtime settings of an app; used by "New app" and the Settings tab. */
export function AppForm({
  value,
  onChange,
  endpoints,
  isNew,
}: {
  value: AppFormValue;
  onChange: (v: AppFormValue) => void;
  endpoints: { id: string; name: string }[];
  isNew: boolean;
}) {
  const set = <K extends keyof AppFormValue>(k: K, v: AppFormValue[K]) => onChange({ ...value, [k]: v });
  const isGit = value.sourceType === "git-dockerfile" || value.sourceType === "git-compose";
  const isCompose = value.sourceType === "git-compose" || value.sourceType === "compose";
  const policies =
    value.sourceType === "image"
      ? [["manual", "Deploy by hand"], ["auto-digest", "Redeploy when the image tag gets a new digest"]]
      : isGit
        ? [["manual", "Deploy by hand"], ["on-push", "Deploy on every push to the branch (GitHub webhook)"]]
        : [["manual", "Deploy by hand"]];

  return (
    <div className="space-y-4">
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value, ...(isNew ? { slug: slugify(e.target.value) } : {}) })}
            placeholder="api"
          />
        </Field>
        <Field label="Docker name" hint={isNew ? "Containers, volumes and the compose project use it" : "Fixed after creation"}>
          <Input value={value.slug} onChange={(e) => set("slug", e.target.value)} disabled={!isNew} className="font-mono" />
        </Field>
      </div>

      <Field label="Endpoint">
        <Select value={value.endpointId} onChange={(e) => set("endpointId", e.target.value)} disabled={!isNew}>
          {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </Select>
      </Field>

      <Field label="Source">
        <div className="grid sm:grid-cols-2 gap-2">
          {Object.entries(SOURCE_LABELS).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => onChange({ ...value, sourceType: k, updatePolicy: "manual", ...(k === "git-compose" || k === "compose" ? { ports: [], volumes: [] } : {}) })}
              aria-pressed={value.sourceType === k}
              className={`text-left px-3 py-2 rounded-lg border text-sm ${value.sourceType === k ? "border-accent bg-accent/10 text-text-primary" : "border-border text-text-secondary hover:border-border-bright"}`}
            >
              <span className="block font-medium">{label}</span>
              <span className="block text-xs text-text-muted mt-0.5">{SOURCE_HINTS[k]}</span>
            </button>
          ))}
        </div>
      </Field>

      {value.sourceType === "image" && (
        <Field label="Image" hint="Private images pull with a matching registry login (yours or a service account); pick a specific one on the app's Settings tab">
          <Input value={value.image} onChange={(e) => set("image", e.target.value)} placeholder="ghcr.io/encorp-io/app:latest" className="font-mono" />
        </Field>
      )}

      {isGit && (
        <>
          <div className="grid sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <Field label="Repository" hint="https URL; private repos use the GitHub token from Settings">
                <Input value={value.gitRepo} onChange={(e) => set("gitRepo", e.target.value)} placeholder="https://github.com/encorp-io/app" className="font-mono" />
              </Field>
            </div>
            <Field label="Branch"><Input value={value.gitBranch} onChange={(e) => set("gitBranch", e.target.value)} className="font-mono" /></Field>
          </div>
          {value.sourceType === "git-dockerfile" ? (
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Build context"><Input value={value.buildContext} onChange={(e) => set("buildContext", e.target.value)} className="font-mono" /></Field>
              <Field label="Dockerfile"><Input value={value.dockerfilePath} onChange={(e) => set("dockerfilePath", e.target.value)} className="font-mono" /></Field>
            </div>
          ) : (
            <Field label="Compose file"><Input value={value.composePath} onChange={(e) => set("composePath", e.target.value)} className="font-mono" /></Field>
          )}
        </>
      )}

      {value.sourceType === "compose" && (
        <Field label="docker-compose.yml" hint="Use ${VAR} for values from the Environment tab, e.g. POSTGRES_PASSWORD: ${DB_PASSWORD}">
          <TextArea rows={12} value={value.composeInline} onChange={(e) => set("composeInline", e.target.value)} placeholder={"services:\n  web:\n    image: nginx:alpine"} />
        </Field>
      )}

      {!isCompose && (
        <>
          <Field label="Ports published on the host" hint="Leave empty for apps behind a domain. Published ports mean the old container stops before the new one starts.">
            <div className="space-y-2">
              {value.ports.map((p, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input type="number" placeholder="host" value={p.host ?? ""} onChange={(e) => set("ports", value.ports.map((q, j) => (j === i ? { ...q, host: e.target.value ? Number(e.target.value) : null } : q)))} />
                  <span className="text-text-muted">→</span>
                  <Input type="number" placeholder="container" value={p.container || ""} onChange={(e) => set("ports", value.ports.map((q, j) => (j === i ? { ...q, container: Number(e.target.value) } : q)))} />
                  <Select value={p.protocol} onChange={(e) => set("ports", value.ports.map((q, j) => (j === i ? { ...q, protocol: e.target.value as "tcp" | "udp" } : q)))} className="w-24 flex-shrink-0">
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                  </Select>
                  <IconButton label="Remove port" onClick={() => set("ports", value.ports.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></IconButton>
                </div>
              ))}
              <Button variant="secondary" onClick={() => set("ports", [...value.ports, { host: null, container: 0, protocol: "tcp" }])}><Plus className="w-4 h-4" /> Port</Button>
            </div>
          </Field>
          <Field label="Volumes" hint="Named volumes, kept across deployments">
            <div className="space-y-2">
              {value.volumes.map((v, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input placeholder="data" value={v.name} onChange={(e) => set("volumes", value.volumes.map((q, j) => (j === i ? { ...q, name: e.target.value } : q)))} className="font-mono" />
                  <span className="text-text-muted">→</span>
                  <Input placeholder="/var/lib/app" value={v.path} onChange={(e) => set("volumes", value.volumes.map((q, j) => (j === i ? { ...q, path: e.target.value } : q)))} className="font-mono" />
                  <IconButton label="Remove volume" onClick={() => set("volumes", value.volumes.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></IconButton>
                </div>
              ))}
              <Button variant="secondary" onClick={() => set("volumes", [...value.volumes, { name: "", path: "" }])}><Plus className="w-4 h-4" /> Volume</Button>
            </div>
          </Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Command (optional)" hint="Overrides the image's CMD">
              <Input value={value.command} onChange={(e) => set("command", e.target.value)} className="font-mono" />
            </Field>
            <Field label="Restart policy">
              <Select value={value.restartPolicy} onChange={(e) => set("restartPolicy", e.target.value)}>
                {["unless-stopped", "always", "on-failure", "no"].map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
          </div>
        </>
      )}

      <Field label="Updates">
        <Select value={value.updatePolicy} onChange={(e) => set("updatePolicy", e.target.value)}>
          {policies.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </Select>
      </Field>
    </div>
  );
}

export interface EnvRow {
  key: string;
  kind: "plain" | "secret" | "vault";
  value: string | null;
  hasValue?: boolean;
}

const KIND_HINT: Record<EnvRow["kind"], string> = {
  plain: "Shown as typed",
  secret: "Encrypted, never shown again, masked in logs",
  vault: "Vault reference: mount/path#field",
};

/** Portainer-style env var editor: plain, secret (write-only) or a Vault reference. */
export function EnvEditor({ rows, onChange, onReveal, canReveal }: { rows: EnvRow[]; onChange: (r: EnvRow[]) => void; onReveal?: (key: string) => void; canReveal?: boolean }) {
  const [bulk, setBulk] = useState(false);
  const [text, setText] = useState("");
  const update = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const applyBulk = () => {
    const next = [...rows];
    for (const line of text.split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
      const at = next.findIndex((r) => r.key === m[1]);
      const row: EnvRow = { key: m[1], kind: at >= 0 ? next[at].kind : "plain", value };
      if (at >= 0) next[at] = row;
      else next.push(row);
    }
    onChange(next);
    setText("");
    setBulk(false);
  };

  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,12rem)_6.5rem_minmax(0,1fr)_auto] gap-2 items-start">
          <Input value={r.key} onChange={(e) => update(i, { key: e.target.value })} placeholder="NAME" className="font-mono" />
          <Select
            value={r.kind}
            onChange={(e) => update(i, { kind: e.target.value as EnvRow["kind"], value: r.kind === "secret" ? "" : r.value, hasValue: false })}
            title={KIND_HINT[r.kind]}
          >
            <option value="plain">plain</option>
            <option value="secret">secret</option>
            <option value="vault">vault</option>
          </Select>
          <div className="relative min-w-0">
            <Input
              type={r.kind === "secret" ? "password" : "text"}
              value={r.value ?? ""}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={r.kind === "secret" ? (r.hasValue ? "•••••••• (saved; type to replace)" : "value") : r.kind === "vault" ? "secret/myapp#DB_PASSWORD" : "value"}
              className={clsx("font-mono", r.kind !== "plain" && "pl-8")}
              autoComplete="off"
            />
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted">
              {r.kind === "secret" ? <Lock className="w-3.5 h-3.5" /> : r.kind === "vault" ? <Vault className="w-3.5 h-3.5" /> : null}
            </span>
          </div>
          <div className="flex">
            {r.kind === "secret" && r.hasValue && canReveal && onReveal && (
              <IconButton label="Reveal (asks for your 2FA code)" onClick={() => onReveal(r.key)}><Eye className="w-4 h-4" /></IconButton>
            )}
            <IconButton label={`Remove ${r.key || "variable"}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 className="w-4 h-4" /></IconButton>
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => onChange([...rows, { key: "", kind: "plain", value: "" }])}><Plus className="w-4 h-4" /> Variable</Button>
        <Button variant="ghost" onClick={() => setBulk(!bulk)}>Paste .env</Button>
      </div>
      {bulk && (
        <div className="space-y-2">
          <TextArea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={"DATABASE_URL=postgres://…\nLOG_LEVEL=info"} />
          <Button onClick={applyBulk}>Add</Button>
        </div>
      )}
    </div>
  );
}
