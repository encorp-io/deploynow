"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Container, Loader2, AlertCircle, CheckCircle } from "lucide-react";

function SetupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);

  useEffect(() => {
    if (!token) {
      setTokenValid(false);
      return;
    }
    setTokenValid(true);
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    setError("");

    const res = await fetch("/api/team", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name, password }),
    });

    if (res.ok) {
      setDone(true);
      setTimeout(() => router.push("/login"), 2000);
    } else {
      const data = await res.json();
      setError(data.error || "Registration failed");
    }

    setLoading(false);
  }

  if (tokenValid === false) {
    return (
      <div className="text-center">
        <AlertCircle className="w-12 h-12 text-danger mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-text-primary mb-2">
          Invalid invite link
        </h2>
        <p className="text-sm text-text-muted">
          This invite link is missing, invalid, or has expired. Ask an admin to
          send you a new one.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="text-center">
        <CheckCircle className="w-12 h-12 text-success mx-auto mb-4" />
        <h2 className="text-lg font-semibold text-text-primary mb-2">
          Account created!
        </h2>
        <p className="text-sm text-text-muted">Redirecting to login...</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          Full Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2.5 bg-bg-card border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
          placeholder="Jane Doe"
          required
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2.5 bg-bg-card border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
          placeholder="Min 8 characters"
          required
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          Confirm Password
        </label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full px-3 py-2.5 bg-bg-card border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
          placeholder="••••••••"
          required
        />
      </div>

      {error && (
        <p className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-2.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        Create Account
      </button>
    </form>
  );
}

export default function SetupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-accent/20 flex items-center justify-center mx-auto mb-4">
            <Container className="w-8 h-8 text-accent" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary">
            Create Account
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Complete your DeployNow registration
          </p>
        </div>

        <Suspense
          fallback={
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 text-accent animate-spin" />
            </div>
          }
        >
          <SetupForm />
        </Suspense>
      </div>
    </div>
  );
}
