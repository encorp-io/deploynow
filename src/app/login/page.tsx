"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Container, Loader2, ShieldCheck } from "lucide-react";

const inputClass =
  "w-full px-3 py-2.5 bg-bg-card border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const result = await signIn("credentials", {
      email,
      password,
      code: needsCode ? code : "",
      redirect: false,
    });

    if (!result?.error) {
      router.push("/");
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
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-accent/20 flex items-center justify-center mx-auto mb-4">
            {needsCode ? <ShieldCheck className="w-8 h-8 text-accent" /> : <Container className="w-8 h-8 text-accent" />}
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Encorp Deployer</h1>
          <p className="text-sm text-text-muted mt-1">
            {needsCode ? "Enter the code from your authenticator app" : "Sign in to your deployment dashboard"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!needsCode ? (
            <>
              <div>
                <label className="block text-xs font-medium text-text-secondary mb-1.5">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} placeholder="admin@encorp.io" autoComplete="username" required />
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

          {error && <p className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
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
                setError("");
              }}
              className="w-full text-xs text-text-muted hover:text-text-secondary"
            >
              Use a different account
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
