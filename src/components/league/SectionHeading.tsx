import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface SectionHeadingProps {
  children: ReactNode;
  /** Right-aligned meta text, e.g. "3 reigns · 8 defenses · 19 weeks held" (Franchise Belt History) or
   * "2018 – 2026 · peak 1651 in 2025 Wk 16" (Franchise Elo History). */
  right?: ReactNode;
  /** A mark preceding the heading text — e.g. Belt History's belt mark. */
  icon?: ReactNode;
  className?: string;
}

/**
 * The 24px section-heading grammar (README "Typography": "Section heading — Barlow Condensed
 * 700, 24px, uppercase, tracking 0.06em"; "Other values — Rules: section underline 2px solid
 * ink"). Used across the franchise profile for Elo History / Season by Season / Belt History /
 * Record Book Entries / Head-to-Head. First use of the `text-section-heading`/
 * `tracking-section-heading` theme tokens declared in globals.css back in Task 21 but unused
 * until this task's pages needed them.
 */
export function SectionHeading({ children, right, icon, className }: SectionHeadingProps) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-3 border-b-2 border-ink pb-2.5", className)}>
      <span className="display flex items-center gap-2.5 text-section-heading tracking-section-heading text-ink">
        {icon}
        {children}
      </span>
      {right ? <span className="text-[14px] text-muted">{right}</span> : null}
    </div>
  );
}
