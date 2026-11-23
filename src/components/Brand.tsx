"use client";

import { clsx } from "clsx";
import { useId } from "react";

/** The DeployNow mark (Ascend): a launch chevron on the encorp.ai gradient tile. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={`${id}bg`} x1="6" y1="4" x2="58" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5FCEF9" />
          <stop offset=".5" stopColor="#1D9CFF" />
          <stop offset="1" stopColor="#2E4FE0" />
        </linearGradient>
        <linearGradient id={`${id}sh`} x1="32" y1="2" x2="32" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" stopOpacity=".35" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${id}bg)`} />
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${id}sh)`} />
      <rect x="2.5" y="2.5" width="59" height="59" rx="15.5" stroke="#fff" strokeOpacity=".25" />
      <path d="M20 35 32 23l12 12" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M23 45h18" stroke="#fff" strokeOpacity=".6" strokeWidth="6" strokeLinecap="round" />
    </svg>
  );
}

/** Official encorp.ai logo; picks the light or dark wordmark for the current theme. */
export function EncorpLogo({ className }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/encorp-logo.svg" alt="encorp.ai" className={clsx("dn-only-light w-auto", className)} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/encorp-logo-white.svg" alt="encorp.ai" className={clsx("dn-only-dark w-auto", className)} />
    </>
  );
}

/** "DeployNow by encorp.ai" lockup */
export function BrandLockup({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const mark = size === "lg" ? "w-14 h-14" : size === "sm" ? "w-7 h-7" : "w-9 h-9";
  const word = size === "lg" ? "text-3xl" : size === "sm" ? "text-[15px]" : "text-[17px]";
  const enc = size === "lg" ? "h-3.5" : "h-2.5";
  return (
    <span className={clsx("inline-flex items-center", size === "lg" ? "gap-4" : "gap-2.5", className)}>
      <LogoMark className={clsx(mark, "flex-shrink-0 drop-shadow-[0_4px_12px_rgba(29,156,255,0.35)]")} />
      <span className="flex flex-col leading-none">
        <span className={clsx(word, "font-semibold tracking-[-0.02em] text-text-primary")}>DeployNow</span>
        {size !== "sm" && (
          <span className={clsx("flex items-center gap-1.5 text-text-muted", size === "lg" ? "text-sm mt-2" : "text-[11px] mt-1")}>
            by <EncorpLogo className={enc} />
          </span>
        )}
      </span>
    </span>
  );
}

/** Small "by encorp.ai" credit line linking to the company site */
export function PoweredBy({ className }: { className?: string }) {
  return (
    <a
      href="https://encorp.ai"
      target="_blank"
      rel="noopener noreferrer"
      className={clsx("inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors", className)}
    >
      DeployNow by <EncorpLogo className="h-3" />
    </a>
  );
}
