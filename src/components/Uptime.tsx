import { clsx } from "clsx";

function dayColor(d: { up: number; total: number }) {
  if (!d.total) return "bg-border";
  const r = d.up / d.total;
  return r >= 0.999 ? "bg-success" : r >= 0.98 ? "bg-warning" : "bg-danger";
}

/** One bar per day: green when up, amber below 99.9%, red below 98%, grey without data. */
export function DayBars({ days }: { days: { day: string; up: number; total: number }[] }) {
  return (
    <div className="flex gap-[2px] h-6 items-stretch" role="img" aria-label="Uptime per day">
      {days.map((d) => (
        <div key={d.day} title={`${d.day}: ${d.total ? `${((d.up / d.total) * 100).toFixed(2)}% up` : "no data"}`} className={clsx("flex-1 min-w-[2px] rounded-[1px]", dayColor(d))} />
      ))}
    </div>
  );
}

