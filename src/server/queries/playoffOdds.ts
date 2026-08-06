/**
 * Playoff-odds READ layer (Task 52) — thin reads off the `playoff_odds` derived-stat table
 * (`src/server/stats/build.ts`'s stage 9). This module never computes odds itself (that only ever
 * happens inside a stats:build, see build.ts) — it just serves whatever the last build persisted,
 * honestly empty when there is none (see each function's docstring for exactly when that happens).
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { playoffOdds, seasons } from "../db/schema";

export interface PlayoffOddsRow {
  franchiseId: number;
  playoffProbability: number;
  topSeedProbability: number;
}

/**
 * Playoff-odds rows for `season` — EMPTY when `season` isn't the one build.ts's stage 9 most
 * recently computed odds for. That's the NORMAL, honest state for a complete season (real finals
 * exist, simulated odds don't apply) or an upcoming one (nothing to simulate from yet), and also
 * covers "no stats:build has run since this feature shipped." Callers (the Standings Real tab, the
 * home rail) treat an empty result as "no playoff-odds column/line this render," never an error.
 */
export function getPlayoffOddsForSeason(season: number): PlayoffOddsRow[] {
  const db = getDb();
  return db
    .select({ franchiseId: playoffOdds.franchiseId, playoffProbability: playoffOdds.playoffProbability, topSeedProbability: playoffOdds.topSeedProbability })
    .from(playoffOdds)
    .where(eq(playoffOdds.season, season))
    .all();
}

/** Stable page/query model name; delegates to the season-scoped read without changing its data. */
export function getPlayoffOdds(season: number): PlayoffOddsRow[] {
  return getPlayoffOddsForSeason(season);
}

export interface PlayoffRaceLine {
  season: number;
  /** Null when there's no signed-in viewer franchise, OR the viewer's franchise has no odds row
   * this build (shouldn't happen once odds exist for the season at all, but kept honest/defensive
   * rather than assumed). */
  viewerProbability: number | null;
  /** Franchises with a playoff probability strictly between 10% and 90% — genuinely still in
   * doubt, neither a lock nor eliminated in all but a rounding error's worth of simulations. */
  bubbleTeamCount: number;
}

const BUBBLE_LOW = 0.1;
const BUBBLE_HIGH = 0.9;

/**
 * The home rail's one-line playoff-race summary (Task 52 brief item 4). `null` whenever there's
 * nothing honest to say: no season is currently `active`, or that active season has no playoff-odds
 * rows yet (build hasn't run since kickoff, or — rare — its playoff format couldn't be resolved;
 * see build.ts's stage 9). Never fabricated for a complete/upcoming season — this function doesn't
 * even look at those; only `status = 'active'` is eligible, matching the brief's "in-progress
 * seasons only" rule for the Standings column this same table feeds.
 */
export function getPlayoffRaceLine(viewerFranchiseId: number | null): PlayoffRaceLine | null {
  const db = getDb();
  const activeSeasonRows = db.select({ season: seasons.season }).from(seasons).where(eq(seasons.status, "active")).all();
  if (activeSeasonRows.length === 0) return null;
  // `deriveSeasonStatus` (normalize.ts) only ever marks ONE season 'active' at a time against real
  // data; if that ever changed, taking the highest (most recent) season is the safer of two
  // arbitrary choices, not a crash.
  const season = Math.max(...activeSeasonRows.map((r) => r.season));

  const rows = getPlayoffOddsForSeason(season);
  if (rows.length === 0) return null;

  const viewer = viewerFranchiseId !== null ? (rows.find((r) => r.franchiseId === viewerFranchiseId) ?? null) : null;
  const bubbleTeamCount = rows.filter((r) => r.playoffProbability > BUBBLE_LOW && r.playoffProbability < BUBBLE_HIGH).length;

  return { season, viewerProbability: viewer?.playoffProbability ?? null, bubbleTeamCount };
}
