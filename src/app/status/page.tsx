import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicStatus } from "@/lib/statusPage";
import { DayBars } from "@/components/Uptime";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const s = await publicStatus().catch(() => null);
  return { title: { absolute: s?.title ?? "Status" }, robots: { index: false } };
}

const OVERALL = {
  up: { text: "All systems operational", cls: "bg-success/10 border-success/30 text-success" },
  degraded: { text: "Some systems are down", cls: "bg-warning/10 border-warning/30 text-warning" },
  down: { text: "Major outage", cls: "bg-danger/10 border-danger/30 text-danger" },
  unknown: { text: "No checks to show yet", cls: "bg-bg-secondary border-border text-text-secondary" },
};

function fmt(iso: string) {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

/** The public status page: names and uptime of the checks marked public. */
export default async function StatusPage() {
  const s = await publicStatus();
  if (!s) notFound();
  const o = OVERALL[s.overall];
  return (
    <main className="min-h-screen bg-bg-primary px-4 py-10">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold text-text-primary mb-6">{s.title}</h1>
        <div className={`rounded-xl border px-4 py-3 text-sm font-medium mb-8 ${o.cls}`}>{o.text}</div>
        <div className="space-y-6">
          {s.checks.map((c) => (
            <section key={c.id}>
              <div className="flex items-center justify-between gap-3 mb-2 text-sm">
                <span className="font-medium text-text-primary">{c.name}</span>
                <span className={c.status === "down" ? "text-danger" : c.status === "up" ? "text-success" : "text-text-muted"}>
                  {c.status === "down" ? "Down" : c.status === "up" ? "Operational" : "Pending"}
                  {c.uptime90d !== null && <span className="text-text-muted ml-2">{c.uptime90d}% in 90 days</span>}
                </span>
              </div>
              <DayBars days={c.days} />
            </section>
          ))}
        </div>
        <h2 className="text-sm font-semibold text-text-primary mt-10 mb-3">Incidents in the last 14 days</h2>
        {s.incidents.length === 0 ? (
          <p className="text-sm text-text-muted">None.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {s.incidents.map((i) => (
              <li key={i.name + i.startedAt} className="text-text-secondary">
                <span className="text-text-primary">{i.name}</span> was down from {fmt(i.startedAt)} {i.endedAt ? `to ${fmt(i.endedAt)}` : <span className="text-danger">and still is</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-muted mt-10">Updated {fmt(s.updatedAt)} · Powered by DeployNow</p>
      </div>
    </main>
  );
}
