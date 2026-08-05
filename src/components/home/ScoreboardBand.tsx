import Link from "next/link";
import { formatWLT } from "@/components/history/format";
import { FranchiseName, type FranchiseNameFranchise } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { LiveScoreboardBand, type LiveScoreboardCellData } from "@/features/live/LiveScoreboardBand";
import type { IdentityFlags } from "@/server/queries/identity";
import { resolveFranchiseFlags } from "@/server/queries/identity";
import type { InSeasonScoreboard, OffseasonScoreboard, OffseasonScoreboardCell } from "@/server/queries/homepage";

/**
 * Home's scoreboard band (docs/design/redesign-2026-08/README.md, "2. Home") — six chrome cells
 * directly under the ticker. Two variants, picked by the page via the same season-state signal
 * every other season-aware surface uses (computeSeasonPhase): offseason shows the latest complete
 * season's final standings; in-season shows the current week's games, belt game first. Phone
 * "collapses to the two cells that matter" per the README's phone note — implemented as two
 * separate grids (desktop 6-up, phone first-2-only) rather than a CSS reflow, since the mockup's
 * phone cells are genuinely a different subset, not just a narrower version of the same six.
 */

function nameFranchise(id: number, name: string, flags: IdentityFlags): FranchiseNameFranchise {
  return { id, name, ...resolveFranchiseFlags(flags, id) };
}

export function OffseasonScoreboardBand({ data, flags }: { data: OffseasonScoreboard; flags: IdentityFlags }) {
  return (
    <div className="border-b border-line bg-chrome">
      <div className="display border-b border-line px-6 py-2 text-[13px] tracking-[0.2em] text-kelly-bright">{data.season} Final Standings</div>
      <div className="hidden md:grid md:grid-cols-6">
        {data.cells.map((cell) => (
          <OffseasonCell key={cell.franchiseId} cell={cell} flags={flags} />
        ))}
      </div>
      <div className="grid grid-cols-2 md:hidden">
        {data.cells.slice(0, 2).map((cell) => (
          <OffseasonCell key={cell.franchiseId} cell={cell} flags={flags} />
        ))}
      </div>
    </div>
  );
}

function OffseasonCell({ cell, flags }: { cell: OffseasonScoreboardCell; flags: IdentityFlags }) {
  const surface = cell.isChampionCell ? "var(--color-chrome-raised)" : "var(--color-chrome)";
  return (
    <Link
      href={`/franchises/${cell.franchiseId}`}
      className={cn(
        "border-r border-line-soft px-5 py-3 last:border-r-0 transition-colors hover:bg-chrome-raised/60",
        cell.isChampionCell ? "border-t-[3px] border-t-gold-fill bg-chrome-raised" : "border-t-[3px] border-t-transparent",
      )}
    >
      <div className={cn("display text-[11px] tracking-[0.18em]", cell.isChampionCell ? "text-gold-ink" : "text-muted-on-chrome")}>{cell.label}</div>
      <div className="mt-1.5">
        <FranchiseName
          franchise={nameFranchise(cell.franchiseId, cell.franchiseName, flags)}
          size="default"
          surfaceBehind={surface}
          className="display text-[19px] text-ink-on-chrome"
        />
      </div>
      <div className="mt-1 text-[13px] tabular-nums text-muted-on-chrome">
        {formatWLT(cell.wins, cell.losses, cell.ties)} · {cell.pointsFor.toFixed(1)} PF
      </div>
    </Link>
  );
}

/**
 * In-season path (Task 33 wiring wave): bakes each side's identity flags server-side (the ONE
 * thing the client island below can't do itself — `resolveFranchiseFlags` lives under
 * `src/server/`) into plain, serializable cell data, then hands off to `LiveScoreboardBand`
 * (`src/features/live/`) for the live-updating render. That client component's OWN initial React
 * render (before hydration) produces the exact same markup this function used to render directly
 * — see its docstring — so removing this wrapper doesn't change the JS-disabled baseline.
 */
export function InSeasonScoreboardBand({ data, flags }: { data: InSeasonScoreboard; flags: IdentityFlags }) {
  const cells: LiveScoreboardCellData[] = data.cells.map((cell) => ({
    matchupId: cell.matchupId,
    isBeltGame: cell.isBeltGame,
    isViewerGame: cell.isViewerGame,
    isFinal: cell.isFinal,
    home: { franchiseId: cell.home.franchiseId, name: cell.home.name, score: cell.home.score, flags: resolveFranchiseFlags(flags, cell.home.franchiseId) },
    away: cell.away
      ? { franchiseId: cell.away.franchiseId, name: cell.away.name, score: cell.away.score, flags: resolveFranchiseFlags(flags, cell.away.franchiseId) }
      : null,
  }));

  return <LiveScoreboardBand season={data.season} week={data.week} cells={cells} />;
}
