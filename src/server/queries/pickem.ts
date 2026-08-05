/**
 * Weekly Pick'em (Task 31) — DB-backed reads shared by BOTH the web app (src/features/pickem/
 * queries.ts) and the worker (src/server/sync/pickem-lock.ts). Everything here takes an explicit
 * `db: Db` (not the `getDb()` singleton) so both call sites — and their tests, which inject a
 * scratch DB — can point it anywhere, matching src/server/queries/identity.ts's precedent.
 *
 * Franchise (not team_season) is the atomic unit pick'em picks reference, per AGENTS.md — see
 * schema.ts's `pickemPicks` docstring for why `matchupId`/`pickedFranchiseId` are plain integers,
 * not hard FKs.
 */
import { alias } from "drizzle-orm/sqlite-core";
import { and, eq } from "drizzle-orm";
import { computeCurrentPickemWeek, type PickemWeekSignal } from "@/engines";
import type { Db } from "../db/client";
import { franchises, matchups, pickemPicks, teamSeasons } from "../db/schema";

// ---------------------------------------------------------------------------
// Current week resolution
// ---------------------------------------------------------------------------

/** Every (season, week)'s "is every matchup in it final" signal, across ALL seasons — same
 * full-table-scan shape as src/server/queries/matchups.ts's getLatestMatchupWeek. Byes count as
 * final by construction (normalize.ts), so an odd-team-count week is never stuck open forever. */
export function getPickemWeekSignals(db: Db): PickemWeekSignal[] {
  const rows = db.select({ season: matchups.season, week: matchups.week, isFinal: matchups.isFinal }).from(matchups).all();
  const byKey = new Map<string, PickemWeekSignal>();
  for (const r of rows) {
    const key = `${r.season}:${r.week}`;
    const existing = byKey.get(key);
    if (existing) existing.allFinal = existing.allFinal && r.isFinal;
    else byKey.set(key, { season: r.season, week: r.week, allFinal: r.isFinal });
  }
  return [...byKey.values()];
}

/** See src/engines/pickem.ts's computeCurrentPickemWeek for the exact resolution rule. */
export function getCurrentPickemWeek(db: Db): { season: number; week: number } | null {
  return computeCurrentPickemWeek(getPickemWeekSignals(db));
}

// ---------------------------------------------------------------------------
// Pickable matchups for a week
// ---------------------------------------------------------------------------

export interface PickemMatchupRow {
  matchupId: number;
  week: number;
  homeFranchiseId: number;
  homeFranchiseName: string;
  awayFranchiseId: number;
  awayFranchiseName: string;
  isFinal: boolean;
  /** Raw scores (real ESPN 0.0 sentinel before kickoff — see the espn-fantasy-data skill; never
   * fabricated). Fix round 1: feeds `hasAnyGameBegun` (pickem-lock.ts's data-driven lock floor) —
   * a nonzero score is the honest "this game has actually started" signal, independent of
   * `isFinal`. */
  homeScore: number;
  awayScore: number;
  /** Null when not final, or when the real result was a tie (`matchups.winner === "tie"`). */
  winningFranchiseId: number | null;
}

/** Shared join — every TWO-SIDED matchup (byes, which have no away team_season, are excluded
 * entirely by the inner joins: there's no opponent for a manager or The Algorithm to pick a
 * winner against), optionally narrowed to one week. Ordered by matchupId for a stable,
 * deterministic render order. */
function queryPickemMatchupRows(db: Db, season: number, week?: number): PickemMatchupRow[] {
  const homeTeam = alias(teamSeasons, "pk_home_team");
  const awayTeam = alias(teamSeasons, "pk_away_team");
  const homeFranchise = alias(franchises, "pk_home_franchise");
  const awayFranchise = alias(franchises, "pk_away_franchise");

  const rows = db
    .select({
      matchupId: matchups.id,
      week: matchups.week,
      isFinal: matchups.isFinal,
      winner: matchups.winner,
      homeScore: matchups.homeScore,
      awayScore: matchups.awayScore,
      homeFranchiseId: homeFranchise.id,
      homeFranchiseName: homeFranchise.canonicalName,
      awayFranchiseId: awayFranchise.id,
      awayFranchiseName: awayFranchise.canonicalName,
    })
    .from(matchups)
    .innerJoin(homeTeam, eq(matchups.homeTeamSeasonId, homeTeam.id))
    .innerJoin(homeFranchise, eq(homeTeam.franchiseId, homeFranchise.id))
    .innerJoin(awayTeam, eq(matchups.awayTeamSeasonId, awayTeam.id))
    .innerJoin(awayFranchise, eq(awayTeam.franchiseId, awayFranchise.id))
    .where(week === undefined ? eq(matchups.season, season) : and(eq(matchups.season, season), eq(matchups.week, week)))
    .all();

  return rows
    .map((r) => ({
      matchupId: r.matchupId,
      week: r.week,
      homeFranchiseId: r.homeFranchiseId,
      homeFranchiseName: r.homeFranchiseName,
      awayFranchiseId: r.awayFranchiseId,
      awayFranchiseName: r.awayFranchiseName,
      isFinal: r.isFinal,
      homeScore: r.homeScore,
      awayScore: r.awayScore,
      winningFranchiseId: r.isFinal && r.winner === "home" ? r.homeFranchiseId : r.isFinal && r.winner === "away" ? r.awayFranchiseId : null,
    }))
    .sort((a, b) => a.matchupId - b.matchupId);
}

/** Every TWO-SIDED matchup for (season, week) — see queryPickemMatchupRows. */
export function getPickemMatchupRows(db: Db, season: number, week: number): PickemMatchupRow[] {
  return queryPickemMatchupRows(db, season, week);
}

/** Every TWO-SIDED matchup across a WHOLE season — season leaderboard scoring input (needs every
 * week's result, not just one). */
export function getPickemMatchupRowsForSeason(db: Db, season: number): PickemMatchupRow[] {
  return queryPickemMatchupRows(db, season);
}

// ---------------------------------------------------------------------------
// Picks
// ---------------------------------------------------------------------------

export interface PickemPickRow {
  /** Null for "The Algorithm" pseudo-entrant's picks — see schema.ts's pickemPicks docstring. */
  managerId: number | null;
  isAlgorithm: boolean;
  week: number;
  matchupId: number;
  pickedFranchiseId: number;
}

function toPickRow(r: { managerId: number | null; isAlgorithm: boolean; week: number; matchupId: number; pickedFranchiseId: number }): PickemPickRow {
  return { managerId: r.managerId, isAlgorithm: r.isAlgorithm, week: r.week, matchupId: r.matchupId, pickedFranchiseId: r.pickedFranchiseId };
}

const PICK_ROW_SELECTION = {
  managerId: pickemPicks.managerId,
  isAlgorithm: pickemPicks.isAlgorithm,
  week: pickemPicks.week,
  matchupId: pickemPicks.matchupId,
  pickedFranchiseId: pickemPicks.pickedFranchiseId,
} as const;

/** Every pick (every manager + the algorithm, if enabled) for ONE (season, week). */
export function getPicksForWeek(db: Db, season: number, week: number): PickemPickRow[] {
  return db
    .select(PICK_ROW_SELECTION)
    .from(pickemPicks)
    .where(and(eq(pickemPicks.season, season), eq(pickemPicks.week, week)))
    .all()
    .map(toPickRow);
}

/** Every pick across an entire season — season leaderboard input. */
export function getPicksForSeason(db: Db, season: number): PickemPickRow[] {
  return db.select(PICK_ROW_SELECTION).from(pickemPicks).where(eq(pickemPicks.season, season)).all().map(toPickRow);
}

/** One manager's picks for ONE week, as a matchupId -> pickedFranchiseId map — pre-fills/echoes
 * the pick form, and answers "have I already picked this week." */
export function getManagerPicksForWeek(db: Db, season: number, week: number, managerId: number): Map<number, number> {
  const rows = db
    .select({ matchupId: pickemPicks.matchupId, pickedFranchiseId: pickemPicks.pickedFranchiseId })
    .from(pickemPicks)
    .where(and(eq(pickemPicks.season, season), eq(pickemPicks.week, week), eq(pickemPicks.managerId, managerId)))
    .all();
  return new Map(rows.map((r) => [r.matchupId, r.pickedFranchiseId]));
}
