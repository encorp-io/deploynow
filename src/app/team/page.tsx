"use client";

import { useCallback, useEffect, useState } from "react";
import { UserPlus, Copy, ShieldCheck, ShieldOff, Trash2, Ban, RotateCcw, KeyRound, Plus, X } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, timeAgo } from "@/components/ui";

const ROLES = ["viewer", "operator", "admin", "owner"] as const;
const ROLE_HELP: Record<string, string> = {
  viewer: "See endpoints and containers. No logs, env values or actions.",
  operator: "Viewer + logs, console, start/stop/restart and image updates.",
  admin: "Operator + remove resources, manage endpoints, users and settings.",
  owner: "Admin + manage owners and turn off required 2FA.",
};

interface Binding { id: string; role: string; scopeType: string; scopeId: string }
interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
  lastLoginAt: string | null;
  disabledAt: string | null;
  totpEnabled: boolean;
  roleBindings: Binding[];
}
interface Invite { id: string; email: string; role: string; expiresAt: string }
interface TeamData { users: UserRow[]; invites: Invite[]; endpoints: { id: string; name: string }[]; me: { id: string; role: string } }

export default function TeamPage() {
  const api = useApi();
  const [data, setData] = useState<TeamData | null>(null);
  const [error, setError] = useState("");
  const [invite, setInvite] = useState({ open: false, email: "", role: "operator", link: "" });
  const [grantFor, setGrantFor] = useState<UserRow | null>(null);
  const [grant, setGrant] = useState({ endpointId: "", role: "operator" });

  const load = useCallback(async () => {
    const res = await api<TeamData>("/api/team");
    if (res.ok) setData(res.data as TeamData);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function post(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    setError("");
    const res = await api<{ token?: string }>("/api/team", { body });
    if (!res.ok) setError(res.data.error ?? "Action failed");
    await load();
    return res;
  }

  async function sendInvite() {
    const res = await post({ action: "invite", email: invite.email, role: invite.role });
    if (res?.ok && res.data.token) setInvite({ ...invite, link: `${window.location.origin}/setup?token=${res.data.token}` });
  }

  if (!data) return <p className="text-sm text-text-muted">Loading…</p>;
  const isAdmin = data.me.role === "admin" || data.me.role === "owner";
  const endpointName = (id: string) => data.endpoints.find((e) => e.id === id)?.name ?? "removed endpoint";

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Team"
        subtitle="Everyone has an instance role; endpoint grants raise it on one machine"
        actions={isAdmin && <Button onClick={() => setInvite({ open: true, email: "", role: "operator", link: "" })}><UserPlus className="w-4 h-4" /> Invite</Button>}
      />
      <ErrorText>{error}</ErrorText>

      <Card className="overflow-hidden mt-2">
        <table className="w-full">
          <thead className="border-b border-border">
            <tr className="text-left text-xs text-text-muted">
              <th className="px-4 py-2.5 font-medium">Person</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Endpoint grants</th>
              <th className="px-4 py-2.5 font-medium">2FA</th>
              <th className="px-4 py-2.5 font-medium">Last sign-in</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.users.map((u) => {
              const self = u.id === data.me.id;
              const canEdit = isAdmin && !self && (u.role !== "owner" || data.me.role === "owner");
              return (
                <tr key={u.id} className={u.disabledAt ? "opacity-50" : ""}>
                  <td className="px-4 py-3 text-sm">
                    <p className="text-text-primary">{u.name} {self && <Badge tone="accent">you</Badge>} {u.disabledAt && <Badge tone="danger">disabled</Badge>}</p>
                    <p className="text-xs text-text-muted">{u.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    {canEdit ? (
                      <select
                        value={u.role}
                        onChange={(e) => post({ action: "updateRole", userId: u.id, role: e.target.value })}
                        className="px-2 py-1 bg-bg-secondary border border-border rounded-md text-sm text-text-primary capitalize"
                      >
                        {ROLES.filter((r) => r !== "owner" || data.me.role === "owner").map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : (
                      <span className="text-sm capitalize text-text-primary">{u.role}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1 items-center">
                      {u.roleBindings.filter((b) => b.scopeType === "endpoint").map((b) => (
                        <Badge key={b.id} tone="accent">
                          {endpointName(b.scopeId)}: {b.role}
                          {canEdit && (
                            <button title="Remove grant" onClick={() => post({ action: "revokeGrant", userId: u.id, bindingId: b.id })}>
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </Badge>
                      ))}
                      {canEdit && data.endpoints.length > 0 && (
                        <button className="text-xs text-text-muted hover:text-accent flex items-center gap-0.5" onClick={() => { setGrantFor(u); setGrant({ endpointId: data.endpoints[0].id, role: "operator" }); }}>
                          <Plus className="w-3 h-3" /> grant
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">{u.totpEnabled ? <ShieldCheck className="w-4 h-4 text-success" /> : <ShieldOff className="w-4 h-4 text-warning" />}</td>
                  <td className="px-4 py-3 text-xs text-text-muted">{timeAgo(u.lastLoginAt)}</td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {canEdit && (
                      <>
                        {u.totpEnabled && (
                          <Button variant="ghost" title="Reset 2FA" onClick={() => post({ action: "reset2fa", userId: u.id }, `Reset 2FA for ${u.email}? They will set it up again at next sign-in.`)}>
                            <KeyRound className="w-4 h-4" />
                          </Button>
                        )}
                        {u.disabledAt ? (
                          <Button variant="ghost" title="Re-enable" onClick={() => post({ action: "enable", userId: u.id })}><RotateCcw className="w-4 h-4" /></Button>
                        ) : (
                          <Button variant="ghost" title="Disable and sign out" onClick={() => post({ action: "disable", userId: u.id }, `Disable ${u.email}? They are signed out everywhere.`)}><Ban className="w-4 h-4" /></Button>
                        )}
                        <Button variant="ghost" title="Remove" onClick={() => post({ action: "remove", userId: u.id }, `Remove ${u.email} permanently?`)}><Trash2 className="w-4 h-4" /></Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {data.invites.length > 0 && (
        <Card className="p-5 mt-4">
          <h3 className="text-sm font-semibold mb-2">Pending invites</h3>
          {data.invites.map((i) => (
            <p key={i.id} className="text-xs text-text-secondary">{i.email} as {i.role}, expires {new Date(i.expiresAt).toLocaleDateString()}</p>
          ))}
        </Card>
      )}

      <Card className="p-5 mt-4">
        <h3 className="text-sm font-semibold mb-2">What each role can do</h3>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {ROLES.map((r) => (
            <p key={r}><span className="capitalize text-text-primary font-medium">{r}:</span> <span className="text-text-secondary">{ROLE_HELP[r]}</span></p>
          ))}
        </div>
      </Card>

      {invite.open && (
        <Modal title="Invite someone" onClose={() => setInvite({ ...invite, open: false })}>
          {invite.link ? (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">Send this link to {invite.email}. It works once and expires in 7 days.</p>
              <p className="text-xs font-mono break-all bg-bg-card border border-border rounded-lg p-3">{invite.link}</p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(invite.link)}><Copy className="w-4 h-4" /> Copy</Button>
                <Button onClick={() => setInvite({ ...invite, open: false })}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Field label="Email"><Input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
              <Field label="Role" hint={ROLE_HELP[invite.role]}>
                <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary capitalize">
                  {ROLES.filter((r) => r !== "owner" || data.me.role === "owner").map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setInvite({ ...invite, open: false })}>Cancel</Button>
                <Button onClick={sendInvite}>Create invite link</Button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {grantFor && (
        <Modal title={`Grant ${grantFor.name} access to an endpoint`} onClose={() => setGrantFor(null)}>
          <div className="space-y-4">
            <Field label="Endpoint">
              <select value={grant.endpointId} onChange={(e) => setGrant({ ...grant, endpointId: e.target.value })} className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary">
                {data.endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </Field>
            <Field label="Role on that endpoint" hint={ROLE_HELP[grant.role]}>
              <select value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })} className="w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary capitalize">
                {["viewer", "operator", "admin"].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setGrantFor(null)}>Cancel</Button>
              <Button onClick={async () => { await post({ action: "grant", userId: grantFor.id, ...grant }); setGrantFor(null); }}>Grant</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
