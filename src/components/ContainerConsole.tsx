"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Button } from "./ui";

type Api = <T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) => Promise<{ ok: boolean; data: T & { error?: string } }>;

export default function ContainerConsole({ api, endpointId, containerId }: { api: Api; endpointId: string; containerId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState("/bin/sh");
  const [status, setStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");
  const [error, setError] = useState("");
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  async function connect() {
    cleanup.current?.();
    setError("");
    setStatus("connecting");

    const res = await api<{ ticket: string; wsUrl: string }>(`/api/endpoints/${endpointId}/containers/${containerId}/exec`, { body: { shell } });
    if (!res.ok) {
      setStatus("idle");
      setError(res.data.error ?? "Could not open a console");
      return;
    }

    const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: "#0a0e1a" }, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    host.current!.innerHTML = "";
    term.open(host.current!);
    fit.fit();

    const base = res.data.wsUrl.startsWith("ws") ? res.data.wsUrl : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${res.data.wsUrl}`;
    const ws = new WebSocket(`${base}?ticket=${encodeURIComponent(res.data.ticket)}`);
    ws.binaryType = "arraybuffer";

    const sendSize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
    };
    ws.onopen = () => {
      setStatus("open");
      sendSize();
      term.focus();
    };
    ws.onmessage = (ev) => term.write(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data));
    ws.onclose = (ev) => {
      setStatus("closed");
      term.write(`\r\n\x1b[90m[console closed${ev.reason ? `: ${ev.reason}` : ""}]\x1b[0m\r\n`);
    };
    const input = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "i", d })));
    window.addEventListener("resize", sendSize);

    cleanup.current = () => {
      window.removeEventListener("resize", sendSize);
      input.dispose();
      ws.close();
      term.dispose();
    };
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          className="px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary"
          disabled={status === "open" || status === "connecting"}
        >
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/ash">/bin/ash</option>
        </select>
        {status === "open" ? (
          <Button variant="secondary" onClick={() => cleanup.current?.()}>Disconnect</Button>
        ) : (
          <Button loading={status === "connecting"} onClick={connect}>{status === "closed" ? "Reconnect" : "Connect"}</Button>
        )}
        <span className="text-xs text-text-muted">Console sessions are recorded in the audit log.</span>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div ref={host} className="h-[420px] bg-bg-primary border border-border rounded-lg p-2 overflow-hidden" />
    </div>
  );
}
