"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export interface JoinInfo {
  url: string;
  token: string;
  caFingerprint: string;
  expiresAt: string;
  command: string;
}

/** The one-time join command for an agent endpoint. */
export default function AgentJoin({ join }: { join: JoinInfo }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(join.command).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="space-y-2">
      <p className="text-sm text-text-secondary">
        Run this on the server. The token works once and expires {new Date(join.expiresAt).toLocaleTimeString()}. The agent checks that it is
        talking to this DeployNow by the CA fingerprint, then gets its own certificate.
      </p>
      <div className="relative">
        <pre className="bg-bg-primary border border-border rounded-lg p-3 pr-10 text-xs font-mono text-text-primary whitespace-pre-wrap break-all">{join.command}</pre>
        <button type="button" onClick={copy} title="Copy" className="absolute top-2 right-2 p-1.5 rounded text-text-muted hover:text-text-primary">
          {copied ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
        </button>
      </div>
      <p className="text-xs text-text-muted">
        The agent connects out to <span className="font-mono">{join.url}</span>. If that address is wrong, set the agent address in Settings.
      </p>
    </div>
  );
}
