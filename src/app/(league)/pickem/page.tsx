import { Button, Notice } from "@/components/broadcast/FormControls";
import { PageHeader } from "@/components/broadcast/PageHeader";
import { SectionLabel } from "@/components/broadcast/SectionLabel";
import { FranchiseName } from "@/components/league/FranchiseName";
import { cn } from "@/components/ui/cn";
import { setAiEnabledAction, submitPicksAction } from "@/features/pickem/actions";
import {
  ALGORITHM_TAGLINE,
  getAiEnabled,
  getCurrentWeekState,
  getMyPicksForWeek,
  getPickableMatchups,
  getSeasonLeaderboard,
  getWeekGrid,
  type PickemLeaderboardRow,
} from "@/features/pickem/queries";
import { requireManager } from "@/server/auth/guard";
import { getDb } from "@/server/db/client";
import type { Manager } from "@/server/db/schema";
import { getIdentityFlags, resolveFranchiseFlags, type IdentityFlags } from "@/server/queries/identity";

/**
 * /pickem (Task 31) — this week's pick form pre-lock (own picks only, per-manager write
 * isolation enforced server-side by submitPicksAction), everyone's picks + weekly/season
 * leaderboards post-lock. Commissioner-only "The Algorithm" toggle lives on this page itself
 * (not /admin) — see setAiEnabledAction.
 */
export default async function PickemPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const manager = await requireManager();
  const { error, success } = await searchParams;

  const db = getDb();
  const identityFlags = getIdentityFlags(db, manager.id);
  const current = getCurrentWeekState();
  const aiEnabled = getAiEnabled();
  const seasonLeaderboard = current ? getSeasonLeaderboard(current.season) : [];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="League" title="Pick'em" />

      {error ? <Notice tone="live">{error}</Notice> : null}
      {success === "picks_saved" ? <Notice tone="kelly">Your picks are saved.</Notice> : null}
      {success === "ai_toggle" ? <Notice tone="kelly">The Algorithm&apos;s setting is saved.</Notice> : null}

      {manager.role === "commissioner" ? (
        <section className="flex flex-col gap-3 border border-line-sheet bg-sheet-raised p-5">
          <SectionLabel>The Algorithm — Commissioner Setting</SectionLabel>
          <p className="text-sm text-muted">{ALGORITHM_TAGLINE}</p>
          <form action={setAiEnabledAction} className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="aiEnabled" defaultChecked={aiEnabled} className="h-4 w-4" />
              Enter &quot;The Algorithm&quot; as a pick&apos;em competitor
            </label>
            <Button>Save</Button>
          </form>
        </section>
      ) : null}

      {!current ? (
        <Notice tone="ink">Nothing to pick right now — check back once the next slate is set.</Notice>
      ) : current.locked ? (
        <WeekResultsSection season={current.season} week={current.week} identityFlags={identityFlags} />
      ) : (
        <PickForm season={current.season} week={current.week} manager={manager} />
      )}

      <SeasonLeaderboardSection rows={seasonLeaderboard} identityFlags={identityFlags} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pick form (pre-lock, own picks only)
// ---------------------------------------------------------------------------

function PickForm({ season, week, manager }: { season: number; week: number; manager: Manager }) {
  const matchupsForWeek = getPickableMatchups(season, week);
  const myPicks = getMyPicksForWeek(season, week, manager.id);

  if (matchupsForWeek.length === 0) {
    return <Notice tone="ink">No games to pick this week.</Notice>;
  }

  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>Week {week} — Make Your Picks</SectionLabel>
      <form action={submitPicksAction} className="flex flex-col gap-4 border border-line-sheet bg-sheet p-5">
        <input type="hidden" name="season" value={season} />
        <input type="hidden" name="week" value={week} />
        <div className="flex flex-col gap-3">
          {matchupsForWeek.map((m) => {
            const picked = myPicks.get(m.matchupId);
            const sides = [
              { id: m.homeFranchiseId, name: m.homeFranchiseName },
              { id: m.awayFranchiseId, name: m.awayFranchiseName },
            ];
            return (
              <fieldset key={m.matchupId} className="flex flex-col gap-2 border border-line-sheet-soft p-3">
                <legend className="display px-1 text-[11px] tracking-[0.14em] text-muted">
                  {m.homeFranchiseName} vs {m.awayFranchiseName}
                </legend>
                {sides.map((side) => (
                  <label key={side.id} className="flex items-center gap-2 text-sm text-ink">
                    <input type="radio" name={`pick_${m.matchupId}`} value={side.id} defaultChecked={picked === side.id} required className="h-4 w-4" />
                    {side.name}
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
        <div>
          <Button>Save Picks</Button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Post-lock: everyone's picks + weekly points
// ---------------------------------------------------------------------------

function EntrantCell({ entrantId, displayName, franchiseId, isAlgorithm, identityFlags }: { entrantId: string; displayName: string; franchiseId: number | null; isAlgorithm: boolean; identityFlags: IdentityFlags }) {
  if (isAlgorithm) {
    return <span className="display text-[12px] tracking-[0.12em] text-muted">{displayName}</span>;
  }
  if (franchiseId === null) {
    return <span>{displayName}</span>;
  }
  return <FranchiseName key={entrantId} franchise={{ id: franchiseId, name: displayName, ...resolveFranchiseFlags(identityFlags, franchiseId) }} size="row" />;
}

function WeekResultsSection({ season, week, identityFlags }: { season: number; week: number; identityFlags: IdentityFlags }) {
  const { matchups: weekMatchups, rows } = getWeekGrid(season, week);

  if (weekMatchups.length === 0) {
    return <Notice tone="ink">No games were on the slate for week {week}.</Notice>;
  }

  const allFinal = weekMatchups.every((m) => m.isFinal);

  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>
        Week {week} — {allFinal ? "Final" : "Locked, In Progress"}
      </SectionLabel>
      {rows.length === 0 ? (
        <p className="border border-line-sheet bg-sheet p-6 text-sm text-muted">Nobody submitted picks this week.</p>
      ) : (
        <div className="overflow-x-auto border border-line-sheet bg-sheet">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-line-sheet-strong text-left text-[11px] tracking-[0.12em] text-muted">
                <th className="px-3 py-2 font-normal">Entrant</th>
                {weekMatchups.map((m) => (
                  <th key={m.matchupId} className="px-3 py-2 font-normal">
                    {m.homeFranchiseName} v {m.awayFranchiseName}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-normal">Pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.entrant.entrantId} className="border-b border-line-sheet last:border-b-0">
                  <td className="px-3 py-2">
                    <EntrantCell
                      entrantId={row.entrant.entrantId}
                      displayName={row.entrant.displayName}
                      franchiseId={row.entrant.franchiseId}
                      isAlgorithm={row.entrant.isAlgorithm}
                      identityFlags={identityFlags}
                    />
                  </td>
                  {weekMatchups.map((m) => {
                    const picked = row.picks.get(m.matchupId);
                    const pickedName = picked === m.homeFranchiseId ? m.homeFranchiseName : picked === m.awayFranchiseId ? m.awayFranchiseName : "—";
                    const correct = m.isFinal && m.winningFranchiseId !== null && picked === m.winningFranchiseId;
                    const wrong = m.isFinal && m.winningFranchiseId !== null && picked !== undefined && picked !== m.winningFranchiseId;
                    return (
                      <td key={m.matchupId} className={cn("px-3 py-2", correct ? "text-kelly" : wrong ? "text-live" : "text-ink")}>
                        {pickedName}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right tabular-nums">{row.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Season leaderboard
// ---------------------------------------------------------------------------

function SeasonLeaderboardSection({ rows, identityFlags }: { rows: PickemLeaderboardRow[]; identityFlags: IdentityFlags }) {
  return (
    <section className="flex flex-col gap-4">
      <SectionLabel>Season Leaderboard</SectionLabel>
      {rows.length === 0 ? (
        <p className="border border-line-sheet bg-sheet p-6 text-sm text-muted">No picks have locked yet this season.</p>
      ) : (
        <div className="overflow-x-auto border border-line-sheet bg-sheet">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-line-sheet-strong text-left text-[11px] tracking-[0.12em] text-muted">
                <th className="px-3 py-2 font-normal">Rank</th>
                <th className="px-3 py-2 font-normal">Entrant</th>
                <th className="px-3 py-2 text-right font-normal">Weeks Won</th>
                <th className="px-3 py-2 text-right font-normal">Total Pts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.entrant.entrantId} className="border-b border-line-sheet last:border-b-0">
                  <td className="px-3 py-2 tabular-nums text-muted">{row.rank}</td>
                  <td className="px-3 py-2">
                    <EntrantCell
                      entrantId={row.entrant.entrantId}
                      displayName={row.entrant.displayName}
                      franchiseId={row.entrant.franchiseId}
                      isAlgorithm={row.entrant.isAlgorithm}
                      identityFlags={identityFlags}
                    />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.weeksWon}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{row.totalPoints}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
