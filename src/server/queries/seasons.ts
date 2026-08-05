import { and, asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { getDb } from "../db/client";
import {
  beltMatches,
  draftPicks,
  franchises,
  matchups,
  players,
  seasonStats,
  seasons,
  teamSeasons,
  teamWeek,
  weeks,
} from "../db/schema";

// ---------------------------------------------------------------------------
// /seasons index
// ---------------------------------------------------------------------------

export interface SeasonIndexRow {
  season: number;
  status: "upcoming" | "active" | "complete";
  teamCount: number;
  champion: { id: number; name: string } | null;
  runnerUp: { id: number; name: string } | null;
  sacko: { id: number; name: string } | null;
  highestWeek: { franchiseName: string; value: number; week: number } | null;
}

interface WeekScoreRow {
  season: number;
  week: number;
  score: number;
  franchiseId: number;
}

/** Best single week per season, by score. Pure — unit-tested directly. */
export function computeHighestWeekBySeason(rows: WeekScoreRow[]): Map<number, WeekScoreRow> {
  const bySeason = new Map<number, WeekScoreRow>();
  for (const r of rows) {
    const cur = bySeason.get(r.season);
    if (!cur || r.score > cur.score) bySeason.set(r.season, r);
  }
  return bySeason;
}

export function getSeasonIndex(): SeasonIndexRow[] {
  const db = getDb();
  const seasonRows = db.select().from(seasons).orderBy(desc(seasons.season)).all();
  const statsRows = db
    .select({
      season: seasonStats.season,
      franchiseId: seasonStats.franchiseId,
      finalStanding: seasonStats.finalStanding,
      champion: seasonStats.champion,
      sacko: seasonStats.sacko,
    })
    .from(seasonStats)
    .all();
  const weekRows = db
    .select({ season: teamWeek.season, week: teamWeek.week, score: teamWeek.score, franchiseId: teamWeek.franchiseId })
    .from(teamWeek)
    .all();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  const highestBySeason = computeHighestWeekBySeason(weekRows);
  const statsBySeason = new Map<number, typeof statsRows>();
  for (const r of statsRows) {
    const list = statsBySeason.get(r.season) ?? [];
    list.push(r);
    statsBySeason.set(r.season, list);
  }

  return seasonRows.map((s) => {
    const rowsForSeason = statsBySeason.get(s.season) ?? [];
    const champion = rowsForSeason.find((r) => r.champion);
    const runnerUp = rowsForSeason.find((r) => r.finalStanding === 2);
    const sacko = rowsForSeason.find((r) => r.sacko);
    const hw = highestBySeason.get(s.season);

    return {
      season: s.season,
      status: s.status,
      teamCount: s.teamCount,
      champion: champion ? { id: champion.franchiseId, name: nameById.get(champion.franchiseId) ?? "—" } : null,
      runnerUp: runnerUp ? { id: runnerUp.franchiseId, name: nameById.get(runnerUp.franchiseId) ?? "—" } : null,
      sacko: sacko ? { id: sacko.franchiseId, name: nameById.get(sacko.franchiseId) ?? "—" } : null,
      highestWeek: hw ? { franchiseName: nameById.get(hw.franchiseId) ?? "—", value: hw.score, week: hw.week } : null,
    };
  });
}

// ---------------------------------------------------------------------------
// /seasons/[year] — standings
// ---------------------------------------------------------------------------

export interface SeasonStandingRow {
  franchiseId: number;
  franchiseName: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  allplayW: number;
  allplayL: number;
  allplayT: number;
  luckTotal: number | null;
  efficiencyAvg: number | null;
  finalStanding: number | null;
  champion: boolean;
  sacko: boolean;
  madePlayoffs: boolean;
}

export function getSeasonStandings(year: number): SeasonStandingRow[] {
  const db = getDb();
  return db
    .select({
      franchiseId: teamSeasons.franchiseId,
      franchiseName: franchises.canonicalName,
      wins: teamSeasons.wins,
      losses: teamSeasons.losses,
      ties: teamSeasons.ties,
      pointsFor: teamSeasons.pointsFor,
      pointsAgainst: teamSeasons.pointsAgainst,
      allplayW: seasonStats.allplayW,
      allplayL: seasonStats.allplayL,
      allplayT: seasonStats.allplayT,
      luckTotal: seasonStats.luckTotal,
      efficiencyAvg: seasonStats.efficiencyAvg,
      finalStanding: teamSeasons.finalStanding,
      champion: seasonStats.champion,
      sacko: seasonStats.sacko,
      madePlayoffs: teamSeasons.madePlayoffs,
    })
    .from(teamSeasons)
    .innerJoin(franchises, eq(teamSeasons.franchiseId, franchises.id))
    .leftJoin(seasonStats, and(eq(seasonStats.season, teamSeasons.season), eq(seasonStats.franchiseId, teamSeasons.franchiseId)))
    .where(eq(teamSeasons.season, year))
    .orderBy(asc(teamSeasons.finalStanding))
    .all()
    .map((r) => ({
      ...r,
      allplayW: r.allplayW ?? 0,
      allplayL: r.allplayL ?? 0,
      allplayT: r.allplayT ?? 0,
      champion: r.champion ?? false,
      sacko: r.sacko ?? false,
    }));
}

// ---------------------------------------------------------------------------
// /seasons/[year] — weekly results grid
// ---------------------------------------------------------------------------

export interface SeasonWeekMatchup {
  homeFranchiseId: number;
  homeFranchiseName: string;
  awayFranchiseId: number | null;
  awayFranchiseName: string | null;
  homeScore: number;
  awayScore: number;
  isFinal: boolean;
  playoffTier: string | null;
}

export interface SeasonWeekGroup {
  week: number;
  weekType: "regular" | "playoff" | "consolation" | "championship";
  matchups: SeasonWeekMatchup[];
}

export function getSeasonWeeks(year: number): SeasonWeekGroup[] {
  const db = getDb();
  const weekRows = db.select().from(weeks).where(eq(weeks.season, year)).orderBy(asc(weeks.week)).all();

  const homeTeam = alias(teamSeasons, "sw_home_team");
  const awayTeam = alias(teamSeasons, "sw_away_team");
  const homeFranchise = alias(franchises, "sw_home_franchise");
  const awayFranchise = alias(franchises, "sw_away_franchise");

  const matchupRows = db
    .select({
      week: matchups.week,
      homeScore: matchups.homeScore,
      awayScore: matchups.awayScore,
      isFinal: matchups.isFinal,
      playoffTier: matchups.playoffTier,
      homeFranchiseId: homeFranchise.id,
      homeFranchiseName: homeFranchise.canonicalName,
      awayFranchiseId: awayFranchise.id,
      awayFranchiseName: awayFranchise.canonicalName,
    })
    .from(matchups)
    .innerJoin(homeTeam, eq(matchups.homeTeamSeasonId, homeTeam.id))
    .innerJoin(homeFranchise, eq(homeTeam.franchiseId, homeFranchise.id))
    .leftJoin(awayTeam, eq(matchups.awayTeamSeasonId, awayTeam.id))
    .leftJoin(awayFranchise, eq(awayTeam.franchiseId, awayFranchise.id))
    .where(eq(matchups.season, year))
    .all();

  const byWeek = new Map<number, SeasonWeekMatchup[]>();
  for (const m of matchupRows) {
    const list = byWeek.get(m.week) ?? [];
    list.push({
      homeFranchiseId: m.homeFranchiseId,
      homeFranchiseName: m.homeFranchiseName,
      awayFranchiseId: m.awayFranchiseId,
      awayFranchiseName: m.awayFranchiseName,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
      isFinal: m.isFinal,
      playoffTier: m.playoffTier,
    });
    byWeek.set(m.week, list);
  }

  return weekRows.map((w) => ({ week: w.week, weekType: w.weekType, matchups: byWeek.get(w.week) ?? [] }));
}

// ---------------------------------------------------------------------------
// /seasons/[year] — draft board
// ---------------------------------------------------------------------------

export interface DraftPickCell {
  round: number;
  roundPick: number;
  overallPick: number;
  playerId: number;
  playerName: string;
  position: string;
  teamName: string;
  keeper: boolean;
}

/**
 * ESPN's sentinel "no real player attached yet" id — `draft_picks.player_id = -1`,
 * `players.full_name` "Unknown Player -1". NOT the same thing as a real D/ST "player" (those use
 * large negative ids instead, e.g. -16001.."Falcons D/ST" — genuine historical picks, never
 * filtered). Real case this exists for: the real 2026 season's 192 draft_picks rows are ALL
 * `-1` (ESPN's pre-draft placeholder state, not a completed draft) — same sentinel-as-real-data
 * class of bug as the standings/weekly-results 0-placeholder fixes elsewhere in this task.
 */
export const SENTINEL_PLAYER_ID = -1;

/**
 * Round x pick grid, 1-indexed input mapped to 0-indexed rows/cols. Drops sentinel picks
 * entirely before shaping the grid — for a season where EVERY pick is a sentinel (real 2026),
 * this naturally empties the grid so the page's "Draft not yet held" state fires, rather than
 * rendering 192 cells of "Unknown Player -1" as though it were a real draft board. For a
 * completed season with a handful of individually-unresolved picks (real 2015-2025 data quality
 * gaps), those specific cells go blank rather than showing a fabricated player name. Pure —
 * unit-tested directly.
 */
export function buildDraftBoardGrid(picks: DraftPickCell[], teamCount: number): (DraftPickCell | null)[][] {
  const realPicks = picks.filter((p) => p.playerId !== SENTINEL_PLAYER_ID);
  if (teamCount <= 0 || realPicks.length === 0) return [];
  const maxRound = realPicks.reduce((m, p) => Math.max(m, p.round), 0);
  const grid: (DraftPickCell | null)[][] = Array.from({ length: maxRound }, () => Array<DraftPickCell | null>(teamCount).fill(null));

  for (const p of realPicks) {
    if (p.round >= 1 && p.round <= maxRound && p.roundPick >= 1 && p.roundPick <= teamCount) {
      grid[p.round - 1]![p.roundPick - 1] = p;
    }
  }

  return grid;
}

export interface SeasonDraftBoard {
  grid: (DraftPickCell | null)[][];
  teamCount: number;
}

export function getSeasonDraftBoard(year: number): SeasonDraftBoard {
  const db = getDb();
  const seasonRow = db.select({ teamCount: seasons.teamCount }).from(seasons).where(eq(seasons.season, year)).get();
  const teamCount = seasonRow?.teamCount ?? 0;

  const picks = db
    .select({
      round: draftPicks.round,
      roundPick: draftPicks.roundPick,
      overallPick: draftPicks.overallPick,
      keeper: draftPicks.keeper,
      playerId: draftPicks.playerId,
      playerName: players.fullName,
      position: players.defaultPosition,
      teamName: teamSeasons.teamName,
    })
    .from(draftPicks)
    .innerJoin(players, eq(draftPicks.playerId, players.espnPlayerId))
    .innerJoin(teamSeasons, eq(draftPicks.teamSeasonId, teamSeasons.id))
    .where(eq(draftPicks.season, year))
    .orderBy(asc(draftPicks.overallPick))
    .all();

  return { grid: buildDraftBoardGrid(picks, teamCount), teamCount };
}

// ---------------------------------------------------------------------------
// /seasons/[year] — belt activity
// ---------------------------------------------------------------------------

export interface SeasonBeltActivityRow {
  week: number;
  holderName: string;
  challengerName: string;
  result: "defense" | "transfer";
  holderScore: number;
  challengerScore: number;
}

export function getSeasonBeltActivity(year: number): SeasonBeltActivityRow[] {
  const db = getDb();
  const rows = db.select().from(beltMatches).where(eq(beltMatches.season, year)).orderBy(asc(beltMatches.week)).all();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  return rows.map((r) => ({
    week: r.week,
    holderName: nameById.get(r.holderFranchiseId) ?? "—",
    challengerName: nameById.get(r.challengerFranchiseId) ?? "—",
    result: r.result,
    holderScore: r.holderScore,
    challengerScore: r.challengerScore,
  }));
}

// ---------------------------------------------------------------------------
// /seasons/[year] — superlatives
// ---------------------------------------------------------------------------

export interface TeamWeekLike {
  franchiseId: number;
  opponentFranchiseId: number | null;
  score: number;
  margin: number | null;
  result: "W" | "L" | "T" | null;
  week: number;
}

export interface SeasonSuperlativesIds {
  highestWeek: { franchiseId: number; value: number; week: number } | null;
  biggestBlowout: { winnerFranchiseId: number; loserFranchiseId: number; margin: number; week: number } | null;
  closestGame: { franchiseIdA: number; franchiseIdB: number; margin: number; week: number } | null;
  /** Task 17 — "Beatdown of the Week": the LARGEST losing margin (most negative) this
   * season/week-scope, LOSER-attributed — the shame side of `biggestBlowout`. */
  beatdown: { franchiseId: number; opponentFranchiseId: number; margin: number; week: number } | null;
}

/**
 * Season-scoped (not all-time) superlatives from a season's team_week rows —
 * deliberately distinct from record_entries, which ranks across ALL seasons.
 * Pure — unit-tested directly against fixture rows.
 */
export function computeSeasonSuperlatives(rows: TeamWeekLike[]): SeasonSuperlativesIds {
  const played = rows.filter((r) => r.result !== null);

  let highestWeek: SeasonSuperlativesIds["highestWeek"] = null;
  for (const r of played) {
    if (!highestWeek || r.score > highestWeek.value) highestWeek = { franchiseId: r.franchiseId, value: r.score, week: r.week };
  }

  const wins = played.filter((r) => r.result === "W" && r.margin !== null && r.opponentFranchiseId !== null);
  let biggestBlowout: SeasonSuperlativesIds["biggestBlowout"] = null;
  let closestGame: SeasonSuperlativesIds["closestGame"] = null;
  for (const r of wins) {
    const margin = r.margin!;
    if (!biggestBlowout || margin > biggestBlowout.margin) {
      biggestBlowout = { winnerFranchiseId: r.franchiseId, loserFranchiseId: r.opponentFranchiseId!, margin, week: r.week };
    }
    if (!closestGame || margin < closestGame.margin) {
      closestGame = { franchiseIdA: r.franchiseId, franchiseIdB: r.opponentFranchiseId!, margin, week: r.week };
    }
  }

  const losses = played.filter((r) => r.result === "L" && r.margin !== null && r.opponentFranchiseId !== null);
  let beatdown: SeasonSuperlativesIds["beatdown"] = null;
  for (const r of losses) {
    const margin = r.margin!;
    if (!beatdown || margin < beatdown.margin) {
      beatdown = { franchiseId: r.franchiseId, opponentFranchiseId: r.opponentFranchiseId!, margin, week: r.week };
    }
  }

  return { highestWeek, biggestBlowout, closestGame, beatdown };
}

export interface SeasonSuperlatives {
  highestWeek: { franchiseId: number; franchiseName: string; value: number; week: number } | null;
  biggestBlowout: { winnerFranchiseId: number; winnerName: string; loserFranchiseId: number; loserName: string; margin: number; week: number } | null;
  closestGame: { franchiseIdA: number; aName: string; franchiseIdB: number; bName: string; margin: number; week: number } | null;
  beatdown: { franchiseId: number; franchiseName: string; opponentFranchiseId: number; opponentName: string; margin: number; week: number } | null;
}

export function getSeasonSuperlatives(year: number): SeasonSuperlatives {
  const db = getDb();
  const rows = db
    .select({
      franchiseId: teamWeek.franchiseId,
      opponentFranchiseId: teamWeek.opponentFranchiseId,
      score: teamWeek.score,
      margin: teamWeek.margin,
      result: teamWeek.result,
      week: teamWeek.week,
    })
    .from(teamWeek)
    .where(eq(teamWeek.season, year))
    .all();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));
  const nameOf = (id: number) => nameById.get(id) ?? "—";

  const ids = computeSeasonSuperlatives(rows);

  return {
    highestWeek: ids.highestWeek
      ? { franchiseId: ids.highestWeek.franchiseId, franchiseName: nameOf(ids.highestWeek.franchiseId), value: ids.highestWeek.value, week: ids.highestWeek.week }
      : null,
    biggestBlowout: ids.biggestBlowout
      ? {
          winnerFranchiseId: ids.biggestBlowout.winnerFranchiseId,
          winnerName: nameOf(ids.biggestBlowout.winnerFranchiseId),
          loserFranchiseId: ids.biggestBlowout.loserFranchiseId,
          loserName: nameOf(ids.biggestBlowout.loserFranchiseId),
          margin: ids.biggestBlowout.margin,
          week: ids.biggestBlowout.week,
        }
      : null,
    closestGame: ids.closestGame
      ? {
          franchiseIdA: ids.closestGame.franchiseIdA,
          aName: nameOf(ids.closestGame.franchiseIdA),
          franchiseIdB: ids.closestGame.franchiseIdB,
          bName: nameOf(ids.closestGame.franchiseIdB),
          margin: ids.closestGame.margin,
          week: ids.closestGame.week,
        }
      : null,
    beatdown: ids.beatdown
      ? {
          franchiseId: ids.beatdown.franchiseId,
          franchiseName: nameOf(ids.beatdown.franchiseId),
          opponentFranchiseId: ids.beatdown.opponentFranchiseId,
          opponentName: nameOf(ids.beatdown.opponentFranchiseId),
          margin: ids.beatdown.margin,
          week: ids.beatdown.week,
        }
      : null,
  };
}
