import { and, asc, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "../db/client";
import { franchises, h2hPairs, matchups, teamSeasons } from "../db/schema";

/**
 * Minimal shape `flipH2HPair`/`buildActiveMatrix` need from an `h2h_pairs`
 * row — decoupled from the Drizzle-inferred row type so the pure transforms
 * below are unit-testable with plain object literals, no DB involved.
 */
export interface H2HPairLike {
  franchiseA: number;
  franchiseB: number;
  regW: number;
  regL: number;
  regT: number;
  playoffW: number;
  playoffL: number;
  playoffT: number;
  pointsA: number;
  pointsB: number;
  avgMargin: number;
  streakHolder: number | null;
  streakLen: number;
}

export interface H2HPerspectiveRow {
  opponentId: number;
  opponentName: string;
  wins: number;
  losses: number;
  ties: number;
  games: number;
  pointsFor: number;
  pointsAgainst: number;
  avgMargin: number;
  streakText: string | null;
}

/**
 * `h2h_pairs` stores one row per unordered (franchiseA < franchiseB) pair,
 * W/L/T from franchise_a's perspective. Flips that to whichever side
 * `franchiseId` is on — the shared primitive behind the franchise profile's
 * H2H strip, the H2H grid's historical drill-in, and (indirectly) the pair
 * detail page.
 */
export function flipH2HPair(pair: H2HPairLike, franchiseId: number, nameOf: (id: number) => string): H2HPerspectiveRow {
  const isA = pair.franchiseA === franchiseId;
  const opponentId = isA ? pair.franchiseB : pair.franchiseA;
  const wins = isA ? pair.regW + pair.playoffW : pair.regL + pair.playoffL;
  const losses = isA ? pair.regL + pair.playoffL : pair.regW + pair.playoffW;
  const ties = pair.regT + pair.playoffT;
  const pointsFor = isA ? pair.pointsA : pair.pointsB;
  const pointsAgainst = isA ? pair.pointsB : pair.pointsA;
  const avgMargin = isA ? pair.avgMargin : -pair.avgMargin;

  let streakText: string | null = null;
  if (pair.streakHolder !== null && pair.streakLen > 0) {
    const holderIsThis = pair.streakHolder === franchiseId;
    streakText = `${holderIsThis ? "W" : "L"}${pair.streakLen}`;
  }

  return {
    opponentId,
    opponentName: nameOf(opponentId),
    wins,
    losses,
    ties,
    games: wins + losses + ties,
    pointsFor,
    pointsAgainst,
    avgMargin,
    streakText,
  };
}

export type H2HAdvantage = "leading" | "trailing" | "even";

/** Bare win/loss compare — ties don't move the needle either way. */
export function computeAdvantage(wins: number, losses: number): H2HAdvantage {
  if (wins > losses) return "leading";
  if (losses > wins) return "trailing";
  return "even";
}

export interface H2HMatrixFranchise {
  id: number;
  name: string;
}

export interface H2HMatrixCell {
  opponentId: number;
  wins: number;
  losses: number;
  ties: number;
  advantage: H2HAdvantage;
}

export interface H2HMatrixRow {
  franchiseId: number;
  cells: Record<number, H2HMatrixCell>;
}

export interface H2HMatrix {
  franchises: H2HMatrixFranchise[];
  rows: H2HMatrixRow[];
}

/**
 * Builds the desktop grid: rows = cols = the given franchise list (callers
 * pass only active franchises), restricted to pairs where BOTH sides are in
 * that list. Every pair produces two mirrored cells (one per row).
 */
export function buildActiveMatrix(matrixFranchises: H2HMatrixFranchise[], pairs: H2HPairLike[]): H2HMatrix {
  const includedIds = new Set(matrixFranchises.map((f) => f.id));
  const cellsByFranchise = new Map<number, Record<number, H2HMatrixCell>>();
  for (const f of matrixFranchises) cellsByFranchise.set(f.id, {});

  for (const p of pairs) {
    if (!includedIds.has(p.franchiseA) || !includedIds.has(p.franchiseB)) continue;
    const aWins = p.regW + p.playoffW;
    const aLosses = p.regL + p.playoffL;
    const ties = p.regT + p.playoffT;

    cellsByFranchise.get(p.franchiseA)![p.franchiseB] = {
      opponentId: p.franchiseB,
      wins: aWins,
      losses: aLosses,
      ties,
      advantage: computeAdvantage(aWins, aLosses),
    };
    cellsByFranchise.get(p.franchiseB)![p.franchiseA] = {
      opponentId: p.franchiseA,
      wins: aLosses,
      losses: aWins,
      ties,
      advantage: computeAdvantage(aLosses, aWins),
    };
  }

  return {
    franchises: matrixFranchises,
    rows: matrixFranchises.map((f) => ({ franchiseId: f.id, cells: cellsByFranchise.get(f.id)! })),
  };
}

/** Active-franchise x active-franchise grid, sorted alphabetically for easy scanning. */
export function getActiveH2HMatrix(): H2HMatrix {
  const db = getDb();
  const activeFranchises = db
    .select({ id: franchises.id, name: franchises.canonicalName })
    .from(franchises)
    .where(eq(franchises.active, true))
    .orderBy(asc(franchises.canonicalName))
    .all();
  const pairs = db.select().from(h2hPairs).all();
  return buildActiveMatrix(activeFranchises, pairs);
}

export interface HistoricalH2HGroup {
  franchiseId: number;
  franchiseName: string;
  opponents: H2HPerspectiveRow[];
}

/** Every departed franchise's full all-time pair list, for the collapsed "historical" drill-in. */
export function getHistoricalH2H(): HistoricalH2HGroup[] {
  const db = getDb();
  const departed = db
    .select({ id: franchises.id, name: franchises.canonicalName })
    .from(franchises)
    .where(eq(franchises.active, false))
    .orderBy(asc(franchises.canonicalName))
    .all();
  const allFranchises = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(allFranchises.map((f) => [f.id, f.name]));
  const nameOf = (id: number) => nameById.get(id) ?? `Franchise ${id}`;
  const pairs = db.select().from(h2hPairs).all();

  return departed.map((f) => {
    const relevant = pairs.filter((p) => p.franchiseA === f.id || p.franchiseB === f.id);
    const opponents = relevant.map((p) => flipH2HPair(p, f.id, nameOf)).sort((a, b) => b.games - a.games);
    return { franchiseId: f.id, franchiseName: f.name, opponents };
  });
}

export interface H2HPairDetail {
  franchiseA: { id: number; name: string };
  franchiseB: { id: number; name: string };
  regW: number;
  regL: number;
  regT: number;
  playoffW: number;
  playoffL: number;
  playoffT: number;
  pointsA: number;
  pointsB: number;
  avgMargin: number;
  streak: { holderId: number; holderName: string; len: number } | null;
  largestWin: { winnerFranchiseId: number; winnerName: string; value: number; season: number; week: number } | null;
  closestGame: { season: number; week: number; margin: number } | null;
  lastMeeting: { season: number; week: number } | null;
}

/** Full stat sheet for one pair — order-independent, canonicalizes to (min id, max id) internally. */
export function getH2HPairDetail(idA: number, idB: number): H2HPairDetail | null {
  if (!Number.isFinite(idA) || !Number.isFinite(idB) || idA === idB) return null;
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);

  const db = getDb();
  const pair = db
    .select()
    .from(h2hPairs)
    .where(and(eq(h2hPairs.franchiseA, lo), eq(h2hPairs.franchiseB, hi)))
    .get();
  if (!pair) return null;

  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));
  const nameOf = (id: number) => nameById.get(id) ?? `Franchise ${id}`;

  const largestWinRaw = pair.largestWinJson as { winnerFranchiseId: number; value: number; season: number; week: number } | null;
  const closestGameRaw = pair.closestGameJson as { season: number; week: number; margin: number } | null;
  const lastMeetingRaw = pair.lastMeetingJson as { season: number; week: number } | null;

  return {
    franchiseA: { id: lo, name: nameOf(lo) },
    franchiseB: { id: hi, name: nameOf(hi) },
    regW: pair.regW,
    regL: pair.regL,
    regT: pair.regT,
    playoffW: pair.playoffW,
    playoffL: pair.playoffL,
    playoffT: pair.playoffT,
    pointsA: pair.pointsA,
    pointsB: pair.pointsB,
    avgMargin: pair.avgMargin,
    streak: pair.streakHolder !== null ? { holderId: pair.streakHolder, holderName: nameOf(pair.streakHolder), len: pair.streakLen } : null,
    largestWin: largestWinRaw
      ? { ...largestWinRaw, winnerName: nameOf(largestWinRaw.winnerFranchiseId) }
      : null,
    closestGame: closestGameRaw,
    lastMeeting: lastMeetingRaw,
  };
}

// ---------------------------------------------------------------------------
// Per-game W/L/T log — the franchise profile's H2H "balance strip" (README:
// "a balance strip of 11px win/loss squares, most recent on the right").
// `h2h_pairs` only stores AGGREGATE W/L/T (plus the current streak's holder/
// length) — no per-game sequence — so a real chronological strip has to be
// built from the actual `matchups` rows, not approximated from the
// aggregate (that would risk fabricating a sequence that never happened).
// ---------------------------------------------------------------------------

export interface H2HGameLike {
  season: number;
  week: number;
  homeFranchiseId: number;
  awayFranchiseId: number;
  winner: "home" | "away" | "tie" | null;
}

export type H2HGameResult = "W" | "L" | "T";

/**
 * Chronological (oldest -> newest) W/L/T sequence for `franchiseId` against `opponentId`, from
 * `franchiseId`'s perspective. Pure — unit-tested directly against plain fixture rows, no DB.
 * Caller sorts input by season/week ascending before calling; this does not re-sort (keeping it
 * a dumb mapper avoids silently masking an unsorted-query bug at the call site).
 */
export function computeH2HGameLog(games: H2HGameLike[], franchiseId: number): H2HGameResult[] {
  return games.map((g) => {
    const isHome = g.homeFranchiseId === franchiseId;
    if (g.winner === "tie") return "T";
    if ((g.winner === "home" && isHome) || (g.winner === "away" && !isHome)) return "W";
    return "L";
  });
}

/** Real per-game results between two franchises, oldest to newest, capped to the most recent
 * `limit` (README: 11 squares, most recent on the right — i.e. the END of this array). Only
 * FINAL matchups count; bye weeks are excluded automatically (an inner join needs both sides).
 *
 * Single-opponent form — kept for callers that only need one pair (e.g. a future H2H pair detail
 * page). The franchise PROFILE page needs this for EVERY opponent at once; use
 * `getFranchiseH2HGameLogs` there instead of calling this in a loop (Task 33 audit catch — see
 * that function's docstring for the N+1 it replaces). */
export function getFranchiseH2HGameLog(franchiseId: number, opponentId: number, limit = 11): H2HGameResult[] {
  const db = getDb();
  const homeTeam = alias(teamSeasons, "h2hlog_home_team");
  const awayTeam = alias(teamSeasons, "h2hlog_away_team");

  const rows = db
    .select({
      season: matchups.season,
      week: matchups.week,
      homeFranchiseId: homeTeam.franchiseId,
      awayFranchiseId: awayTeam.franchiseId,
      winner: matchups.winner,
    })
    .from(matchups)
    .innerJoin(homeTeam, eq(matchups.homeTeamSeasonId, homeTeam.id))
    .innerJoin(awayTeam, eq(matchups.awayTeamSeasonId, awayTeam.id))
    .where(
      and(
        eq(matchups.isFinal, true),
        or(
          and(eq(homeTeam.franchiseId, franchiseId), eq(awayTeam.franchiseId, opponentId)),
          and(eq(homeTeam.franchiseId, opponentId), eq(awayTeam.franchiseId, franchiseId)),
        ),
      ),
    )
    .all();

  const sorted = rows.sort((a, b) => a.season - b.season || a.week - b.week);
  return computeH2HGameLog(sorted as H2HGameLike[], franchiseId).slice(-limit);
}

/**
 * Every opponent's game log at once, from ONE query — fixes the franchise profile page's N+1
 * (Task 33 audit catch: it was calling `getFranchiseH2HGameLog` once per opponent inside a
 * `.map()`, i.e. one `matchups` query per row of the H2H strip). Pulls every FINAL matchup
 * involving `franchiseId` against ANY opponent in a single join, then groups by "the other side"
 * in memory — same result per opponent as calling the single-opponent form in a loop would have
 * given, just one round trip instead of N. Returned map has no entry for an opponent with zero
 * final games together (mirrors the single-opponent form's empty-array case). */
export function getFranchiseH2HGameLogs(franchiseId: number, limit = 11): Map<number, H2HGameResult[]> {
  const db = getDb();
  const homeTeam = alias(teamSeasons, "h2hlogs_home_team");
  const awayTeam = alias(teamSeasons, "h2hlogs_away_team");

  const rows = db
    .select({
      season: matchups.season,
      week: matchups.week,
      homeFranchiseId: homeTeam.franchiseId,
      awayFranchiseId: awayTeam.franchiseId,
      winner: matchups.winner,
    })
    .from(matchups)
    .innerJoin(homeTeam, eq(matchups.homeTeamSeasonId, homeTeam.id))
    .innerJoin(awayTeam, eq(matchups.awayTeamSeasonId, awayTeam.id))
    .where(and(eq(matchups.isFinal, true), or(eq(homeTeam.franchiseId, franchiseId), eq(awayTeam.franchiseId, franchiseId))))
    .all();

  const sorted = rows.sort((a, b) => a.season - b.season || a.week - b.week);

  const byOpponent = new Map<number, H2HGameLike[]>();
  for (const r of sorted) {
    const opponentId = r.homeFranchiseId === franchiseId ? r.awayFranchiseId : r.homeFranchiseId;
    const list = byOpponent.get(opponentId) ?? [];
    list.push(r as H2HGameLike);
    byOpponent.set(opponentId, list);
  }

  const out = new Map<number, H2HGameResult[]>();
  for (const [opponentId, games] of byOpponent) {
    out.set(opponentId, computeH2HGameLog(games, franchiseId).slice(-limit));
  }
  return out;
}
