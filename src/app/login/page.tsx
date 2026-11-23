"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, Loader2, LogIn } from "lucide-react";
import AuthShell, { authInputClass, authPrimaryClass, authSecondaryClass } from "@/components/AuthShell";

const SSO_ERRORS: Record<string, string> = {
  sso_unavailable: "That sign-in option isn't available right now.",
  sso_cancelled: "Sign-in was cancelled.",
  sso_failed: "Single sign-on failed.",
  rate_limited: "Too many failed attempts. Try again in 15 minutes.",
};

const inputClass = authInputClass;

/** Where to go after signing in: a same-site path from ?next= (kept across SSO round trips), else the dashboard. */
function afterLogin(): string {
  let next = "";
  try {
    next = new URLSearchParams(window.location.search).get("next") || sessionStorage.getItem("dn_next") || "";
    sessionStorage.removeItem("dn_next");
  } catch {
    /* storage blocked */
  }
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ticket, setTicket] = useState("");
  const [providers, setProviders] = useState<{ id: string; name: string; type: string }[]>([]);
  const [passkeySupported, setPasskeySupported] = useState(false);

  async function exchangeTicket(t: string, c = "") {
    const result = await signIn("ticket", { ticket: t, code: c, redirect: false });
    return result;
  }

  useEffect(() => {
    fetch("/api/sso/login").then((r) => (r.ok ? r.json() : [])).then(setProviders).catch(() => {});
    setPasskeySupported(typeof window !== "undefined" && !!window.PublicKeyCredential && window.isSecureContext);
    const q = new URLSearchParams(window.location.search);
    try {
      if (q.get("next")) sessionStorage.setItem("dn_next", q.get("next")!);
    } catch {
      /* storage blocked */
    }
    const err = q.get("error");
    if (err) setError(q.get("message") || SSO_ERRORS[err] || "Sign-in failed.");
    const t = q.get("ticket");
    if (t) {
      window.history.replaceState(null, "", "/login");
      setTicket(t);
      setLoading(true);
      exchangeTicket(t).then((result) => {
        setLoading(false);
        if (!result?.error) {
          router.push(afterLogin());
        } else if (result.code === "2fa_required") {
          setNeedsCode(true);
        } else {
          setTicket("");
          setError(result.code === "rate_limited" ? SSO_ERRORS.rate_limited : "The sign-in link expired; try again.");
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function passkeyLogin() {
    setError("");
    setLoading(true);
    try {
      const options = await fetch("/api/passkeys/login", { method: "POST" }).then((r) => r.json());
      if (options.error) throw new Error(options.error);
      const response = await startAuthentication({ optionsJSON: options });
      const res = await fetch("/api/passkeys/login/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Passkey sign-in failed");
      const result = await exchangeTicket(data.ticket);
      if (result?.error) throw new Error("Passkey sign-in failed");
      router.push(afterLogin());
    } catch (err) {
      setLoading(false);
      const msg = (err as Error).message || "";
      setError(/NotAllowed|abort|cancel/i.test(msg) || (err as Error).name === "NotAllowedError" ? "Passkey sign-in was cancelled." : msg);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const result = ticket
      ? await exchangeTicket(ticket, code)
      : await signIn("credentials", {
          email,
          password,
          code: needsCode ? code : "",
          redirect: false,
        });

    if (!result?.error) {
      router.push(afterLogin());
      return;
    }

    setLoading(false);
    switch (result.code) {
      case "2fa_required":
        setNeedsCode(true);
        break;
      case "invalid_code":
        setError("That code didn't work. Use the current code from your app, or a recovery code.");
        setCode("");
        break;
      case "rate_limited":
        setError("Too many failed attempts. Try again in 15 minutes.");
        break;
      default:
        setError("Invalid email or password");
    }
  }

  return (
    <AuthShell
      title={needsCode ? "Two-factor check" : "Welcome back"}
      subtitle={needsCode ? "Enter the code from your authenticator app" : "Sign in to your deployment dashboard"}
    >
        <form onSubmit={handleSubmit} className="space-y-4">
          {!needsCode ? (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="you@company.com" autoComplete="username" required />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} placeholder="••••••••" autoComplete="current-password" required />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">Authentication code</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={`${inputClass} text-center tracking-widest text-lg`}
                placeholder="123456"
                inputMode="text"
                autoComplete="one-time-code"
                autoFocus
                required
              />
              <p className="text-xs text-text-muted mt-1.5">Lost your phone? Enter one of your recovery codes instead.</p>
            </div>
          )}

          {error && <p className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-xl px-3 py-2">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className={authPrimaryClass}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {needsCode ? "Verify" : "Sign In"}
          </button>
          {needsCode && (
            <button
              type="button"
              onClick={() => {
                setNeedsCode(false);
                setCode("");
                setTicket("");
                setError("");
              }}
              className="w-full text-xs text-text-muted hover:text-text-secondary"
            >
              Use a different account
            </button>
          )}
        </form>

        {!needsCode && (providers.length > 0 || passkeySupported) && (
          <div className="mt-6 space-y-2">
            <div className="flex items-center gap-3 text-xs text-text-muted">
              <span className="flex-1 h-px bg-border" />
              or
              <span className="flex-1 h-px bg-border" />
            </div>
            {passkeySupported && (
              <button type="button" onClick={passkeyLogin} disabled={loading} className={authSecondaryClass}>
                <KeyRound className="w-4 h-4" /> Sign in with a passkey
              </button>
            )}
            {providers.map((p) => (
              <a key={p.id} href={`/api/sso/login/${p.id}`} className={authSecondaryClass}>
                <LogIn className="w-4 h-4" /> Continue with {p.name}
              </a>
            ))}
          </div>
        )}
    </AuthShell>
  );
}
