"use client";

/**
 * Registry logins: shared service accounts (Settings), your own logins
 * (Account), and which login an app pulls with (app settings).
 */
import { useCallback, useEffect, useState } from "react";
import { Boxes, CheckCircle2, Plus, Send, Trash2, UserRound, XCircle } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, IconButton, Input, Select } from "@/components/ui";
import { useConfirm } from "@/components/feedback";

const MASK = "••••••••";

export interface RegistryLogin {
  id: string;
  name: string;
  host: string;
  provider: "dockerhub" | "ghcr" | "other";
  username: string;
  password: string;
  namespace: string;
  ownerType: "shared" | "personal";
  mine: boolean;
  projectId: string | null;
  projectName: string | null;
  canManage: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
}

type Form = Partial<RegistryLogin>;

const PROVIDERS = {
  dockerhub: {
    label: "Docker Hub",
    host: "docker.io",
    user: "Docker ID",
    secret: "Access token",
    help: "Docker Hub → Account settings → Personal access tokens. Read-only is enough to pull; add Write to push builds.",
    namespace: "docker.io/acme",
  },
  ghcr: {
    label: "GitHub (GHCR)",
    host: "ghcr.io",
    user: "GitHub user name",
    secret: "Personal access token",
    help: "GitHub → Settings → Developer settings → Tokens (classic), with read:packages (and write:packages to push builds).",
    namespace: "ghcr.io/acme",
  },
  other: {
    label: "Other registry",
    host: "",
    user: "User name",
    secret: "Password or token",
    help: "Any registry that speaks the Docker Registry v2 API.",
    namespace: "registry.example.com/acme",
  },
} as const;

function TestBadge({ r }: { r: RegistryLogin }) {
  if (r.lastTestOk === null) return null;
  return r.lastTestOk ? (
    <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="w-3 h-3" /> Signed in</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs text-danger"><XCircle className="w-3 h-3" /> Sign-in failed</span>
  );
}

function LoginForm({
  form,
  setForm,
  onSave,
  onCancel,
  busy,
  projects,
}: {
  form: Form;
  setForm: (f: Form) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
  projects?: { id: string; name: string }[];
}) {
  const provider = form.provider ?? "other";
  const p = PROVIDERS[provider];
  return (
    <div className="space-y-3 mt-4 pt-4 border-t border-border">
      {!form.id && (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Registry">
          {(Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map((k) => (
            <Button
              key={k}
              type="button"
              role="radio"
              aria-checked={provider === k}
              variant={provider === k ? "primary" : "secondary"}
              onClick={() => {
                // Swap the suggested name too, unless the user typed their own
                const suggested = !form.name || Object.values(PROVIDERS).some((x) => x.label === form.name);
                setForm({ ...form, provider: k, host: PROVIDERS[k].host, name: suggested ? (k === "other" ? "" : PROVIDERS[k].label) : form.name });
              }}
            >
              {PROVIDERS[k].label}
            </Button>
          ))}
        </div>
      )}
      <p className="text-xs text-text-muted">{p.help}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name"><Input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={provider === "other" ? "Company registry" : p.label} /></Field>
        {provider === "other" || form.id ? (
          <Field label="Host"><Input value={form.host ?? ""} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="registry.example.com:5000" disabled={!!form.id && provider !== "other"} /></Field>
        ) : (
          <Field label="Host"><Input value={p.host} disabled /></Field>
        )}
        <Field label={p.user}><Input value={form.username ?? ""} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" /></Field>
        <Field label={p.secret} hint={form.id ? "Leave as is to keep the current one" : "Stored encrypted; never shown again"}>
          <Input type="password" value={form.password ?? ""} onFocus={() => form.password === MASK && setForm({ ...form, password: "" })} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
        </Field>
        {projects && !form.id && (
          <Field label="Used by" hint="Limit a service account to one project's apps">
            <Select value={form.projectId ?? ""} onChange={(e) => setForm({ ...form, projectId: e.target.value || null })}>
              <option value="">Every project</option>
              {projects.map((pr) => <option key={pr.id} value={pr.id}>Only {pr.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Push namespace (optional)" hint={`Where builds on a build server are pushed, e.g. ${p.namespace}`}>
          <Input value={form.namespace ?? ""} onChange={(e) => setForm({ ...form, namespace: e.target.value })} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={onSave} loading={busy}>{form.id ? "Save" : "Add login"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function RegistryLoginList({ ownerType }: { ownerType: "shared" | "personal" }) {
  const api = useApi();
  const confirm = useConfirm();
  const [rows, setRows] = useState<RegistryLogin[] | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [canAdd, setCanAdd] = useState(ownerType === "personal");

  const load = useCallback(async () => {
    const r = await api<RegistryLogin[]>("/api/registries");
    if (!r.ok) return setError(r.data.error ?? "Could not load registry logins");
    setRows((r.data as unknown as RegistryLogin[]).filter((x) => x.ownerType === ownerType));
  }, [api, ownerType]);
  useEffect(() => {
    load();
    if (ownerType === "shared") {
      api<{ id: string; name: string }[]>("/api/projects").then((r) => r.ok && setProjects(r.data as unknown as { id: string; name: string }[]));
      // Admins add service accounts (project admins may too, through the API, for their project)
      api<{ role: string }>("/api/account").then((r) => setCanAdd(r.ok && ["admin", "owner"].includes((r.data as unknown as { role: string }).role)));
    }
  }, [api, load, ownerType]);
  if (!rows) return error ? <ErrorText>{error}</ErrorText> : null;

  const save = async () => {
    if (!form) return;
    setBusy("save");
    setError("");
    setMsg("");
    const body = { ...form, ownerType, ...(form.provider && form.provider !== "other" && !form.id ? { host: PROVIDERS[form.provider].host } : {}) };
    const r = await api<RegistryLogin>(form.id ? `/api/registries/${form.id}` : "/api/registries", { method: form.id ? "PATCH" : "POST", body });
    setBusy("");
    if (!r.ok) return setError(r.data.error ?? "Could not save");
    const saved = r.data as unknown as RegistryLogin;
    setForm(null);
    await load();
    // Check it straight away, so a typo in the token shows up now and not at the next deploy
    if (!form.id || (form.password && form.password !== MASK)) test(saved.id);
  };
  const test = async (id: string) => {
    setBusy(id);
    setMsg("");
    setError("");
    const r = await api<{ ok: boolean; message: string }>(`/api/registries/${id}`, { method: "POST" });
    setBusy("");
    if (r.ok && (r.data as { ok: boolean }).ok) setMsg((r.data as { message: string }).message || "Signed in");
    else setError((r.data as { message?: string; error?: string }).message ?? r.data.error ?? "Test failed");
    load();
  };
  const remove = async (row: RegistryLogin) => {
    if (!(await confirm({ title: `Remove ${row.name}?`, message: "Apps that pull with it can't use it any more.", confirmLabel: "Remove" }))) return;
    const r = await api(`/api/registries/${row.id}`, { method: "DELETE" });
    if (!r.ok) setError(r.data.error ?? "Could not remove it");
    load();
  };

  return (
    <>
      {rows.length === 0 && !form && (
        <p className="text-sm text-text-muted py-2">
          {ownerType === "personal" ? "You haven't added a login yet." : `No service accounts yet. Public images still pull without one.${canAdd ? "" : " Ask an admin to add one."}`}
        </p>
      )}
      <div className="divide-y divide-border">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="text-text-primary flex flex-wrap items-center gap-2">
                {r.name} <Badge tone="muted">{r.host}</Badge>
                {ownerType === "shared" && <Badge tone={r.projectId ? "accent" : "muted"}>{r.projectName ? `Only ${r.projectName}` : "Every project"}</Badge>}
                <TestBadge r={r} />
              </p>
              <p className="text-xs text-text-muted truncate">{r.username}{r.namespace ? ` · pushes to ${r.namespace}` : ""}</p>
            </div>
            {r.canManage && (
              <div className="flex gap-1">
                <IconButton type="button" label={`Test sign-in to ${r.name}`} onClick={() => test(r.id)} loading={busy === r.id}><Send className="w-4 h-4" /></IconButton>
                <Button type="button" variant="ghost" onClick={() => setForm({ ...r })}>Edit</Button>
                <IconButton type="button" label={`Remove ${r.name}`} onClick={() => remove(r)}><Trash2 className="w-4 h-4" /></IconButton>
              </div>
            )}
          </div>
        ))}
      </div>
      {form ? (
        <LoginForm form={form} setForm={setForm} onSave={save} onCancel={() => setForm(null)} busy={busy === "save"} projects={ownerType === "shared" ? projects : undefined} />
      ) : (
        canAdd && (
          <Button type="button" variant="secondary" className="mt-3" onClick={() => setForm({ provider: "dockerhub", host: "docker.io", name: "Docker Hub" })}>
            <Plus className="w-4 h-4" /> {ownerType === "personal" ? "Add my login" : "Add service account"}
          </Button>
        )
      )}
      {msg && <p className="text-xs text-success mt-2">{msg}</p>}
      <ErrorText>{error}</ErrorText>
    </>
  );
}

/** Settings: shared logins that belong to DeployNow rather than a person. */
export function SharedRegistryLogins() {
  return (
    <section className="dn-surface border border-border rounded-2xl p-6">
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><Boxes className="w-4 h-4" /> Registry service accounts</h2>
      <p className="text-xs text-text-muted mb-3">
        Shared Docker Hub, GitHub (GHCR) or other registry logins that belong to DeployNow, not a person, so pulls and auto-updates keep working when someone leaves.
        Apps use the one for their image&apos;s host automatically; a login limited to a project wins for that project&apos;s apps. People can also add their own logins under Account.
      </p>
      <RegistryLoginList ownerType="shared" />
    </section>
  );
}

/** Account: your own logins. Only you see them, and only apps you pick them for use them. */
export function PersonalRegistryLogins() {
  return (
    <Card className="p-6">
      <h2 className="text-sm font-semibold text-text-primary mb-1 flex items-center gap-2"><UserRound className="w-4 h-4" /> My registry logins</h2>
      <p className="text-xs text-text-muted mb-3">
        Your own Docker Hub or GitHub (GHCR) logins. Only you can see them. An app uses one only when you pick it under the app&apos;s settings, and keeps using it for its deploys and auto-updates, whoever starts them. They&apos;re removed if your account is.
      </p>
      <RegistryLoginList ownerType="personal" />
    </Card>
  );
}

function hostOf(image: string): string {
  const first = image.split("/")[0];
  if (!image.includes("/") || !(first.includes(".") || first.includes(":") || first === "localhost")) return "docker.io";
  return first.toLowerCase();
}

/** App settings: which login this app pulls (and builds) with. */
export function AppRegistryLogin({
  app,
  onSave,
  busy,
}: {
  app: { sourceType: string; image: string; pullRegistryId: string | null; project: { id: string } };
  onSave: (body: Record<string, unknown>, what: string) => void;
  busy: boolean;
}) {
  const api = useApi();
  const [value, setValue] = useState(app.pullRegistryId ?? "");
  const [rows, setRows] = useState<RegistryLogin[] | null>(null);
  useEffect(() => {
    api<RegistryLogin[]>(`/api/registries?projectId=${encodeURIComponent(app.project.id)}`).then((r) => setRows(r.ok ? (r.data as unknown as RegistryLogin[]) : []));
  }, [api, app.project.id]);

  const host = app.sourceType === "image" && app.image ? hostOf(app.image) : null;
  const options = (rows ?? []).filter((r) => !host || r.host === host);
  // Keep showing a login someone else picked, even though this user can't choose it
  const keptOther = value && rows && !rows.some((r) => r.id === value);
  const picked = options.find((r) => r.id === value);
  return (
    <Card className="p-5 space-y-3">
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2"><Boxes className="w-4 h-4" /> Registry login</h3>
      <p className="text-xs text-text-muted">
        {app.sourceType === "image"
          ? `The login used to pull ${app.image || "the image"}, for deploys and update checks.`
          : "The login used to pull base images while building, and images in the compose file."}{" "}
        Automatic uses this project&apos;s service account for the host, then the shared one.
      </p>
      <Field label="Pull with" hint={picked?.ownerType === "personal" ? "Your personal login: everyone's deploys of this app will use it" : undefined}>
        <Select value={value} onChange={(e) => setValue(e.target.value)} disabled={rows === null}>
          <option value="">Automatic</option>
          {keptOther && <option value={value}>Picked by someone else</option>}
          {options.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.username}@{r.host}){r.ownerType === "personal" ? " · mine" : r.projectName ? ` · ${r.projectName}` : " · shared"}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex justify-end">
        <Button onClick={() => onSave({ pullRegistryId: value || null }, "Registry login")} loading={busy} disabled={value === (app.pullRegistryId ?? "")}>Save</Button>
      </div>
    </Card>
  );
}
