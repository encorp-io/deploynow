"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ShieldCheck, ShieldAlert, Monitor, KeyRound, Copy } from "lucide-react";
import { useApi } from "@/components/AppShell";
import { Badge, Button, Card, ErrorText, Field, Input, PageHeader, timeAgo, PageSkeleton } from "@/components/ui";
import { ApiTokensCard, PasskeysCard } from "@/components/AccountSecurity";

interface Account {
  email: string;
  name: string;
  role: string;
  totpEnabled: boolean;
  passkeys: number;
  recoveryCodesLeft: number;
  mfaSetupRequired: boolean;
  twoFactorRequiredForRole: boolean;
}

interface SessionRow {
  id: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

function describeAgent(ua: string): string {
  if (!ua) return "Unknown device";
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        Save these recovery codes somewhere safe, like a password manager. Each one works once if you lose your phone.
        They won&apos;t be shown again.
      </p>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-bg-secondary border border-border rounded-lg p-4">
        {codes.map((c) => (
          <span key={c} className="text-text-primary">{c}</span>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(codes.join("\n"))}>
          <Copy className="w-4 h-4" /> Copy
        </Button>
        <Button onClick={onDone}>I&apos;ve saved them</Button>
      </div>
    </div>
  );
}

function AccountPage() {
  const api = useApi();
  const params = useSearchParams();
  const [account, setAccount] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  // 2FA setup
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [tfaError, setTfaError] = useState("");
  const [busy, setBusy] = useState(false);
  const [disableForm, setDisableForm] = useState({ open: false, password: "", code: "" });

  // Password
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwMsg, setPwMsg] = useState<{ error?: string; ok?: string }>({});

  const load = useCallback(async () => {
    const [a, s] = await Promise.all([api<Account>("/api/account"), api<SessionRow[]>("/api/account/sessions")]);
    if (a.ok) setAccount(a.data);
    if (s.ok) setSessions(s.data as unknown as SessionRow[]);
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  async function startSetup() {
    setTfaError("");
    setBusy(true);
    const res = await api<{ secret: string; qr: string }>("/api/account/2fa", { body: { action: "setup" } });
    setBusy(false);
    if (res.ok) setSetup(res.data);
    else setTfaError(res.data.error ?? "Could not start setup");
  }

  async function enable() {
    setTfaError("");
    setBusy(true);
    const res = await api<{ recoveryCodes: string[] }>("/api/account/2fa", { body: { action: "enable", code } });
    setBusy(false);
    if (res.ok) {
      setCodes(res.data.recoveryCodes);
      setSetup(null);
      setCode("");
    } else setTfaError(res.data.error ?? "Code didn't match");
  }

  async function disable() {
    setTfaError("");
    setBusy(true);
    const res = await api("/api/account/2fa", { body: { action: "disable", password: disableForm.password, code: disableForm.code } });
    setBusy(false);
    if (res.ok) {
      setDisableForm({ open: false, password: "", code: "" });
      load();
    } else setTfaError(res.data.error ?? "Could not turn off 2FA");
  }

  async function regenerate() {
    const c = window.prompt("Enter a code from your authenticator app to create new recovery codes");
    if (!c) return;
    const res = await api<{ recoveryCodes: string[] }>("/api/account/recovery-codes", { body: { code: c } });
    if (res.ok) setCodes(res.data.recoveryCodes);
    else setTfaError(res.data.error ?? "Could not create codes");
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg({});
    if (pw.next !== pw.confirm) return setPwMsg({ error: "The new passwords don't match" });
    const res = await api<{ revokedSessions: number }>("/api/account/password", {
      body: { currentPassword: pw.current, newPassword: pw.next },
    });
    if (res.ok) {
      setPw({ current: "", next: "", confirm: "" });
      setPwMsg({ ok: `Password changed. ${res.data.revokedSessions} other session(s) signed out.` });
      load();
    } else setPwMsg({ error: res.data.error ?? "Could not change password" });
  }

  async function revoke(query: string) {
    await api(`/api/account/sessions?${query}`, { method: "DELETE" });
    load();
  }

  if (!account) return <PageSkeleton rows={4} />;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Account" subtitle={`${account.email} · ${account.role}`} />

      {(account.mfaSetupRequired || params.get("setup") === "2fa") && !account.totpEnabled && !account.passkeys && (
        <div className="flex gap-3 items-start bg-warning/10 border border-warning/30 rounded-xl p-4 text-sm text-text-primary">
          <ShieldAlert className="w-5 h-5 text-warning flex-shrink-0" />
          <p>
            {account.mfaSetupRequired
              ? "Your role requires two-factor authentication. Set up an authenticator app or add a passkey below to continue."
              : "Set up two-factor authentication to protect your account."}
          </p>
        </div>
      )}

      <Card className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-accent" />
            <div>
              <h2 className="font-semibold text-text-primary">Two-factor authentication</h2>
              <p className="text-xs text-text-muted">A 6-digit code from an authenticator app at every sign-in</p>
            </div>
          </div>
          {account.totpEnabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>}
        </div>

        {codes ? (
          <RecoveryCodes codes={codes} onDone={() => { setCodes(null); load(); }} />
        ) : account.totpEnabled ? (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {account.recoveryCodesLeft} of 10 recovery codes left.
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={regenerate}><KeyRound className="w-4 h-4" /> New recovery codes</Button>
              {!account.twoFactorRequiredForRole && (
                <Button variant="danger" onClick={() => setDisableForm({ ...disableForm, open: !disableForm.open })}>Turn off</Button>
              )}
            </div>
            {disableForm.open && (
              <div className="grid sm:grid-cols-2 gap-3">
                <Input type="password" placeholder="Password" value={disableForm.password} onChange={(e) => setDisableForm({ ...disableForm, password: e.target.value })} />
                <Input placeholder="Code" value={disableForm.code} onChange={(e) => setDisableForm({ ...disableForm, code: e.target.value })} />
                <Button variant="danger" loading={busy} onClick={disable} className="sm:col-span-2">Turn off 2FA</Button>
              </div>
            )}
          </div>
        ) : setup ? (
          <div className="grid grid-cols-[220px_1fr] gap-6 items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR code for your authenticator app" width={220} height={220} className="rounded-lg bg-white p-2" />
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                Scan the code with Google Authenticator, 1Password, Bitwarden or a similar app. Or type this key:
              </p>
              <p className="font-mono text-xs break-all bg-bg-secondary border border-border rounded-lg p-2 text-text-primary">{setup.secret}</p>
              <Field label="Code from the app">
                <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" />
              </Field>
              <Button loading={busy} onClick={enable}>Turn on</Button>
            </div>
          </div>
        ) : (
          <Button loading={busy} onClick={startSetup}>Set up 2FA</Button>
        )}
        <ErrorText>{tfaError}</ErrorText>
      </Card>

      <PasskeysCard onChange={load} />

      {!account.mfaSetupRequired && <ApiTokensCard role={account.role} />}

      <Card className="p-6">
        <h2 className="font-semibold text-text-primary mb-4">Password</h2>
        <form onSubmit={changePassword} className="grid sm:grid-cols-3 gap-3">
          <Input type="password" placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
          <Input type="password" placeholder="New password (12+ characters)" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
          <Input type="password" placeholder="Repeat new password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
          <div className="sm:col-span-3 flex items-center gap-3">
            <Button type="submit">Change password</Button>
            {pwMsg.ok && <span className="text-xs text-success">{pwMsg.ok}</span>}
          </div>
          <div className="sm:col-span-3"><ErrorText>{pwMsg.error}</ErrorText></div>
        </form>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text-primary">Signed-in sessions</h2>
          {sessions.length > 1 && <Button variant="secondary" onClick={() => revoke("others=1")}>Sign out other sessions</Button>}
        </div>
        <div className="divide-y divide-border">
          {sessions.map((s) => (
            <div key={s.id} className="flex items-center justify-between py-3 text-sm">
              <div className="flex items-center gap-3">
                <Monitor className="w-4 h-4 text-text-muted" />
                <div>
                  <p className="text-text-primary">
                    {describeAgent(s.userAgent)} {s.current && <Badge tone="accent">This device</Badge>}
                  </p>
                  <p className="text-xs text-text-muted">
                    {s.ip || "unknown IP"} · signed in {timeAgo(s.createdAt)} · active {timeAgo(s.lastSeenAt)}
                  </p>
                </div>
              </div>
              {!s.current && <Button variant="ghost" onClick={() => revoke(`id=${s.id}`)}>Sign out</Button>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <AccountPage />
    </Suspense>
  );
}
