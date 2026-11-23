"use client";

import { clsx } from "clsx";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";
import { THEME_KEY as KEY } from "@/lib/theme";


function apply(t: Theme) {
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Match system", icon: Monitor },
];

/** Three-way light / dark / system switch */
export default function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    try {
      setTheme((localStorage.getItem(KEY) as Theme) || "dark");
    } catch {
      /* storage blocked */
    }
  }, []);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [theme]);

  function choose(t: Theme) {
    setTheme(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* storage blocked */
    }
    apply(t);
  }

  return (
    <div role="radiogroup" aria-label="Theme" className={clsx("flex items-center gap-0.5 p-0.5 rounded-lg bg-bg-primary/60 border border-border", className)}>
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const on = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.label}
            title={o.label}
            onClick={() => choose(o.value)}
            className={clsx(
              "flex-1 flex items-center justify-center h-6 rounded-md transition-colors",
              on ? "bg-bg-card text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary",
            )}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        );
      })}
    </div>
  );
}
