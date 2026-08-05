/**
 * Live win-probability query layer (Task 32) — the DB-facing side of `src/engines/winProbability.ts`.
 * Produces a win probability for each of a week's real (non-bye) matchups from the live layer's
 * already-normalized state: `matchups` for current scores, `roster_slots` for which starters have
 * and haven't recorded a score yet, `elo_history` for each franchise's pre-game Elo, and the
 * `slot_scoring_stats` calibration table (`src/server/stats/build.ts`'s stage 7) for the
 * remaining-starter distributions.
 *
 * SHAPE ONLY, NO EMISSION: this deliberately stops at "here is P(home wins) right now" — it does
 * NOT decide when a swing is significant, does not touch `events`, and renders nothing. Both of
 * those are the wiring wave's job once the live cards this feeds actually exist (see the roadmap's
 * Live Win Probability / Sweat Meter section and this task's brief).
 */
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { ELO_SEASON_REGRESSION_FACTOR, ELO_START, winProbabilityBreakdown, type SlotScoringCalibration, type WinProbabilityTeamState } from "@/engines";
import { getDb, type Db } from "../db/client";
import { eloHistory, matchups, rosterSlots, slotScoringStats, teamSeasons } from "../db/schema";
import { getLatestMatchupWeek } from "./matchups";

export interface MatchupWinProbabilitySide {
  franchiseId: number;
  winProbability: number;
}

export interface MatchupWinProbability {
  matchupId: number;
  season: number;
  week: number;
  home: MatchupWinProbabilitySide;
  /** Always the complement of `home.winProbability` (1 - home) — every matchup this function
   * returns is a real two-side game; byes are filtered out entirely rather than given a
   * meaningless probability (see `getWinProbabilitiesForWeek`). */
  away: MatchupWinProbabilitySide;
  /** Same meaning as `WinProbabilityBreakdown.weekProgress` in the engine — 0 = full lineups
   * remaining on both sides (Elo-prior-dominated), 1 = nobody left to play (score decides). */
  weekProgress: number;
}

// ---------------------------------------------------------------------------
// Pre-game Elo resolution
// ---------------------------------------------------------------------------

/**
 * This franchise's Elo rating immediately BEFORE (season, week)'s game — reusing the exact
 * season-rollover regression `src/engines/replay.ts`'s `ensureFranchiseSeen` applies during the
 * chronological replay, so a query made before the new season's first game has been played (and
 * thus before `replay()` has ever regressed that franchise's rating itself) still returns the
 * correctly-regressed number rather than a stale end-of-last-season rating.
 *
 * Prefers a real `elo_history` row strictly before (season, week) — for any COMPLETED game,
 * `elo_history.elo_pre` is already the exact right answer (this is precisely what stage 3's
 * `replay()` recorded at the time). Falls back to `ELO_START` for a franchise with no history at
 * all yet (a brand-new franchise's very first game).
 */
export function resolvePreGameElo(db: Db, franchiseId: number, season: number, week: number): number {
  const row = db
    .select({ season: eloHistory.season, week: eloHistory.week, eloPost: eloHistory.eloPost })
    .from(eloHistory)
    .where(
      and(
        eq(eloHistory.franchiseId, franchiseId),
        or(lt(eloHistory.season, season), and(eq(eloHistory.season, season), lt(eloHistory.week, week))),
      ),
    )
    .orderBy(desc(eloHistory.season), desc(eloHistory.week))
    .limit(1)
    .get();

  if (!row) return ELO_START;
  if (row.season < season) return ELO_START + (row.eloPost - ELO_START) * ELO_SEASON_REGRESSION_FACTOR;
  return row.eloPost;
}

// ---------------------------------------------------------------------------
// Slot progress (remaining vs played, broken out by lineup-slot label)
// ---------------------------------------------------------------------------

export interface SlotProgressRow {
  teamSeasonId: number;
  lineupSlot: string;
  isStarter: boolean;
  points: number | null;
}

export interface TeamSlotProgress {
  remainingBySlot: Record<string, number>;
  startersPlayed: number;
}

/**
 * Per `team_season_id`: STARTER roster_slots rows split into "already has a recorded score"
 * (`startersPlayed`) vs "doesn't yet," the latter broken out by `lineupSlot` label — exactly the
 * shape `src/engines/winProbability.ts`'s `WinProbabilityTeamState` needs. Bench/IR rows are
 * dropped (`isStarter` gate). A team-season with zero roster_slots rows for this week simply gets
 * no map entry — same "no roster synced yet" honesty as `summarizeRosterProgress` in
 * `matchups.ts` (the caller substitutes an explicit empty state, never fabricates one here). Pure.
 */
export function summarizeSlotProgress(rows: SlotProgressRow[]): Map<number, TeamSlotProgress> {
  const out = new Map<number, TeamSlotProgress>();
  for (const r of rows) {
    if (!r.isStarter) continue;
    const cur = out.get(r.teamSeasonId) ?? { remainingBySlot: {}, startersPlayed: 0 };
    if (r.points === null) {
      cur.remainingBySlot[r.lineupSlot] = (cur.remainingBySlot[r.lineupSlot] ?? 0) + 1;
    } else {
      cur.startersPlayed += 1;
    }
    out.set(r.teamSeasonId, cur);
  }
  return out;
}

const EMPTY_PROGRESS: TeamSlotProgress = { remainingBySlot: {}, startersPlayed: 0 };

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** Exported for reuse by `src/server/stats/backtest-cli.ts`, which needs the same calibration
 * table for its pre-game predictions as the live query path uses. */
export function loadSlotScoringCalibration(db: Db): SlotScoringCalibration {
  const rows = db.select({ slot: slotScoringStats.slot, mean: slotScoringStats.mean, variance: slotScoringStats.variance }).from(slotScoringStats).all();
  const out: SlotScoringCalibration = {};
  for (const r of rows) out[r.slot] = { mean: r.mean, variance: r.variance };
  return out;
}

// ---------------------------------------------------------------------------
// Public query
// ---------------------------------------------------------------------------

/**
 * Win probability for every REAL (non-bye) matchup in (season, week). A bye has no opposing side
 * to compute a probability against — filtered out entirely rather than assigned a meaningless
 * number. Empty array when the week has no matchups, or when every matchup that week is a bye.
 *
 * When `slot_scoring_stats` hasn't been built yet (empty table — e.g. a fresh database before the
 * first `stats:build`), `calibration` is `{}`: every remaining starter contributes 0 mean/variance
 * (see the engine's documented fallback), so the result degrades gracefully toward the Elo prior
 * rather than throwing.
 */
export function getWinProbabilitiesForWeek(season: number, week: number): MatchupWinProbability[] {
  const db = getDb();

  const matchupRows = db
    .select({
      matchupId: matchups.id,
      homeTeamSeasonId: matchups.homeTeamSeasonId,
      awayTeamSeasonId: matchups.awayTeamSeasonId,
      homeScore: matchups.homeScore,
      awayScore: matchups.awayScore,
    })
    .from(matchups)
    .where(and(eq(matchups.season, season), eq(matchups.week, week)))
    .all()
    .filter((m): m is typeof m & { awayTeamSeasonId: number } => m.awayTeamSeasonId !== null);

  if (matchupRows.length === 0) return [];

  const calibration = loadSlotScoringCalibration(db);

  const teamSeasonIds = [...new Set(matchupRows.flatMap((m) => [m.homeTeamSeasonId, m.awayTeamSeasonId]))];
  const teamSeasonRows = db
    .select({ id: teamSeasons.id, franchiseId: teamSeasons.franchiseId })
    .from(teamSeasons)
    .where(inArray(teamSeasons.id, teamSeasonIds))
    .all();
  const franchiseByTeamSeason = new Map(teamSeasonRows.map((t) => [t.id, t.franchiseId]));

  const slotRows: SlotProgressRow[] = db
    .select({ teamSeasonId: rosterSlots.teamSeasonId, lineupSlot: rosterSlots.lineupSlot, isStarter: rosterSlots.isStarter, points: rosterSlots.points })
    .from(rosterSlots)
    .where(and(eq(rosterSlots.season, season), eq(rosterSlots.week, week), inArray(rosterSlots.teamSeasonId, teamSeasonIds)))
    .all();
  const progressByTeamSeason = summarizeSlotProgress(slotRows);

  // Cached per call — a franchise can appear in only one matchup per week, but the cache also
  // means a bye-having franchise (excluded above) never triggers a wasted lookup.
  const eloCache = new Map<number, number>();
  function eloFor(franchiseId: number): number {
    const cached = eloCache.get(franchiseId);
    if (cached !== undefined) return cached;
    const resolved = resolvePreGameElo(db, franchiseId, season, week);
    eloCache.set(franchiseId, resolved);
    return resolved;
  }

  return matchupRows.map((m) => {
    const homeFranchiseId = franchiseByTeamSeason.get(m.homeTeamSeasonId)!;
    const awayFranchiseId = franchiseByTeamSeason.get(m.awayTeamSeasonId)!;
    const homeProgress = progressByTeamSeason.get(m.homeTeamSeasonId) ?? EMPTY_PROGRESS;
    const awayProgress = progressByTeamSeason.get(m.awayTeamSeasonId) ?? EMPTY_PROGRESS;

    const home: WinProbabilityTeamState = {
      score: m.homeScore,
      eloPre: eloFor(homeFranchiseId),
      startersPlayed: homeProgress.startersPlayed,
      remainingBySlot: homeProgress.remainingBySlot,
    };
    const away: WinProbabilityTeamState = {
      score: m.awayScore,
      eloPre: eloFor(awayFranchiseId),
      startersPlayed: awayProgress.startersPlayed,
      remainingBySlot: awayProgress.remainingBySlot,
    };

    const breakdown = winProbabilityBreakdown({ home, away }, calibration);

    return {
      matchupId: m.matchupId,
      season,
      week,
      home: { franchiseId: homeFranchiseId, winProbability: breakdown.winProbability },
      away: { franchiseId: awayFranchiseId, winProbability: 1 - breakdown.winProbability },
      weekProgress: breakdown.weekProgress,
    };
  });
}

/** Convenience wrapper over `getWinProbabilitiesForWeek` for "whatever week the site is currently
 * showing" (same week-resolution rule as the rest of the live layer — see
 * `getLatestMatchupWeek`). Empty array when there are no matchups anywhere in the DB yet. */
export function getCurrentWeekWinProbabilities(): MatchupWinProbability[] {
  const target = getLatestMatchupWeek();
  if (!target) return [];
  return getWinProbabilitiesForWeek(target.season, target.week);
}
