"use client";

import { useState } from "react";
import { Bot, ShieldAlert } from "lucide-react";
import { Button, ErrorText } from "@/components/ui";
import AuthShell from "@/components/AuthShell";

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
    <AuthShell title={<span className="break-words">Connect {props.clientName} to DeployNow?</span>} subtitle={`${props.server} · signed in as ${props.email}`}>
      <div className="space-y-5">
        <div className="flex justify-center -mt-2">
          <div className="w-12 h-12 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center shadow-[0_8px_32px_-8px_var(--dn-accent)]">
            <Bot className="w-6 h-6 text-accent" />
          </div>
        </div>

        <div className="flex gap-2 text-xs text-text-secondary bg-warning/10 border border-warning/25 rounded-xl p-3">
          <ShieldAlert className="w-4 h-4 text-warning shrink-0 mt-0.5" />
          <p>
            The app named itself, so DeployNow can&apos;t vouch for the name. Only continue if you just added DeployNow as a connector in an app you trust. It will act as you and return to{" "}
            <strong className="text-text-primary break-all">{props.returnTo}</strong>.
          </p>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-text-secondary mb-2">What may it do?</legend>
          {props.options.map((o) => (
            <label key={o.role} className={`flex gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${role === o.role ? "border-accent/60 bg-accent/10 ring-1 ring-inset ring-accent/20" : "border-border bg-bg-secondary/50 hover:border-border-bright"}`}>
              <input type="radio" name="role" value={o.role} checked={role === o.role} onChange={() => setRole(o.role)} className="mt-0.5" />
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

        <div className="flex gap-2 justify-end pt-1">
          <Button variant="secondary" onClick={() => answer("deny")} loading={busy === "deny"} disabled={!!busy}>
            Cancel
          </Button>
          <Button onClick={() => answer("allow")} loading={busy === "allow"} disabled={!!busy}>
            Allow
          </Button>
        </div>
      </div>
    </AuthShell>
  );
}
