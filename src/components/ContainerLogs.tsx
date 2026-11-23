"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorText } from "./ui";

/** Live (or last N lines of) container logs, shared by the container and app pages. */
export default function ContainerLogs({ endpointId, containerId }: { endpointId: string; containerId: string }) {
  const [lines, setLines] = useState<{ s: string; t: string }[]>([]);
  const [follow, setFollow] = useState(true);
  const [tail, setTail] = useState(300);
  const [error, setError] = useState("");
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    setLines([]);
    setError("");
    const url = `/api/endpoints/${endpointId}/containers/${containerId}/logs?tail=${tail}&timestamps=1`;
    if (!follow) {
      fetch(url).then(async (r) => {
        const d = await r.json();
        if (r.ok) setLines([{ s: "stdout", t: d.text }]);
        else setError(d.error ?? "Could not read logs");
      });
      return;
    }
    const es = new EventSource(`${url}&follow=1`);
    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as { s: string; t: string };
      setLines((prev) => (prev.length > 5000 ? [...prev.slice(-4000), msg] : [...prev, msg]));
    };
    es.addEventListener("end", () => es.close());
    es.onerror = () => {
      es.close();
    };
    return () => es.close();
  }, [endpointId, containerId, follow, tail]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-text-secondary">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <select value={tail} onChange={(e) => setTail(Number(e.target.value))} className="px-2 py-1 bg-bg-secondary border border-border rounded-md text-text-primary">
          {[100, 300, 1000, 5000].map((n) => <option key={n} value={n}>last {n} lines</option>)}
        </select>
      </div>
      <ErrorText>{error}</ErrorText>
      <pre ref={box} className="h-[480px] overflow-auto bg-bg-primary border border-border rounded-lg p-3 text-xs font-mono whitespace-pre-wrap break-all">
        {lines.map((l, i) => (
          <span key={i} className={l.s === "stderr" ? "text-danger/90" : "text-text-secondary"}>{l.t}</span>
        ))}
      </pre>
    </div>
  );
}
