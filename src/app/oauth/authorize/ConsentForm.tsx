"use client";

import { useState } from "react";
import { Bot, ShieldAlert } from "lucide-react";
import { Button, ErrorText } from "@/components/ui";

interface Option {
  role: string;
  label: string;
  text: string;
}

export default function ConsentForm(props: { query: string; clientName: string; clientUri: string; returnTo: string; email: string; options: Option[]; initialRole: string; server: string }) {
  const [role, setRole] = useState(props.initialRole);
  const [busy, setBusy] = useState<"" | "allow" | "deny">("");
  const [error, setError] = useState("");

  async function answer(decision: "allow" | "deny") {
    setBusy(decision);
    setError("");
    try {
      const res = await fetch("/api/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: props.query, decision, role }) });
      const data = await res.json();
      if (!res.ok || !data.redirect) throw new Error(data.error || "Something went wrong");
      window.location.assign(data.redirect);
    } catch (err) {
      setBusy("");
      setError((err as Error).message);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md bg-bg-card border border-border rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent/20 flex items-center justify-center">
            <Bot className="w-5 h-5 text-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-text-primary break-words">Connect {props.clientName} to DeployNow?</h1>
            <p className="text-xs text-text-muted">
              {props.server} · signed in as {props.email}
            </p>
          </div>
        </div>

        <div className="flex gap-2 text-xs text-text-secondary bg-warning/10 border border-warning/30 rounded-lg p-3">
          <ShieldAlert className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <p>
            The app named itself, so DeployNow can&apos;t vouch for the name. Only continue if you just added DeployNow as a connector in an app you trust. It will act as you and return to{" "}
            <strong className="text-text-primary break-all">{props.returnTo}</strong>.
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-text-secondary mb-2">What may it do?</legend>
          {props.options.map((o) => (
            <label key={o.role} className={`flex gap-3 p-3 rounded-lg border cursor-pointer ${role === o.role ? "border-accent bg-accent/5" : "border-border hover:border-border-bright"}`}>
              <input type="radio" name="role" value={o.role} checked={role === o.role} onChange={() => setRole(o.role)} className="mt-1 accent-[var(--color-accent)]" />
              <span>
                <span className="block text-sm font-medium text-text-primary">{o.label}</span>
                <span className="block text-xs text-text-muted">{o.text}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-text-muted pt-1">
            It can never do more than your own role allows, delete anything, reveal secrets, or open a console. You can disconnect it any time under Account.
          </p>
        </fieldset>

        {error && <ErrorText>{error}</ErrorText>}

        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={() => answer("deny")} loading={busy === "deny"} disabled={!!busy}>
            Cancel
          </Button>
          <Button onClick={() => answer("allow")} loading={busy === "allow"} disabled={!!busy}>
            Allow
          </Button>
        </div>
      </div>
    </div>
  );
}
