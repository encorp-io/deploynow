"use client";

import { clsx } from "clsx";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Loader2, Search, X, type LucideIcon } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
        "inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-[10px] text-sm font-medium whitespace-nowrap transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary disabled:opacity-50 disabled:cursor-not-allowed",
        variant === "primary" && "dn-btn-primary text-white",
        variant === "secondary" && "bg-bg-card border border-border hover:border-border-bright hover:bg-bg-card-hover text-text-primary shadow-[0_1px_2px_rgba(0,0,0,0.08)]",
        variant === "danger" && "bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20",
        variant === "danger-solid" && "bg-danger hover:brightness-110 text-white shadow-[0_6px_20px_-8px_var(--dn-danger)]",
        variant === "ghost" && "text-text-secondary hover:text-text-primary hover:bg-bg-card-hover",
        className,
      )}
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("dn-surface border border-border rounded-2xl", className)}>{children}</div>;
}

export interface Crumb { label: string; href?: string }

/**
 * Page title row. `crumbs` renders a breadcrumb trail above the title; the actions
 * wrap under the title on narrow screens.
 */
export function PageHeader({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: Crumb[] }) {
  return (
    <div className="mb-8 animate-page-in">
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
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em] text-text-primary break-words">{title}</h1>
          {subtitle && <div className="text-sm text-text-secondary mt-1.5">{subtitle}</div>}
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
  return <div className={clsx("animate-pulse rounded-xl bg-bg-card-hover", className)} />;
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
    <Card className="px-6 py-14 text-center">
      {Icon && (
        <div className="w-14 h-14 rounded-2xl mx-auto mb-4 flex items-center justify-center bg-accent/10 border border-accent/20 shadow-[0_8px_32px_-8px_var(--dn-accent)]">
          <Icon className="w-6 h-6 text-accent" />
        </div>
      )}
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

/** Shared look for text fields; see `.dn-input` in globals.css */
export const inputClass = "dn-input";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block group/field">
      <span className="block text-[13px] font-medium text-text-secondary mb-1.5 transition-colors group-focus-within/field:text-text-primary">{label}</span>
      {children}
      {hint && <span className="block text-xs text-text-muted mt-1.5 leading-relaxed">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputClass, className)} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx(inputClass, "font-mono text-xs", className)} />;
}

/**
 * Checkbox or switch with a label and an optional line of help under it.
 * `variant="switch"` draws a toggle (role="switch"), for settings that turn something on or off.
 */
export function Checkbox({
  label,
  hint,
  variant = "checkbox",
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; hint?: ReactNode; variant?: "checkbox" | "switch" }) {
  return (
    <label className={clsx("flex items-start gap-3 text-sm", props.disabled ? "opacity-60" : "cursor-pointer", className)}>
      <input type="checkbox" role={variant === "switch" ? "switch" : undefined} {...props} className="mt-[1px]" />
      <span className="min-w-0">
        <span className="block text-text-primary leading-5">{label}</span>
        {hint && <span className="block text-xs text-text-muted mt-0.5 leading-relaxed">{hint}</span>}
      </span>
    </label>
  );
}

export function Badge({ tone = "muted", children }: { tone?: "success" | "warning" | "danger" | "accent" | "muted"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border",
        tone === "success" && "bg-success/10 text-success border-success/20",
        tone === "warning" && "bg-warning/10 text-warning border-warning/20",
        tone === "danger" && "bg-danger/10 text-danger border-danger/20",
        tone === "accent" && "bg-accent/10 text-accent border-accent/20",
        tone === "muted" && "bg-bg-secondary text-text-secondary border-border",
      )}
    >
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-[10px] px-3 py-2">{children}</p>;
}

const modalStack: (() => void)[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog. Closes on Escape and on a click outside, keeps keyboard focus inside while open and
 * returns it to where it was on close. Pass `footer` for the action buttons: it stays visible
 * at the bottom while a long body scrolls. `icon` and `description` add a header tile and a
 * line under the title. On phones it opens as a bottom sheet.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
  icon: Icon,
  description,
  tone = "accent",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
  icon?: LucideIcon;
  description?: ReactNode;
  tone?: "accent" | "danger" | "warning";
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const uid = useId();

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

    // Lock page scroll while any dialog is open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus in (unless a field already took it with autoFocus) and give it back on close
    const opener = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const fine = window.matchMedia?.("(pointer: fine)").matches;
      const first = fine ? dialog.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea:not([disabled])') : null;
      (first ?? dialog).focus({ preventScroll: true });
    }

    return () => {
      window.removeEventListener("keydown", onKey);
      modalStack.splice(modalStack.indexOf(entry), 1);
      if (modalStack.length === 0) document.body.style.overflow = prevOverflow;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);

  // Hairlines under the header / above the footer appear only when there is more to scroll
  const measure = useCallback(() => {
    const b = bodyRef.current;
    if (!b) return;
    const top = b.scrollTop > 2;
    const bottom = b.scrollTop + b.clientHeight < b.scrollHeight - 2;
    setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
  }, []);
  useEffect(() => {
    measure();
    const b = bodyRef.current;
    if (!b || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    if (b.firstElementChild) ro.observe(b.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);

  // Tab and Shift+Tab cycle inside the dialog
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center dn-backdrop sm:p-6 animate-fade-in" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={description ? `${uid}-desc` : undefined}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={clsx(
          "dn-dialog w-full rounded-t-[22px] sm:rounded-[20px] max-h-[92vh] sm:max-h-[88vh] flex flex-col outline-none animate-sheet-in",
          wide ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Grab handle on phones */}
        <div className="sm:hidden flex justify-center pt-2.5 -mb-1" aria-hidden>
          <span className="w-10 h-1 rounded-full bg-border-bright" />
        </div>
        <div className={clsx("relative flex items-start gap-3.5 px-6 pt-5 pb-4 transition-shadow", edges.top && "shadow-[0_1px_0_var(--dn-border)]")}>
          {Icon && (
            <div className="dn-icon-tile" data-tone={tone}>
              <Icon className="w-5 h-5" />
            </div>
          )}
          <div className="flex-1 min-w-0 pt-px">
            <h2 id={`${uid}-title`} className="text-[17px] leading-6 font-semibold tracking-[-0.02em] text-text-primary break-words">{title}</h2>
            {description && <div id={`${uid}-desc`} className="text-sm text-text-secondary mt-1 leading-relaxed">{description}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="group/close flex items-center gap-1.5 -mr-2 -mt-0.5 p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-card-hover transition-colors"
          >
            <span className="dn-kbd hidden sm:inline-flex opacity-0 group-hover/close:opacity-100 transition-opacity">esc</span>
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>
        <div ref={bodyRef} onScroll={measure} className={clsx("px-6 overflow-y-auto overscroll-contain flex-1 min-h-0", footer ? "pb-5" : "pb-6")}>
          <div>{children}</div>
        </div>
        {footer && (
          <div
            className={clsx(
              "px-6 py-4 rounded-b-[20px] flex justify-end gap-2 flex-wrap border-t transition-colors pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4",
              edges.bottom ? "border-border bg-bg-secondary/60" : "border-border/60 bg-bg-secondary/30",
            )}
          >
            {footer}
          </div>
        )}
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

interface SelectOption { value: string; label: ReactNode; text: string; disabled?: boolean }

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Reads the <option> children (through fragments and arrays) the way a native <select> would */
function readOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>(child)) return;
    if (child.type === Fragment || child.type === "optgroup") {
      out.push(...readOptions(child.props.children));
      return;
    }
    if (child.type !== "option") return;
    const text = textOf(child.props.children);
    out.push({ value: String(child.props.value ?? text), label: child.props.children, text, disabled: child.props.disabled });
  });
  return out;
}

export interface SelectChangeEvent { target: { value: string; name?: string }; currentTarget: { value: string; name?: string } }

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "size" | "multiple"> & {
  onChange?: (e: SelectChangeEvent) => void;
  size?: "sm" | "md";
  /** Shown when the value matches no option */
  placeholder?: string;
};

interface PopoverPos { left: number; width: number; top?: number; bottom?: number; maxHeight: number; up: boolean }

/**
 * Dropdown. A drop-in for <select>: pass <option> children, `value` and `onChange`
 * (which receives `{ target: { value } }`). The menu is a themed listbox with full keyboard
 * support (arrows, Home/End, type to jump, Enter, Escape) and a filter box once there are
 * ten or more options.
 */
export function Select({
  value,
  defaultValue,
  onChange,
  children,
  disabled,
  className,
  size = "md",
  placeholder = "Choose…",
  name,
  id,
  title,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: SelectProps) {
  const options = useMemo(() => readOptions(children), [children]);
  const [inner, setInner] = useState(() => String(defaultValue ?? options[0]?.value ?? ""));
  const current = value !== undefined && value !== null ? String(value) : inner;
  const selected = options.find((o) => o.value === current);

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  const searchable = options.length >= 10;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.text.toLowerCase().includes(q)) : options;
  }, [options, query]);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 6;
    const below = vh - r.bottom - gap - 12;
    const above = r.top - gap - 12;
    const wanted = Math.min(320, options.length * 38 + (searchable ? 52 : 0) + 12);
    const up = below < wanted && above > below;
    const width = Math.min(Math.max(r.width, 180), vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    const maxHeight = Math.max(140, Math.min(320, up ? above : below));
    setPos(up ? { left, width, bottom: vh - r.top + gap, maxHeight, up } : { left, width, top: r.bottom + gap, maxHeight, up });
  }, [options.length, searchable]);

  const firstEnabled = (list: SelectOption[], from: number, step: 1 | -1) => {
    for (let i = from; i >= 0 && i < list.length; i += step) if (!list[i].disabled) return i;
    return -1;
  };

  const openMenu = () => {
    if (disabled) return;
    setQuery("");
    const idx = options.findIndex((o) => o.value === current);
    setActive(idx >= 0 ? idx : firstEnabled(options, 0, 1));
    place();
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (o: SelectOption | undefined) => {
    if (!o || o.disabled) return;
    if (o.value !== current) {
      if (value === undefined || value === null) setInner(o.value);
      const t = { value: o.value, name };
      onChange?.({ target: t, currentTarget: t });
    }
    close();
  };

  // Keep the panel attached to the trigger while anything scrolls or resizes
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      place();
    };
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, place]);

  // Click outside closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Focus the filter box or the list when the panel opens
  useEffect(() => {
    if (!open) return;
    (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [open, searchable]);

  // Keep the highlighted option in view
  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const onPanelKey = (e: React.KeyboardEvent) => {
    const list = shown;
    switch (e.key) {
      case "ArrowDown": {
        e.preventDefault();
        const n = firstEnabled(list, active + 1, 1);
        if (n >= 0) setActive(n);
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const n = firstEnabled(list, Math.min(active, list.length) - 1, -1);
        if (n >= 0) setActive(n);
        return;
      }
      case "Home":
      case "PageUp":
        if (searchable && e.key === "Home") return;
        e.preventDefault();
        setActive(firstEnabled(list, 0, 1));
        return;
      case "End":
      case "PageDown":
        if (searchable && e.key === "End") return;
        e.preventDefault();
        setActive(firstEnabled(list, list.length - 1, -1));
        return;
      case "Enter":
        e.preventDefault();
        choose(list[active]);
        return;
      case " ":
        if (searchable) return;
        e.preventDefault();
        choose(list[active]);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation(); // don't also close the dialog this sits in
        close();
        return;
      case "Tab":
        // Put focus back on the trigger and let the browser carry on from there, so one
        // Tab (or Shift+Tab) leaves the dropdown the way it would a native select
        triggerRef.current?.focus({ preventScroll: true });
        close(false);
        return;
    }
    // Type to jump, like a native select
    if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const q = typed.current.text;
      const start = q.length === 1 ? active + 1 : active;
      const order = [...list.slice(Math.max(0, start)), ...list.slice(0, Math.max(0, start))];
      const hit = order.find((o) => !o.disabled && o.text.toLowerCase().startsWith(q));
      if (hit) setActive(list.indexOf(hit));
    }
  };

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
  };

  const panel = open && pos && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={panelRef}
          className="dn-popover fixed z-[80] flex flex-col overflow-hidden animate-pop-in"
          style={{
            left: pos.left,
            width: pos.width,
            top: pos.top,
            bottom: pos.bottom,
            maxHeight: pos.maxHeight,
            transformOrigin: pos.up ? "bottom center" : "top center",
            ["--dn-pop-from" as string]: pos.up ? "4px" : "-4px",
          }}
          onKeyDown={onPanelKey}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {searchable && (
            <div className="p-1.5 pb-0">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  placeholder="Filter…"
                  aria-label="Filter options"
                  aria-controls={listId}
                  aria-activedescendant={active >= 0 ? optId(active) : undefined}
                  className="dn-input dn-input-sm pl-8"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={ariaLabel ?? title}
            aria-activedescendant={!searchable && active >= 0 ? optId(active) : undefined}
            className="p-1.5 overflow-y-auto outline-none flex-1 min-h-0"
          >
            {shown.length === 0 && <li className="px-3 py-2.5 text-sm text-text-muted">No matches</li>}
            {shown.map((o, i) => {
              const isSel = o.value === current;
              return (
                <li
                  key={`${o.value}-${i}`}
                  id={optId(i)}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  data-active={i === active ? "" : undefined}
                  className="dn-option"
                  onMouseMove={() => i !== active && !o.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                >
                  <span className="flex-1 min-w-0 truncate">{o.label}</span>
                  {isSel && <Check className="w-4 h-4 text-accent flex-shrink-0" strokeWidth={2.5} />}
                </li>
              );
            })}
          </ul>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-open={open ? "" : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
        className={clsx("dn-input dn-select", size === "sm" && "dn-input-sm", className)}
      >
        <span className={clsx("flex-1 min-w-0 truncate", !selected && "text-text-muted")}>{selected ? selected.label : placeholder}</span>
        <ChevronDown className={clsx("w-4 h-4 flex-shrink-0 text-text-muted transition-transform duration-200", open && "rotate-180 text-accent")} />
      </button>
      {name && <input type="hidden" name={name} value={current} />}
      {panel}
    </>
  );
}

export function formatTime(date: string | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="flex gap-1 bg-bg-secondary border border-border rounded-xl p-1 w-fit max-w-full overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx("px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors", value === t.value ? "bg-bg-card text-text-primary shadow-[0_1px_3px_rgba(0,0,0,0.15)] ring-1 ring-border" : "text-text-muted hover:text-text-secondary")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
