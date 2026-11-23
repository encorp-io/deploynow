"use client";

import type { ReactNode } from "react";
import { clsx } from "clsx";
import { BrandLockup, EncorpLogo } from "./Brand";

/**
 * Frame for the signed-out pages (sign in, invite setup, first-run setup):
 * the brand lockup, a glass card on a soft brand glow, and the encorp.ai credit.
 */
export default function AuthShell({ title, subtitle, children, wide }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center px-4 py-10 overflow-hidden">
      {/* Backdrop: brand glow and a faint grid */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-[-260px] -translate-x-1/2 w-[900px] h-[600px] rounded-full bg-accent/20 blur-[120px] opacity-60" />
        <div className="absolute right-[-200px] bottom-[-200px] w-[600px] h-[500px] rounded-full bg-accent-deep/20 blur-[120px] opacity-50" />
        <div
          className="absolute inset-0 opacity-[0.35] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]"
          style={{
            backgroundImage:
              "linear-gradient(var(--dn-border) 1px, transparent 1px), linear-gradient(90deg, var(--dn-border) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
      </div>

      <div className={clsx("relative w-full animate-page-in", wide ? "max-w-2xl" : "max-w-[400px]")}>
        <div className="flex justify-center mb-8">
          <BrandLockup size="lg" />
        </div>
        <div className="dn-surface dn-glass border border-border rounded-3xl p-7 sm:p-8 shadow-[var(--dn-shadow-lg)]">
          <div className="text-center mb-6">
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-text-primary">{title}</h1>
            {subtitle && <p className="text-sm text-text-secondary mt-1.5">{subtitle}</p>}
          </div>
          {children}
        </div>
      </div>

      <a
        href="https://encorp.ai"
        target="_blank"
        rel="noopener noreferrer"
        className="relative mt-10 inline-flex items-center gap-2 text-xs text-text-muted hover:text-text-secondary transition-colors"
      >
        Built by <EncorpLogo className="h-3.5" />
      </a>
    </div>
  );
}

export const authInputClass =
  "w-full px-3.5 py-2.5 bg-bg-secondary border border-border rounded-xl text-sm text-text-primary placeholder:text-text-muted/80 shadow-[inset_0_1px_2px_rgba(0,0,0,0.06)] hover:border-border-bright focus:outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/20 transition-[border-color,box-shadow]";

export const authPrimaryClass =
  "w-full py-2.5 dn-btn-primary text-white rounded-xl text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2";

export const authSecondaryClass =
  "w-full py-2.5 border border-border bg-bg-card hover:bg-bg-card-hover hover:border-border-bright rounded-xl text-sm text-text-primary flex items-center justify-center gap-2 transition-colors disabled:opacity-50";
