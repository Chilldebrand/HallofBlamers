import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * Shared outline button + colored-rule notice box for the commissioner/member form pages (Admin,
 * Polls, Recaps admin) — none of which have a mockup frame (README "Not yet designed" covers
 * these only at the pattern level: header/table/pill/card grammar). Kept the SAME outline-only
 * button shape these pages already had rather than inventing a new filled-kelly "primary button"
 * convention — a Task 24 judgment call (conservative reading, no new design invention) — just
 * retoned onto the sheet-scoped border/bg tokens instead of the chrome-scoped `border-line`/
 * legacy `bg-bg` ones.
 */
export function Button({ className, children, type = "submit", ...rest }: React.ComponentProps<"button">) {
  return (
    <button type={type} {...rest} className={cn("display border border-line-sheet-strong px-4 py-2 text-xs tracking-[0.12em] text-ink hover:border-ink", className)}>
      {children}
    </button>
  );
}

export type NoticeTone = "live" | "kelly" | "ink";

/**
 * A colored-left-rule callout for error/success/neutral banners — reuses the already-established
 * live=error / kelly=positive semantic colors (Standings' Last5Squares/StreakText: kelly=W,
 * live=L) rather than inventing new ones.
 */
export function Notice({ tone, children }: { tone: NoticeTone; children: ReactNode }) {
  const border = tone === "live" ? "border-l-live" : tone === "kelly" ? "border-l-kelly" : "border-l-ink";
  return <div className={cn("border border-line-sheet border-l-[3px] bg-sheet-raised p-4 text-sm text-ink", border)}>{children}</div>;
}
