import { cn } from "@/components/ui/cn";

/**
 * The filled "CHAMPION" badge — the champion-row counterpart to FranchiseName's built-in SACKO
 * badge (docs/design/redesign-2026-08/README.md, Standings "Real tab": "Champion row: 3px gold
 * left rule, sheet-raised fill, gold rank, gold name, CHAMPION badge").
 *
 * Deliberately NOT folded into FranchiseName itself: FranchiseName's own test suite pins
 * "champion: gold name, no badge" (Task 21) — the badge is a summary-context decoration
 * (standings rows, matchup cards) rather than a universal identity mark like the belt cut-out or
 * the SACKO badge, so callers opt in explicitly by rendering this alongside FranchiseName. Same
 * gold-fill + cream-label recipe as the SACKO badge (README "Two golds": a badge label on
 * `--color-gold-fill` is cream `--color-sheet`, not dark ink — true in both themes since
 * `--color-sheet` is always the opposite brightness of the fill).
 */
export function ChampionBadge({ className }: { className?: string }) {
  return (
    <span className={cn("display shrink-0 rounded-[2px] bg-gold-fill px-1.5 py-0.5 text-[10px] tracking-[0.18em] text-sheet", className)}>
      CHAMPION
    </span>
  );
}
