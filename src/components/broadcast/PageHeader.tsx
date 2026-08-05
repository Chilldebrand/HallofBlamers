import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface PageHeaderProps {
  title: string;
  eyebrow?: string;
  /** Right-aligned slot — actions, a season picker, etc. */
  right?: ReactNode;
  className?: string;
}

/**
 * The page-level header grammar established by Standings/Matchups (Tasks 22-23, each hand-rolled
 * an identical header rather than touching this shared component — see standings/page.tsx's own
 * docstring on why: at the time, ~25 pages still imported this OLD text-3xl/4xl version, and
 * bumping it then would have half-restyled every page that hadn't been touched yet. Task 24 is the
 * slice that finally restyles every one of those remaining consumers in the same pass, so that
 * reason no longer applies — centralizing here (instead of hand-duplicating the same JSX across
 * ~20 more files) is a Task 24 judgment call, not new design invention: the visual output matches
 * Standings' own header exactly (README, Standings: eyebrow "League", 64px title, right-aligned
 * summary; "Rules: section underline 2px solid ink").
 */
export function PageHeader({ title, eyebrow, right, className }: PageHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-8 border-b-2 border-ink pb-[18px]", className)}>
      <div>
        {eyebrow ? <p className="display text-[12px] tracking-[0.26em] text-kelly">{eyebrow}</p> : null}
        <h1 className="display mt-1.5 text-page-title tracking-normal text-kelly-deep">{title}</h1>
      </div>
      {right ? <div className="shrink-0 pb-1.5">{right}</div> : null}
    </div>
  );
}
