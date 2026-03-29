"use client";

import { useState, useEffect } from "react";
import {
  UserPlus,
  Loader2,
  Trash2,
  Copy,
  CheckCircle,
  Shield,
  User,
  Mail,
} from "lucide-react";

interface TeamUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

interface Invite {
  id: string;
  email: string;
  token: string;
  role: string;
  expiresAt: string;
}

export default function TeamPage() {
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [inviting, setInviting] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [newInviteLink, setNewInviteLink] = useState<string | null>(null);

  async function fetchTeam() {
    const res = await fetch("/api/team");
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users);
      setInvites(data.invites);
    }
    setLoading(false);
  }

  useEffect(() => {
    fetchTeam();
  }, []);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setNewInviteLink(null);

    const res = await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "invite",
        email: inviteEmail,
        role: inviteRole,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const link = `${window.location.origin}/setup?token=${data.token}`;
      setNewInviteLink(link);
      setInviteEmail("");
      await fetchTeam();
    }

    setInviting(false);
  }

  async function handleRemove(userId: string) {
    if (!confirm("Are you sure you want to remove this team member?")) return;

    await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", userId }),
    });

    await fetchTeam();
  }

  async function handleRoleChange(userId: string, role: string) {
    await fetch("/api/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "updateRole", userId, role }),
    });

    await fetchTeam();
  }

  function copyToClipboard(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopiedToken(id);
    setTimeout(() => setCopiedToken(null), 2000);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Team</h1>
        <p className="text-sm text-text-muted mt-1">
          Manage team members and invite new users
        </p>
      </div>

      {/* Invite form */}
      <section className="bg-bg-card border border-border rounded-xl p-6 mb-8">
        <h2 className="text-sm font-semibold text-text-primary mb-4">
          Invite Team Member
        </h2>
        <form onSubmit={handleInvite} className="flex items-end gap-3">
          <div className="flex-1">
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="w-full px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
              placeholder="colleague@company.com"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1.5">
              Role
            </label>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="px-3 py-2.5 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary focus:outline-none focus:border-accent transition-colors"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={inviting}
            className="flex items-center gap-2 px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {inviting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <UserPlus className="w-4 h-4" />
            )}
            Invite
          </button>
        </form>

        {newInviteLink && (
          <div className="mt-4 bg-success/10 border border-success/20 rounded-lg p-3">
            <p className="text-xs text-success font-medium mb-2">
              Invite link created! Share this with the team member:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-text-primary bg-bg-secondary rounded px-2 py-1.5 truncate">
                {newInviteLink}
              </code>
              <button
                onClick={() => copyToClipboard(newInviteLink, "new")}
                className="p-2 hover:bg-bg-secondary rounded-lg transition-colors"
              >
                {copiedToken === "new" ? (
                  <CheckCircle className="w-4 h-4 text-success" />
                ) : (
                  <Copy className="w-4 h-4 text-text-muted" />
                )}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Members list */}
      <section className="bg-bg-card border border-border rounded-xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">
            Members ({users.length})
          </h2>
        </div>
        <div className="divide-y divide-border">
          {users.map((user) => (
            <div
              key={user.id}
              className="flex items-center justify-between px-6 py-4"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-bg-secondary flex items-center justify-center">
                  {user.role === "admin" ? (
                    <Shield className="w-4 h-4 text-accent" />
                  ) : (
                    <User className="w-4 h-4 text-text-muted" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {user.name}
                  </p>
                  <p className="text-xs text-text-muted">{user.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <select
                  value={user.role}
                  onChange={(e) => handleRoleChange(user.id, e.target.value)}
                  className="px-2 py-1 bg-bg-secondary border border-border rounded text-xs text-text-secondary focus:outline-none"
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                {users.length > 1 && (
                  <button
                    onClick={() => handleRemove(user.id)}
                    className="p-1.5 text-text-muted hover:text-danger hover:bg-danger/10 rounded-lg transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Pending invites */}
      {invites.length > 0 && (
        <section className="bg-bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-sm font-semibold text-text-primary">
              Pending Invites ({invites.length})
            </h2>
          </div>
          <div className="divide-y divide-border">
            {invites.map((invite) => (
              <div
                key={invite.id}
                className="flex items-center justify-between px-6 py-4"
              >
                <div className="flex items-center gap-3">
                  <Mail className="w-4 h-4 text-text-muted" />
                  <div>
                    <p className="text-sm text-text-primary">{invite.email}</p>
                    <p className="text-xs text-text-muted">
                      Expires{" "}
                      {new Date(invite.expiresAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <span className="text-xs text-text-muted bg-bg-secondary px-2 py-1 rounded">
                  {invite.role}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
