import { cn } from "@/components/ui/cn";

export type StatChipVariant = "default" | "gold";

export interface StatChipProps {
  label: string;
  value: string | number;
  /** `gold` is reserved for the identity system's champion/belt context — see
   * docs/design/redesign-2026-08/README.md's "Identity system". */
  variant?: StatChipVariant;
  className?: string;
}

/**
 * Tiny label+value pair for card corners — e.g. "Defenses  3", "PF  1490.2". Fix round 1, finding
 * 6: an adversarial review pass initially (incorrectly) concluded this component had gone dead
 * after Task 24's H2H work — re-checked with fresh eyes: it's still the H2H pair page's 5
 * headline stats (Regular Season/Playoffs/Points/Avg Margin), its only consumer. Retoned in
 * place rather than migrated: `.display` was missing from the value (same bug class as findings
 * 1-2 — headline-scale text silently rendering in Inter instead of Barlow Condensed), and
 * `text-gold` (legacy alias) swapped for the semantic `text-gold-ink` token used everywhere else
 * post-Task-24.
 */
export function StatChip({ label, value, variant = "default", className }: StatChipProps) {
  return (
    <div className={cn("inline-flex flex-col items-start", className)}>
      <span className="display text-[10px] tracking-[0.16em] text-muted">{label}</span>
      <span className={cn("display text-sm font-semibold tabular-nums", variant === "gold" ? "text-gold-ink" : "text-ink")}>{value}</span>
    </div>
  );
}
