import Link from "next/link";
import { BeltMark, FranchiseName, type FranchiseNameFlags } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";

/**
 * Week hub matchup card — docs/design/redesign-2026-08/README.md, Matchups §Week hub. Restyled
 * for Task 23 (kelly-green redesign); still framework-boundary-agnostic per the original brief
 * (no "use client"/server import, every prop already resolved by the caller) — only used by the
 * week hub page (src/app/(league)/matchups/[year]/[week]/page.tsx), not shared with Home.
 */
export interface MatchupCardTeam {
  franchiseId: number;
  name: string;
  /** null = not final yet (unplayed/in-progress) — never a fabricated 0. */
  score: number | null;
  projected: number | null;
  flags: FranchiseNameFlags;
}

export type MatchupCardStatus =
  | { kind: "final" }
  | { kind: "live"; startersRemaining: number | null }
  | { kind: "upcoming" };

export interface MatchupCardProps {
  href: string;
  home: MatchupCardTeam;
  /** null = a bye (no opponent that week). */
  away: MatchupCardTeam | null;
  status: MatchupCardStatus;
  beltAtStake: boolean;
  /**
   * "belt" = the raised, gold-top-rule card (README: belt game leads, first position); "viewer" =
   * kelly left-rule (second position, when the belt game isn't the viewer's own); "normal" = plain
   * card. The caller derives this the same way `sortWeekHubCards` ranks cards — kept as a separate
   * prop rather than re-deriving from `beltAtStake`/`isViewerGame` here so a future ranking tweak
   * (e.g. a third tier) doesn't have to touch this component.
   */
  emphasis: "belt" | "viewer" | "normal";
  /**
   * The status row's LEFT label when `beltAtStake` — "Belt at stake · your game" pre-final, or
   * "Belt Defended"/"Belt Changes Hands" once decided (the caller knows `beltResult`, this
   * component doesn't). Ignored when `beltAtStake` is false.
   */
  beltLabel?: string;
  /** "Top Score" / "Blowout" / "Closest Game" — only shown once the game is FINAL (README: the
   * status row's right slot is the live indicator pre-final, a superlative tag post-final). */
  superlativeLabel?: string | null;
  note?: string | null;
  className?: string;
}

export function MatchupCard({ href, home, away, status, beltAtStake, beltLabel, emphasis, superlativeLabel, note, className }: MatchupCardProps) {
  const decided = status.kind === "final" && away !== null && home.score !== null && away.score !== null;
  const homeWins = decided && home.score! > away!.score!;
  const awayWins = decided && away!.score! > home.score!;
  const surfaceBehind = emphasis === "belt" ? "var(--color-sheet-raised)" : "var(--color-sheet)";

  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col gap-4 border border-line-sheet px-6 py-[22px] transition-colors hover:border-ink",
        emphasis === "belt" ? "border-t-[3px] border-t-gold-fill bg-sheet-raised" : "bg-sheet",
        emphasis === "viewer" ? "border-l-[3px] border-l-kelly" : "",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          {beltAtStake ? <BeltMark size="matchupHeader" surfaceBehind={surfaceBehind} /> : null}
          <span className={cn("display text-[12px] tracking-[0.2em]", beltAtStake ? "text-gold-ink" : "text-muted")}>
            {beltAtStake
              ? (beltLabel ?? "Belt at stake")
              : status.kind === "final"
                ? "Final"
                : status.kind === "upcoming"
                  ? "Upcoming"
                  : "Live"}
          </span>
        </span>
        {status.kind === "live" ? (
          <span className="display flex items-center gap-1.5 text-[11px] tracking-[0.16em] text-live">
            <span className="wbb-blink h-1.5 w-1.5 shrink-0 rounded-full bg-live" aria-hidden="true" />
            {status.startersRemaining !== null ? `${status.startersRemaining} to play` : "Live"}
          </span>
        ) : status.kind === "final" && superlativeLabel ? (
          <span className="display text-[11px] tracking-[0.16em] text-muted">{superlativeLabel}</span>
        ) : null}
      </div>

      <div className="flex flex-col">
        <TeamRow team={home} isWinner={homeWins} decided={decided} surfaceBehind={surfaceBehind} first />
        {away ? (
          <TeamRow team={away} isWinner={awayWins} decided={decided} surfaceBehind={surfaceBehind} />
        ) : (
          <p className="border-t border-line-sheet-soft py-[9px] text-sm text-muted">Bye</p>
        )}
      </div>

      {note ? <p className="border-t border-line-sheet-soft pt-3 text-sm leading-[1.5] text-muted">{note}</p> : null}
    </Link>
  );
}

function TeamRow({
  team,
  isWinner,
  decided,
  surfaceBehind,
  first = false,
}: {
  team: MatchupCardTeam;
  isWinner: boolean;
  decided: boolean;
  surfaceBehind: string;
  first?: boolean;
}) {
  const trailing = decided && !isWinner;
  return (
    <div className={cn("flex items-baseline justify-between gap-4 border-line-sheet-soft py-[9px]", first ? "" : "border-t")}>
      <FranchiseName
        franchise={{ id: team.franchiseId, name: team.name, ...team.flags }}
        surfaceBehind={surfaceBehind}
        className={cn("display text-[24px] font-bold", trailing ? "text-ink-trailing" : "text-ink")}
      />
      <span className={cn("display shrink-0 text-[30px] font-bold tabular-nums", decided ? (isWinner ? "text-kelly-deep" : "text-ink-trailing") : "text-ink")}>
        {team.score !== null ? team.score.toFixed(1) : team.projected !== null ? `${team.projected.toFixed(1)} proj.` : "—"}
      </span>
    </div>
  );
}
