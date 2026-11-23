"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { Button, Input, Modal } from "./ui";

/* ── Confirm dialog ───────────────────────────────────────────────────────── */

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  /** Label of the confirm button. Defaults to "Confirm" */
  confirmLabel?: string;
  /** Red confirm button for destructive actions. Defaults to true */
  danger?: boolean;
  /** When set, the user must type this text before the button is enabled */
  typeToConfirm?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * `const confirm = useConfirm(); if (!(await confirm({ title: "Remove x?" }))) return;`
 * Falls back to the browser's confirm() outside the app shell.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return ctx ?? (async (o) => window.confirm(typeof o.message === "string" ? `${o.title}\n\n${o.message}` : o.title));
}

function ConfirmDialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const [typed, setTyped] = useState("");
  const danger = opts.danger ?? true;
  const blocked = !!opts.typeToConfirm && typed.trim() !== opts.typeToConfirm;
  return (
    <Modal title={opts.title} onClose={() => onDone(false)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) onDone(true);
        }}
        className="space-y-4"
      >
        {opts.message && <div className="text-sm text-text-secondary">{opts.message}</div>}
        {opts.typeToConfirm && (
          <label className="block">
            <span className="block text-xs text-text-secondary mb-1.5">
              Type <code className="text-text-primary font-mono">{opts.typeToConfirm}</code> to confirm
            </span>
            <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onDone(false)}>Cancel</Button>
          <Button type="submit" variant={danger ? "danger-solid" : "primary"} disabled={blocked} autoFocus={!opts.typeToConfirm}>
            {opts.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Toasts ───────────────────────────────────────────────────────────────── */

type ToastTone = "success" | "error" | "info" | "warning";
interface ToastItem { id: number; tone: ToastTone; text: ReactNode }
interface ToastApi {
  success: (text: ReactNode) => void;
  error: (text: ReactNode) => void;
  info: (text: ReactNode) => void;
  warning: (text: ReactNode) => void;
}
const ToastContext = createContext<ToastApi | null>(null);

const noopToast: ToastApi = { success: () => {}, error: () => {}, info: () => {}, warning: () => {} };

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noopToast;
}

const TOAST_ICON = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle } as const;

function Toast({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, item.tone === "error" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [item, onClose]);
  const Icon = TOAST_ICON[item.tone];
  return (
    <div
      role={item.tone === "error" ? "alert" : "status"}
      className="pointer-events-auto flex items-start gap-3 w-full sm:w-96 bg-bg-card border border-border-bright rounded-xl shadow-2xl shadow-black/40 px-4 py-3 animate-toast-in"
    >
      <Icon
        className={clsx(
          "w-5 h-5 flex-shrink-0 mt-px",
          item.tone === "success" && "text-success",
          item.tone === "error" && "text-danger",
          item.tone === "warning" && "text-warning",
          item.tone === "info" && "text-accent",
        )}
      />
      <div className="flex-1 text-sm text-text-primary break-words">{item.text}</div>
      <button onClick={onClose} aria-label="Dismiss" className="text-text-muted hover:text-text-primary">
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

/* ── Provider ─────────────────────────────────────────────────────────────── */

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const confirm = useCallback<ConfirmFn>(
    (opts) => new Promise<boolean>((resolve) => setConfirmState({ opts, resolve })),
    [],
  );

  const push = useCallback((tone: ToastTone, text: ReactNode) => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
  }, []);
  const [toastApi] = useState<ToastApi>(() => ({
    success: (t) => push("success", t),
    error: (t) => push("error", t),
    info: (t) => push("info", t),
    warning: (t) => push("warning", t),
  }));
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  return (
    <ConfirmContext.Provider value={confirm}>
      <ToastContext.Provider value={toastApi}>
        {children}
        {confirmState && (
          <ConfirmDialog
            opts={confirmState.opts}
            onDone={(ok) => {
              confirmState.resolve(ok);
              setConfirmState(null);
            }}
          />
        )}
        <div className="fixed z-[60] bottom-4 inset-x-4 sm:inset-x-auto sm:right-4 flex flex-col gap-2 items-end pointer-events-none" aria-live="polite">
          {toasts.map((t) => (
            <Toast key={t.id} item={t} onClose={() => dismiss(t.id)} />
          ))}
        </div>
      </ToastContext.Provider>
    </ConfirmContext.Provider>
  );
}
