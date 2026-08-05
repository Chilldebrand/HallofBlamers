import { cn } from "@/components/ui/cn";

/**
 * The shared identity system (docs/design/redesign-2026-08/README.md,
 * "Identity system") — four states, four signals, no collisions, always
 * data-driven (never hand-applied):
 *   - champion: name renders in gold wherever it appears.
 *   - belt holder: a gold belt mark immediately before the name.
 *   - sacko: tarnish name + a filled SACKO badge.
 *   - viewer ("you"): a small kelly "YOU" tag after the name.
 * Flags are resolved server-side (see src/server/queries/identity.ts's
 * getIdentityFlags/resolveFranchiseFlags) and passed in already-computed —
 * this component never queries the DB itself.
 *
 * Exemption (README): the home page's hero headline stays kelly even for
 * the champion's name — gold fails contrast at headline size on the cream
 * sheet. That's a caller-level choice (don't route the hero headline
 * through this component); FranchiseName itself always applies the full
 * identity treatment, since every other context (lists, tables, tickers,
 * cards, profile headers) wants it.
 */
export interface FranchiseNameFlags {
  isChampion: boolean;
  holdsBelt: boolean;
  isSacko: boolean;
  isViewer: boolean;
}

export interface FranchiseNameFranchise extends FranchiseNameFlags {
  id: number;
  name: string;
}

/**
 * Belt mark size, keyed to the six surfaces README specifies exact pixel
 * dimensions for. Also governs the SACKO badge / YOU tag scale, since all
 * three marks appear together at a given surface's density.
 */
export type FranchiseNameSize = "beltCard" | "matchupHeader" | "heading" | "default" | "inline" | "row";

export interface FranchiseNameProps {
  franchise: FranchiseNameFranchise;
  /** @default "default" — the 24x11 belt mark, README's general-purpose size. */
  size?: FranchiseNameSize;
  /**
   * CSS color value for the belt mark's cut-out diamond — must match the
   * actual surface immediately behind this component so the cut-out reads
   * correctly (README: "the color of the surface behind the mark"). Default
   * assumes the cream content sheet; pass e.g. "var(--color-chrome-deep)"
   * when rendering on chrome (ticker, nav, bands) or
   * "var(--color-sheet-raised)" on a raised/highlighted row.
   */
  surfaceBehind?: string;
  className?: string;
}

// width x height, per README's belt-mark size list.
const MARK_SIZE_CLASSES: Record<FranchiseNameSize, string> = {
  beltCard: "h-[20px] w-[44px]",
  matchupHeader: "h-[14px] w-[30px]",
  heading: "h-[12px] w-[26px]",
  default: "h-[11px] w-[24px]",
  inline: "h-[10px] w-[22px]",
  row: "h-[9px] w-[20px]",
};

// Inner cut-out diamond, scaled proportionally from the 24x11 -> 8x8 recipe.
const DIAMOND_SIZE_CLASSES: Record<FranchiseNameSize, string> = {
  beltCard: "h-[14px] w-[14px]",
  matchupHeader: "h-[10px] w-[10px]",
  heading: "h-[9px] w-[9px]",
  default: "h-[8px] w-[8px]",
  inline: "h-[7px] w-[7px]",
  row: "h-[6px] w-[6px]",
};

const TAG_TEXT_CLASSES: Record<FranchiseNameSize, string> = {
  beltCard: "text-[13px] tracking-[0.14em]",
  matchupHeader: "text-[11px] tracking-[0.16em]",
  heading: "text-[10px] tracking-[0.17em]",
  default: "text-[10px] tracking-[0.17em]",
  inline: "text-[9px] tracking-[0.16em]",
  row: "text-[9px] tracking-[0.16em]",
};

/**
 * The gold belt mark: a solid gold bar with a diamond "buckle" knocked out
 * of it, built from two elements — no icon font, no SVG. Two-element recipe
 * per README verbatim: outer bar (gold-fill, rounded-[2px]), inner diamond
 * rotated 45deg and colored to match the surface behind it.
 *
 * Exported (Task 23) for callers that need the mark WITHOUT a franchise name
 * attached — e.g. a matchup card's status row ("Belt at stake") or the
 * matchup detail score head's eyebrow, where the mark precedes a role label
 * rather than a name. `FranchiseName` itself still renders this internally
 * for the name-attached case; this export doesn't change that.
 */
export function BeltMark({ size, surfaceBehind }: { size: FranchiseNameSize; surfaceBehind: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex shrink-0 items-center justify-center rounded-[2px] bg-gold-fill", MARK_SIZE_CLASSES[size])}
    >
      <span className={cn("rotate-45", DIAMOND_SIZE_CLASSES[size])} style={{ background: surfaceBehind }} />
    </span>
  );
}

export function FranchiseName({ franchise, size = "default", surfaceBehind = "var(--color-sheet)", className }: FranchiseNameProps) {
  const { name, isChampion, holdsBelt, isSacko, isViewer } = franchise;

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5", className)}>
      {holdsBelt ? <BeltMark size={size} surfaceBehind={surfaceBehind} /> : null}
      <span className={cn("truncate", isChampion ? "text-gold-ink" : isSacko ? "text-tarnish-ink" : undefined)}>{name}</span>
      {isSacko ? (
        <span className={cn("display shrink-0 rounded-[2px] bg-tarnish-fill px-1.5 py-0.5 text-sheet", TAG_TEXT_CLASSES[size])}>SACKO</span>
      ) : null}
      {isViewer ? <span className={cn("display shrink-0 text-kelly", TAG_TEXT_CLASSES[size])}>· YOU</span> : null}
    </span>
  );
}
