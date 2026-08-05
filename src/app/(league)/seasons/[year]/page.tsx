import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { cn } from "@/components/ui/cn";
import { formatEfficiency, formatPts, formatSigned, formatWLT, playoffTierLabel } from "@/components/history/format";
import {
  getSeasonBeltActivity,
  getSeasonDraftBoard,
  getSeasonStandings,
  getSeasonSuperlatives,
  getSeasonWeeks,
  type DraftPickCell,
} from "@/server/queries/seasons";

const STANDINGS_GRID = "grid-cols-[44px_1fr_100px_92px_92px_100px_84px_96px_84px]";

export default async function SeasonDetailPage({ params }: { params: Promise<{ year: string }> }) {
  const { year: yearParam } = await params;
  const year = Number(yearParam);
  if (!Number.isInteger(year)) notFound();

  const standings = getSeasonStandings(year);
  const weeks = getSeasonWeeks(year);
  const draftBoard = getSeasonDraftBoard(year);
  const beltActivity = getSeasonBeltActivity(year);
  const superlatives = getSeasonSuperlatives(year);

  // A year with none of these means the season truly doesn't exist in the DB (vs. a real
  // 'upcoming' season, which still has a draft board — see 2026).
  if (standings.length === 0 && weeks.length === 0 && draftBoard.grid.length === 0) notFound();

  // `final_standing` is ESPN's placeholder 0 for the entire duration of a season that hasn't
  // finished yet (not just before it starts) — team_seasons/season_stats rows exist the moment
  // the season is created (e.g. 2026: 12 rows, all 0-0-0), so "standings.length === 0" alone
  // can't detect that. Never display a fabricated all-0 "standings" table.
  const seasonStarted = standings.some((row) => row.wins + row.losses + row.ties > 0);

  return (
    <div className="flex flex-col gap-12">
      <PageHeader eyebrow="Season" title={`${year}`} />

      <section className="flex flex-col gap-4">
        <SectionLabel>Final Standings</SectionLabel>
        {!seasonStarted ? (
          <p className="text-sm text-muted">Season hasn&apos;t started yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <div role="table" className="min-w-[820px]">
              <div role="row" className={cn("grid border-b-2 border-ink pb-2.5", STANDINGS_GRID)}>
                {["#", "Franchise", "W-L-T", "PF", "PA", "All-Play", "Luck", "Efficiency", "Playoffs"].map((h, i) => (
                  <span key={h} role="columnheader" className={cn("display text-[11px] tracking-[0.16em] text-muted", i > 1 ? "text-right" : "")}>
                    {h}
                  </span>
                ))}
              </div>
              {standings.map((row) => {
                const shell = row.champion
                  ? "border-l-[3px] border-l-gold-fill bg-sheet-raised -ml-[15px] pl-3"
                  : row.sacko
                    ? "border-l-[3px] border-l-tarnish-fill -ml-[15px] pl-3"
                    : "";
                return (
                  <div key={row.franchiseId} role="row" className={cn("grid items-center border-b border-line-sheet py-[11px] text-[14px]", STANDINGS_GRID, shell)}>
                    <span role="cell" className={cn("font-bold tabular-nums", row.champion ? "text-gold-ink" : "text-muted")}>
                      {row.finalStanding && row.finalStanding > 0 ? row.finalStanding : "—"}
                    </span>
                    <span role="cell" className="flex min-w-0 items-center gap-2">
                      <Link href={`/franchises/${row.franchiseId}`} className={cn("truncate hover:underline", row.champion ? "text-gold-ink" : row.sacko ? "text-tarnish-ink" : "text-ink")}>
                        {row.franchiseName}
                      </Link>
                      {/* "Champ" (not "Champion") matches Franchise.dc.html's own season-row Finish-cell
                          tag verbatim (9px, same role) — see franchises/[id]/page.tsx's FinishTag,
                          which this mirrors for consistency across the two nearly-identical widgets. */}
                      {row.champion ? (
                        <span className="display shrink-0 px-1.5 py-0.5 text-[9px] tracking-[0.16em] text-sheet bg-gold-fill">Champ</span>
                      ) : null}
                      {row.sacko ? <span className="display shrink-0 px-1.5 py-0.5 text-[9px] tracking-[0.16em] text-sheet bg-tarnish-fill">Sacko</span> : null}
                    </span>
                    <span role="cell" className="text-right tabular-nums text-ink">{formatWLT(row.wins, row.losses, row.ties)}</span>
                    <span role="cell" className="text-right tabular-nums text-ink">{row.pointsFor.toFixed(1)}</span>
                    <span role="cell" className="text-right tabular-nums text-muted">{row.pointsAgainst.toFixed(1)}</span>
                    <span role="cell" className="text-right tabular-nums text-muted">{formatWLT(row.allplayW, row.allplayL, row.allplayT)}</span>
                    <span role="cell" className="text-right tabular-nums text-muted">{row.luckTotal !== null ? formatSigned(row.luckTotal) : "—"}</span>
                    <span role="cell" className="text-right tabular-nums text-muted">{formatEfficiency(row.efficiencyAvg)}</span>
                    <span role="cell" className="text-right text-muted">{row.madePlayoffs ? "Yes" : "—"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Season Superlatives</SectionLabel>
        {superlatives.highestWeek || superlatives.biggestBlowout || superlatives.closestGame ? (
          <div className="grid grid-cols-1 gap-px border border-line-sheet bg-line-sheet sm:grid-cols-3">
            <SuperlativeCell
              label="Highest Week"
              value={superlatives.highestWeek ? `${superlatives.highestWeek.franchiseName} — ${formatPts(superlatives.highestWeek.value)} (Wk ${superlatives.highestWeek.week})` : "—"}
            />
            <SuperlativeCell
              label="Biggest Blowout"
              value={
                superlatives.biggestBlowout
                  ? `${superlatives.biggestBlowout.winnerName} over ${superlatives.biggestBlowout.loserName} by ${formatPts(superlatives.biggestBlowout.margin)} (Wk ${superlatives.biggestBlowout.week})`
                  : "—"
              }
            />
            <SuperlativeCell
              label="Closest Game"
              value={
                superlatives.closestGame
                  ? `${superlatives.closestGame.aName} vs. ${superlatives.closestGame.bName} — margin ${formatPts(superlatives.closestGame.margin)} (Wk ${superlatives.closestGame.week})`
                  : "—"
              }
            />
          </div>
        ) : (
          <p className="text-sm text-muted">No games played yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Weekly Results</SectionLabel>
        {weeks.length === 0 ? (
          <p className="text-sm text-muted">Schedule not yet set.</p>
        ) : (
          <div className="flex flex-col gap-5">
            {weeks.map((w) => (
              <div key={w.week} className="border-b border-line-sheet-soft pb-4 last:border-b-0">
                <div className="mb-2.5 flex items-center gap-2">
                  <p className="display text-[13px] tracking-[0.16em] text-ink">Week {w.week}</p>
                  {w.weekType !== "regular" ? (
                    <span className="display rounded-full border border-line-sheet-strong px-2 py-0.5 text-[10px] tracking-wide text-muted">{w.weekType === "playoff" ? "Playoff" : w.weekType}</span>
                  ) : null}
                </div>
                <div className="flex flex-col gap-2">
                  {w.matchups.map((m, i) => {
                    const tierLabel = playoffTierLabel(m.playoffTier);
                    return (
                      <div key={i} className="flex flex-wrap items-center justify-between gap-2 border-t border-line-sheet-soft pt-2 first:border-0 first:pt-0">
                        <span className="text-ink">
                          <Link href={`/franchises/${m.homeFranchiseId}`} className="hover:underline">
                            {m.homeFranchiseName}
                          </Link>
                        </span>
                        <span className="tabular-nums text-ink">
                          {/* A scheduled-but-unplayed matchup (real 2026 case: schedule exists, no
                              scores yet) has home/away score 0 — never render that as if it were a
                              real final 0.0-0.0. */}
                          {m.isFinal ? `${m.homeScore.toFixed(1)} – ${m.awayScore.toFixed(1)}` : "vs."}
                        </span>
                        <span className="text-ink">
                          {m.awayFranchiseId ? (
                            <Link href={`/franchises/${m.awayFranchiseId}`} className="hover:underline">
                              {m.awayFranchiseName}
                            </Link>
                          ) : (
                            "Bye"
                          )}
                        </span>
                        {tierLabel ? <span className="display rounded-full border border-line-sheet-strong px-2 py-0.5 text-[10px] tracking-wide text-muted">{tierLabel}</span> : null}
                      </div>
                    );
                  })}
                  {w.matchups.length === 0 ? <p className="text-sm text-muted">No matchups.</p> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Belt Activity</SectionLabel>
        {beltActivity.length === 0 ? (
          <p className="text-sm text-muted">No belt matches this season.</p>
        ) : (
          <div className="flex flex-col">
            {beltActivity.map((b, i) => (
              <div key={i} className="flex flex-wrap items-center justify-between gap-3 border-b border-line-sheet-soft py-3 last:border-b-0">
                <span className="text-[14px] text-ink">
                  Week {b.week} — {b.holderName} vs. {b.challengerName}
                </span>
                <span className="tabular-nums text-[14px] text-muted">
                  {b.holderScore.toFixed(1)} – {b.challengerScore.toFixed(1)}
                </span>
                <span className={cn("display text-[11px] tracking-[0.16em]", b.result === "transfer" ? "text-gold-ink" : "text-muted")}>
                  {b.result === "transfer" ? "Belt Changes Hands" : "Defense"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionLabel>Draft Board</SectionLabel>
        {draftBoard.grid.length === 0 ? <p className="text-sm text-muted">Draft not yet held.</p> : <DraftBoardGrid grid={draftBoard.grid} teamCount={draftBoard.teamCount} />}
      </section>
    </div>
  );
}

function SuperlativeCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-sheet px-5 py-4">
      <div className="display text-[11px] tracking-[0.18em] text-muted">{label}</div>
      <div className="mt-1.5 text-[15px] text-ink">{value}</div>
    </div>
  );
}

/**
 * Kept as a real `<table>` rather than the fixed-column CSS grid used elsewhere on this page —
 * `teamCount` is a runtime, per-league value (10-12 franchises), the same reason the H2H matrix
 * (src/app/(league)/h2h/page.tsx) stays a `<table>` too rather than a Tailwind grid with a
 * dynamic, arbitrary column count.
 */
function DraftBoardGrid({ grid, teamCount }: { grid: (DraftPickCell | null)[][]; teamCount: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b-2 border-ink text-left text-muted">
            <th className="display sticky left-0 z-10 bg-sheet px-2 py-2 text-[10px] font-normal tracking-[0.16em]">Rd</th>
            {Array.from({ length: teamCount }, (_, i) => (
              <th key={i} className="display min-w-[110px] px-2 py-2 text-center text-[10px] font-normal tracking-[0.16em] text-muted">
                Pick {i + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((round, roundIdx) => (
            <tr key={roundIdx} className="border-b border-line-sheet-soft last:border-0">
              <td className="sticky left-0 z-10 bg-sheet px-2 py-2 tabular-nums text-muted">{roundIdx + 1}</td>
              {round.map((pick, pickIdx) => (
                <td key={pickIdx} className="px-2 py-2 align-top">
                  {pick ? (
                    <div>
                      <p className="text-ink">
                        {pick.playerName} <span className="text-muted">{pick.position}</span>
                        {pick.keeper ? <span className="ml-1 font-semibold text-ink">(K)</span> : null}
                      </p>
                      <p className="text-muted">{pick.teamName}</p>
                    </div>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
