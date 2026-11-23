"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { ChevronRight, Loader2, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type React from "react";
import type { ButtonHTMLAttributes, ReactNode, InputHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Button({
  variant = "primary",
  loading,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "danger-solid" | "ghost"; loading?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={clsx(
        "inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:cursor-not-allowed",
        variant === "primary" && "bg-accent hover:bg-accent-hover text-white",
        variant === "secondary" && "bg-bg-card border border-border hover:border-border-bright text-text-primary",
        variant === "danger" && "bg-danger/15 text-danger hover:bg-danger/25",
        variant === "danger-solid" && "bg-danger hover:bg-danger/85 text-white",
        variant === "ghost" && "text-text-secondary hover:text-text-primary hover:bg-bg-card",
        className,
      )}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("bg-bg-card border border-border rounded-xl", className)}>{children}</div>;
}

export interface Crumb { label: string; href?: string }

/**
 * Page title row. `crumbs` renders a breadcrumb trail above the title; the actions
 * wrap under the title on narrow screens.
 */
export function PageHeader({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: Crumb[] }) {
  return (
    <div className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="flex items-center flex-wrap gap-1 text-sm text-text-muted mb-2">
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1 min-w-0">
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
              {c.href ? (
                <Link href={c.href} className="hover:text-text-primary truncate">{c.label}</Link>
              ) : (
                <span className="truncate">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-text-primary break-words">{title}</h1>
          {subtitle && <div className="text-sm text-text-muted mt-1">{subtitle}</div>}
        </div>
        {actions && <div className="flex items-center flex-wrap gap-2 flex-shrink-0">{actions}</div>}
      </div>
    </div>
  );
}

/** Square button for a single icon. `label` is required: it becomes the tooltip and the accessible name. */
export function IconButton({
  label,
  variant = "ghost",
  loading,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: "primary" | "secondary" | "danger" | "ghost"; loading?: boolean }) {
  return (
    <Button {...props} disabled={props.disabled || loading} variant={variant} title={label} aria-label={label} className={clsx("!px-2", className)}>
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : children}
    </Button>
  );
}

/** Grey placeholder block shown while data loads */
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-lg bg-bg-card", className)} />;
}

/** A page-sized loading placeholder: header plus a few cards */
export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="max-w-6xl" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-4 w-40 mb-3" />
      <Skeleton className="h-8 w-64 mb-8" />
      <div className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}

/** Empty list: icon, a line on what goes here, and the action that adds the first one */
export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Card className="px-6 py-12 text-center">
      {Icon && <Icon className="w-10 h-10 text-text-muted mx-auto mb-3" />}
      <p className="text-text-primary font-medium mb-1">{title}</p>
      {children && <div className="text-sm text-text-muted max-w-md mx-auto">{children}</div>}
      {action && <div className="mt-5 flex justify-center gap-2 flex-wrap">{action}</div>}
    </Card>
  );
}

/** Wraps a <table> so it scrolls sideways on narrow screens instead of breaking the layout */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx("overflow-x-auto", className)}>{children}</div>;
}

const inputClass =
  "w-full px-3 py-2 bg-bg-secondary border border-border rounded-lg text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-text-muted mt-1">{hint}</span>}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputClass, props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(inputClass, "font-mono text-xs", props.className)} />;
}

export function Badge({ tone = "muted", children }: { tone?: "success" | "warning" | "danger" | "accent" | "muted"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium",
        tone === "success" && "bg-success/15 text-success",
        tone === "warning" && "bg-warning/15 text-warning",
        tone === "danger" && "bg-danger/15 text-danger",
        tone === "accent" && "bg-accent/15 text-accent",
        tone === "muted" && "bg-bg-secondary text-text-secondary border border-border",
      )}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">{children}</p>;
}

const modalStack: (() => void)[] = [];

/**
 * Dialog. Closes on Escape and on a click outside. Pass `footer` for the action buttons:
 * it stays visible at the bottom while a long body scrolls.
 */
export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Only the top-most dialog reacts to Escape
    const entry = () => closeRef.current();
    modalStack.push(entry);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === entry) {
        e.stopPropagation();
        entry();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      modalStack.splice(modalStack.indexOf(entry), 1);
    };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          "w-full bg-bg-secondary border border-border rounded-t-xl sm:rounded-xl max-h-[92vh] sm:max-h-[90vh] flex flex-col",
          wide ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 px-6 pt-5 pb-4">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-text-muted hover:text-text-primary -mr-1">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 pb-6 overflow-y-auto">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-border flex justify-end gap-2 flex-wrap">{footer}</div>}
      </div>
    </div>
  );
}

export function stateTone(state: string): "success" | "warning" | "danger" | "muted" {
  if (state === "running" || state === "online") return "success";
  if (state === "paused" || state === "restarting" || state === "created" || state === "unknown") return "warning";
  if (state === "exited" || state === "dead" || state === "offline") return "danger";
  return "muted";
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function timeAgo(date: string | number | null | undefined): string {
  if (!date) return "never";
  const t = typeof date === "number" ? (date < 1e12 ? date * 1000 : date) : new Date(date).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx(inputClass, "pr-8", props.className)} />;
}

export function formatTime(date: string | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 bg-bg-secondary border border-border rounded-lg p-1 w-fit max-w-full overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx("px-3 py-1.5 rounded-md text-sm whitespace-nowrap", value === t.value ? "bg-bg-card text-text-primary" : "text-text-muted hover:text-text-secondary")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
