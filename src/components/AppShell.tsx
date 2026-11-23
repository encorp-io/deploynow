"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import Sidebar from "./Sidebar";
import { Button, ErrorText, Input, Modal } from "./ui";

type ApiResult<T> = { ok: boolean; status: number; data: T & { error?: string } };
type ApiFn = <T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }) => Promise<ApiResult<T>>;

const ApiContext = createContext<ApiFn | null>(null);

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
      <div className="min-h-screen">
        <Sidebar onSignOut={handleSignOut} />
        <main className="ml-64 p-8">{children}</main>
      </div>
      {prompt && (
        <Modal title="Confirm it's you" onClose={cancel}>
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
    </ApiContext.Provider>
  );
}
