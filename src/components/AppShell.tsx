"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Menu, ShieldCheck, X } from "lucide-react";
import { BrandLockup } from "./Brand";
import Sidebar, { type Me } from "./Sidebar";
import { FeedbackProvider } from "./feedback";
import { UpdateBanner } from "./Updates";
import { Button, ErrorText, Input, Modal } from "./ui";

type ApiResult<T> = { ok: boolean; status: number; data: T & { error?: string } };
type ApiFn = <T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) => Promise<ApiResult<T>>;

const ApiContext = createContext<ApiFn | null>(null);
const RefreshAccountContext = createContext<() => void>(() => {});

/** Re-read /api/account for the shell (sidebar), e.g. after 2FA was turned on. */
export function useRefreshAccount(): () => void {
  return useContext(RefreshAccountContext);
}

/**
 * JSON fetch that handles the step-up prompt: when the server answers
 * "confirm your authentication code", it asks for the code and retries once.
 */
export function useApi(): ApiFn {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside AppShell");
  return api;
}

export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const loadMe = useCallback(() => {
    fetch("/api/account", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => {});
  }, []);
  useEffect(loadMe, [loadMe]);

  // Close the phone menu whenever the page changes
  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  const [prompt, setPrompt] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const askForCode = () =>
    new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setCode("");
      setError("");
      setPrompt(true);
    });

  const api = useCallback<ApiFn>(async (url, init) => {
    const run = async () => {
      const res = await fetch(url, {
        method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
        headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      let data: Record<string, unknown> = {};
      try {
        data = await res.json();
      } catch {
        /* empty body */
      }
      return { ok: res.ok, status: res.status, data };
    };
    let result = await run();
    if (result.status === 403 && result.data.stepUpRequired) {
      if (await askForCode()) result = await run();
    }
    if (result.status === 403 && result.data.mfaSetupRequired) router.push("/account?setup=2fa");
    return result as ApiResult<never>;
  }, [router]);

  async function confirm() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/account/step-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (res.ok) {
      setPrompt(false);
      pending.current?.(true);
    } else {
      setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Code is wrong");
    }
  }

  function cancel() {
    setPrompt(false);
    pending.current?.(false);
  }

  async function handleSignOut() {
    await signOut({ redirect: false });
    router.push("/login");
  }

  return (
    <ApiContext.Provider value={api}>
     <RefreshAccountContext.Provider value={loadMe}>
     <FeedbackProvider>
      <div className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:px-3 focus:py-2 focus:bg-accent focus:text-white focus:rounded-lg">
          Skip to content
        </a>

        {/* Desktop: fixed sidebar */}
        <aside className="hidden lg:block fixed inset-y-0 left-0 w-64 z-30">
          <Sidebar me={me} onSignOut={handleSignOut} />
        </aside>

        {/* Phones and tablets: top bar and a slide-out menu */}
        <header className="lg:hidden sticky top-0 z-30 flex items-center gap-3 h-14 px-4 dn-glass border-b border-border">
          <button onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen} className="p-1.5 -ml-1.5 rounded-lg text-text-secondary hover:text-text-primary hover:bg-bg-card">
            <Menu className="w-5 h-5" />
          </button>
          <Link href="/projects" aria-label="DeployNow, home" className="flex items-center">
            <BrandLockup size="sm" />
          </Link>
        </header>
        {menuOpen && (
          <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Menu">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => setMenuOpen(false)} />
            <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-drawer-in shadow-2xl">
              <Sidebar me={me} onSignOut={handleSignOut} onNavigate={() => setMenuOpen(false)} />
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu" className="absolute top-4 -right-11 p-1.5 rounded-lg bg-bg-secondary border border-border text-text-secondary">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        <main id="main" className="lg:ml-64 px-4 py-6 sm:px-6 lg:px-10 lg:py-10 min-w-0">
          <UpdateBanner role={me?.role} />
          {children}
        </main>
      </div>
      {prompt && (
        <Modal icon={ShieldCheck} title="Confirm it's you" onClose={cancel}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirm();
            }}
            className="space-y-4"
          >
            <p className="text-sm text-text-secondary">
              This action needs a fresh code from your authenticator app (or a recovery code). You won&apos;t be asked
              again for 10 minutes.
            </p>
            <Input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
              <Button type="submit" loading={busy}>Confirm</Button>
            </div>
          </form>
        </Modal>
      )}
     </FeedbackProvider>
     </RefreshAccountContext.Provider>
    </ApiContext.Provider>
  );
}
