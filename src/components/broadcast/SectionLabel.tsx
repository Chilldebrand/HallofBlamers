import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

export interface SectionLabelProps {
  children: ReactNode;
  className?: string;
}

/**
 * The small muted sub-section label + thin rule grammar already established by the matchup
 * detail page's "Context"/"Series Context" foot headers (`display border-b border-line-sheet-strong
 * pb-2.5 text-[12px] tracking-[0.24em] text-muted` — see matchups/[year]/[week]/[matchupId]/page.tsx).
 * Centralized here for Task 24's extension pages, which had been using an un-bordered
 * `text-xs tracking-[0.2em] text-muted` label with no matching precedent in the redesigned pages —
 * this reuses the SAME classes already shipped, not a new pattern.
 */
export function SectionLabel({ children, className }: SectionLabelProps) {
  return <h2 className={cn("display border-b border-line-sheet-strong pb-2.5 text-[12px] tracking-[0.24em] text-muted", className)}>{children}</h2>;
}
