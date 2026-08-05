import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { RecordKey } from "@/engines";
import { getDb } from "../db/client";
import {
  beltMatches,
  beltReigns,
  contextNotes,
  franchises,
  matchups,
  players,
  recordEntries,
  rosterSlots,
  teamSeasons,
  teamWeek,
  weeks,
  type Matchup,
} from "../db/schema";
import { getReignNoForGame } from "./belt";
import { getH2HPairDetail, type H2HPairDetail } from "./h2h";
import { computeSeasonSuperlatives, type SeasonSuperlatives, type TeamWeekLike } from "./seasons";

// ---------------------------------------------------------------------------
// /matchups — redirect target resolution
// ---------------------------------------------------------------------------

export interface WeekSignal {
  season: number;
  week: number;
  hasFinal: boolean;
}

/**
 * The newest season's most relevant week: its latest COMPLETED week if any
 * games have been played, else its EARLIEST scheduled week (what's coming up
 * next) — real case: 2026 has a full 14-week schedule already generated but
 * zero completed games, so this lands on week 1, not week 14. Pure —
 * unit-tested directly.
 */
export function computeLatestMatchupWeek(signals: WeekSignal[]): { season: number; week: number } | null {
  if (signals.length === 0) return null;
  const maxSeason = Math.max(...signals.map((s) => s.season));
  const seasonSignals = signals.filter((s) => s.season === maxSeason);
  const finals = seasonSignals.filter((s) => s.hasFinal);
  if (finals.length > 0) {
    return { season: maxSeason, week: Math.max(...finals.map((s) => s.week)) };
  }
  return { season: maxSeason, week: Math.min(...seasonSignals.map((s) => s.week)) };
}

export function getLatestMatchupWeek(): { season: number; week: number } | null {
  const db = getDb();
  const rows = db.select({ season: matchups.season, week: matchups.week, isFinal: matchups.isFinal }).from(matchups).all();
  const byKey = new Map<string, WeekSignal>();
  for (const r of rows) {
    const key = `${r.season}:${r.week}`;
    const existing = byKey.get(key);
    if (existing) existing.hasFinal = existing.hasFinal || r.isFinal;
    else byKey.set(key, { season: r.season, week: r.week, hasFinal: r.isFinal });
  }
  return computeLatestMatchupWeek([...byKey.values()]);
}

/**
 * The most recent COMPLETED week across ALL seasons (at least one final matchup), by (season,
 * week) descending — distinct from `computeLatestMatchupWeek`'s "what's most relevant to show
 * next" (which falls back to an upcoming week when nothing's been played yet, e.g. a fresh
 * season's week 1). Used for the home page's "Last time out" strip, which must never surface a
 * scheduled-but-unplayed week. Null only when no matchup has ever been final. Pure —
 * unit-tested directly.
 */
export function computeMostRecentCompletedWeek(signals: WeekSignal[]): { season: number; week: number } | null {
  const finals = signals.filter((s) => s.hasFinal);
  if (finals.length === 0) return null;
  const best = finals.reduce((best, s) => (s.season > best.season || (s.season === best.season && s.week > best.week) ? s : best));
  return { season: best.season, week: best.week };
}

// ---------------------------------------------------------------------------
// Week navigation
// ---------------------------------------------------------------------------

export interface WeekNav {
  prevWeek: number | null;
  nextWeek: number | null;
  seasonJumps: { season: number; targetWeek: number }[];
}

export function getWeekNav(season: number, week: number): WeekNav {
  const db = getDb();
  const seasonWeeks = db
    .select({ week: weeks.week })
    .from(weeks)
    .where(eq(weeks.season, season))
    .orderBy(asc(weeks.week))
    .all()
    .map((r) => r.week);

  const idx = seasonWeeks.indexOf(week);
  const prevWeek = idx > 0 ? seasonWeeks[idx - 1]! : null;
  const nextWeek = idx >= 0 && idx < seasonWeeks.length - 1 ? seasonWeeks[idx + 1]! : null;

  const allSignalRows = db.select({ season: matchups.season, week: matchups.week, isFinal: matchups.isFinal }).from(matchups).all();
  const byKey = new Map<string, WeekSignal>();
  for (const r of allSignalRows) {
    const key = `${r.season}:${r.week}`;
    const existing = byKey.get(key);
    if (existing) existing.hasFinal = existing.hasFinal || r.isFinal;
    else byKey.set(key, { season: r.season, week: r.week, hasFinal: r.isFinal });
  }
  const allSignals = [...byKey.values()];
  const seasonsAvailable = [...new Set(allSignals.map((s) => s.season))].sort((a, b) => b - a);
  const seasonJumps = seasonsAvailable.map((s) => {
    const target = computeLatestMatchupWeek(allSignals.filter((sig) => sig.season === s));
    return { season: s, targetWeek: target?.week ?? 1 };
  });

  return { prevWeek, nextWeek, seasonJumps };
}

// ---------------------------------------------------------------------------
// Week hub — matchup cards
// ---------------------------------------------------------------------------

export interface WeekMatchupSide {
  franchiseId: number;
  name: string;
  score: number | null;
  projected: number | null;
}

export interface WeekMatchupRow {
  matchupId: number;
  home: WeekMatchupSide;
  away: WeekMatchupSide | null; // null = bye
  isFinal: boolean;
  weekType: "regular" | "playoff" | "consolation" | "championship";
  playoffTier: string | null;
  beltAtStake: boolean;
  beltResult: "defense" | "transfer" | null;
  /** The single top context note for this matchup (by salience) — the week hub card's
   * lower-third line. Null when the game has no context notes (e.g. not yet played). */
  topNote: WeekMatchupTopNote | null;
  /**
   * Starters (both sides combined) with no points recorded yet — the week hub card's honest
   * "N to play" figure (README: status row shows "LIVE with pulsing dot, 'N left', or 'Final'").
   * Null when neither side has ANY roster_slots archived for this week yet (lineups not
   * locked/synced) — distinct from 0, which means a roster exists and everyone in it has already
   * scored. Never a fabricated "live" clock — purely a count of what's actually in the DB.
   */
  startersRemaining: number | null;
}

export interface WeekMatchupTopNote {
  ruleId: string;
  renderedText: string;
  /** True only for a belt_stakes note — the ONE case the matchup card renders gold, per
   * docs/design/redesign-2026-08/README.md's "Identity system" (design source of truth). */
  isBeltNote: boolean;
}

// ---------------------------------------------------------------------------
// Week hub card ranking + "starters remaining" (README: status row, card order)
// ---------------------------------------------------------------------------

export interface WeekHubCardRankInput {
  beltAtStake: boolean;
  isViewerGame: boolean;
}

/**
 * Card ranking, per README's Matchups week hub: the belt game leads; failing that, the viewer's
 * own game leads; everything else keeps its original relative order (stable sort). A belt game
 * that's ALSO the viewer's own game still just ranks first — there's nothing left to promote it
 * past. Pure; the caller resolves `isViewerGame` from the signed-in manager's franchise id.
 */
export function sortWeekHubCards<T extends WeekHubCardRankInput>(rows: T[]): T[] {
  const priority = (r: T): 0 | 1 | 2 => (r.beltAtStake ? 0 : r.isViewerGame ? 1 : 2);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => priority(a.r) - priority(b.r) || a.i - b.i)
    .map((x) => x.r);
}

export interface RosterProgressRow {
  teamSeasonId: number;
  isStarter: boolean;
  points: number | null;
}

/**
 * Per team_season_id: how many STARTER rows have no points recorded yet (`remaining`), and how
 * many starter rows exist at all (`total` — 0 means no roster synced for this team/week yet, a
 * different case from "everyone in it has already played"). Pure.
 */
export function summarizeRosterProgress(rows: RosterProgressRow[]): Map<number, { remaining: number; total: number }> {
  const out = new Map<number, { remaining: number; total: number }>();
  for (const r of rows) {
    if (!r.isStarter) continue;
    const cur = out.get(r.teamSeasonId) ?? { remaining: 0, total: 0 };
    cur.total += 1;
    if (r.points === null) cur.remaining += 1;
    out.set(r.teamSeasonId, cur);
  }
  return out;
}

export function getWeekMatchupRows(season: number, week: number): WeekMatchupRow[] {
  const db = getDb();
  const weekRow = db.select({ weekType: weeks.weekType }).from(weeks).where(and(eq(weeks.season, season), eq(weeks.week, week))).get();

  const homeTeam = alias(teamSeasons, "wm_home_team");
  const awayTeam = alias(teamSeasons, "wm_away_team");
  const homeFranchise = alias(franchises, "wm_home_franchise");
  const awayFranchise = alias(franchises, "wm_away_franchise");

  const rows = db
    .select({
      matchupId: matchups.id,
      isFinal: matchups.isFinal,
      playoffTier: matchups.playoffTier,
      homeScore: matchups.homeScore,
      awayScore: matchups.awayScore,
      homeProjected: matchups.homeProjected,
      awayProjected: matchups.awayProjected,
      homeTeamSeasonId: matchups.homeTeamSeasonId,
      awayTeamSeasonId: matchups.awayTeamSeasonId,
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
    .where(and(eq(matchups.season, season), eq(matchups.week, week)))
    .all();

  const matchupIds = rows.map((r) => r.matchupId);
  const beltRows = matchupIds.length > 0 ? db.select().from(beltMatches).where(inArray(beltMatches.matchupId, matchupIds)).all() : [];
  const beltByMatchup = new Map(beltRows.map((b) => [b.matchupId, b]));
  const currentReign = db.select({ franchiseId: beltReigns.franchiseId }).from(beltReigns).where(eq(beltReigns.isCurrent, true)).get();
  const topNoteByMatchup = getTopContextNotesByMatchup(db, matchupIds);

  // "N left to play" (README status row) — a real, honest count from whatever roster_slots the
  // worker has actually synced, never a fabricated live clock. See summarizeRosterProgress.
  const rosterProgressRows: RosterProgressRow[] = db
    .select({ teamSeasonId: rosterSlots.teamSeasonId, isStarter: rosterSlots.isStarter, points: rosterSlots.points })
    .from(rosterSlots)
    .where(and(eq(rosterSlots.season, season), eq(rosterSlots.week, week)))
    .all();
  const progressByTeamSeason = summarizeRosterProgress(rosterProgressRows);

  return rows.map((r) => {
    const belt = beltByMatchup.get(r.matchupId);
    // Belt-at-stake HEURISTIC for a not-yet-final matchup: there is no real belt_matches row
    // until the game is decided, so "is the current holder playing this week" is the best
    // available signal, not a certainty — see getMatchupDetail below for the identical rule.
    // Once `belt` truthy (a real belt_matches row exists), that's authoritative and wins outright
    // regardless of r.isFinal. LIMITATION: if the belt somehow changed hands mid-week-range from
    // a source other than this matchup (shouldn't happen — one game per matchup, replay() only
    // ever transfers the belt via the holder's own game), this heuristic could show stale
    // "at stake" info for an unrelated scheduled game; it self-corrects the instant the real game
    // is final and a real belt_matches row exists.
    const holderInThisGame =
      currentReign !== undefined && (currentReign.franchiseId === r.homeFranchiseId || currentReign.franchiseId === r.awayFranchiseId);

    const homeProgress = progressByTeamSeason.get(r.homeTeamSeasonId);
    const awayProgress = r.awayTeamSeasonId !== null ? progressByTeamSeason.get(r.awayTeamSeasonId) : undefined;
    const anyRosterSynced = (homeProgress?.total ?? 0) > 0 || (awayProgress?.total ?? 0) > 0;
    const startersRemaining = anyRosterSynced ? (homeProgress?.remaining ?? 0) + (awayProgress?.remaining ?? 0) : null;

    return {
      matchupId: r.matchupId,
      home: { franchiseId: r.homeFranchiseId, name: r.homeFranchiseName, score: r.isFinal ? r.homeScore : null, projected: r.homeProjected },
      away: r.awayFranchiseId
        ? { franchiseId: r.awayFranchiseId, name: r.awayFranchiseName!, score: r.isFinal ? r.awayScore : null, projected: r.awayProjected }
        : null,
      isFinal: r.isFinal,
      weekType: weekRow?.weekType ?? "regular",
      playoffTier: r.playoffTier,
      beltAtStake: belt !== undefined || (!r.isFinal && holderInThisGame),
      beltResult: belt?.result ?? null,
      topNote: topNoteByMatchup.get(r.matchupId) ?? null,
      startersRemaining,
    };
  });
}

/**
 * Every matchup's SINGLE top context note (by salience) — one query, grouped in memory.
 * `ORDER BY` carries a full deterministic tiebreak (rule_id, then id) so a salience tie between
 * two DIFFERENT subjects (e.g. a matchup-scope belt note and a team-week-scope season-rank note,
 * both salience 60) resolves the same way on every page load — SQLite's own tie order for
 * `ORDER BY salience DESC` alone is unspecified.
 */
function getTopContextNotesByMatchup(db: ReturnType<typeof getDb>, matchupIds: number[]): Map<number, WeekMatchupTopNote> {
  if (matchupIds.length === 0) return new Map();
  const rows = db
    .select({ matchupId: contextNotes.matchupId, ruleId: contextNotes.ruleId, salience: contextNotes.salience, renderedText: contextNotes.renderedText })
    .from(contextNotes)
    .where(inArray(contextNotes.matchupId, matchupIds))
    .orderBy(desc(contextNotes.salience), asc(contextNotes.ruleId), asc(contextNotes.id))
    .all();

  const best = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.matchupId === null) continue;
    const cur = best.get(r.matchupId);
    if (!cur || r.salience > cur.salience) best.set(r.matchupId, r);
  }

  const out = new Map<number, WeekMatchupTopNote>();
  for (const [matchupId, r] of best) {
    out.set(matchupId, { ruleId: r.ruleId, renderedText: r.renderedText, isBeltNote: r.ruleId === "belt_stakes" });
  }
  return out;
}

export function getWeekSuperlatives(season: number, week: number): SeasonSuperlatives {
  const db = getDb();
  const rows: TeamWeekLike[] = db
    .select({
      franchiseId: teamWeek.franchiseId,
      opponentFranchiseId: teamWeek.opponentFranchiseId,
      score: teamWeek.score,
      margin: teamWeek.margin,
      result: teamWeek.result,
      week: teamWeek.week,
    })
    .from(teamWeek)
    .where(and(eq(teamWeek.season, season), eq(teamWeek.week, week)))
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

// ---------------------------------------------------------------------------
// Matchup detail
// ---------------------------------------------------------------------------

const SLOT_DISPLAY_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K", "BE", "IR"];

export interface RosterRow {
  playerName: string;
  position: string;
  /** NFL team abbreviation (e.g. "PHI") — real, from `players.proTeam`; null when ESPN never gave
   * this player a resolvable pro team (see `PRO_TEAM_MAP` in `src/server/sync/normalize.ts`). */
  proTeam: string | null;
  lineupSlot: string;
  isStarter: boolean;
  points: number | null;
}

/** Starters in slot order, then bench/IR. Ties within a slot broken by points desc. Pure. */
export function sortRosterRows(rows: RosterRow[]): RosterRow[] {
  const orderIndex = (slot: string) => {
    const i = SLOT_DISPLAY_ORDER.indexOf(slot);
    return i === -1 ? SLOT_DISPLAY_ORDER.length : i;
  };
  return [...rows].sort((a, b) => {
    const slotDiff = orderIndex(a.lineupSlot) - orderIndex(b.lineupSlot);
    if (slotDiff !== 0) return slotDiff;
    return (b.points ?? 0) - (a.points ?? 0);
  });
}

/**
 * How many STARTERS have no points recorded yet — the matchup detail score head's honest "N to
 * play" figure (README: efficiency line appends "· N to play"). Never a fabricated live clock,
 * purely a count of what the box score itself already says. Pure.
 */
export function countUnplayedStarters(rows: RosterRow[]): number {
  return rows.filter((r) => r.isStarter && r.points === null).length;
}

export interface MatchupOptimalLine {
  actual: number;
  optimal: number | null;
  benchLeft: number | null;
  /**
   * Read directly from team_week.efficiency (already computed by the stats build) — fix round 1
   * minor: never recompute `actual / optimal` at the page layer, which would silently disagree
   * with the canonical value on any float-precision edge case and duplicate logic that's already
   * correct in exactly one place.
   */
  efficiency: number | null;
}

export interface MatchupSideDetail {
  franchiseId: number;
  franchiseName: string;
  score: number;
  projected: number | null;
  optimal: MatchupOptimalLine;
  /** Starters with no points recorded yet, from this side's own box score rows — null when no
   * roster_slots are archived for this team/week at all (distinct from 0 = full roster, everyone
   * already played). */
  unplayedStarters: number | null;
}

export interface MatchupRecordCallout {
  recordKey: RecordKey;
  rank: number;
  franchiseId: number;
  franchiseName: string;
  value: number;
}

export interface MatchupContextNote {
  ruleId: string;
  salience: number;
  renderedText: string;
  franchiseId: number | null;
  franchiseName: string | null;
  /** True only for a belt_stakes note — the ONE case this page renders gold. */
  isBeltNote: boolean;
}

export interface MatchupDetail {
  matchupId: number;
  season: number;
  week: number;
  weekType: "regular" | "playoff" | "consolation" | "championship";
  playoffTier: string | null;
  isFinal: boolean;
  home: MatchupSideDetail;
  away: MatchupSideDetail | null;
  margin: number | null;
  boxScore: { home: RosterRow[]; away: RosterRow[] } | null;
  h2h: H2HPairDetail | null;
  belt: {
    atStake: boolean;
    result: "defense" | "transfer" | null;
    holderId: number | null;
    challengerId: number | null;
    /** Null when `holderId` is null, or when no belt_reigns row's span actually encloses this
     * game (shouldn't happen for real data, but never fabricated). */
    holderReignNo: number | null;
  } | null;
  records: MatchupRecordCallout[];
  /** Top 3 across BOTH team_weeks + the matchup itself, salience order — see src/engines/context.ts. */
  contextNotes: MatchupContextNote[];
}

function loadMatchupRow(db: ReturnType<typeof getDb>, matchupId: number): Matchup | undefined {
  return db.select().from(matchups).where(eq(matchups.id, matchupId)).get();
}

export function getMatchupDetail(matchupId: number): MatchupDetail | null {
  const db = getDb();
  const m = loadMatchupRow(db, matchupId);
  if (!m) return null;

  const weekRow = db.select({ weekType: weeks.weekType }).from(weeks).where(and(eq(weeks.season, m.season), eq(weeks.week, m.week))).get();

  const homeTeamSeason = db.select().from(teamSeasons).where(eq(teamSeasons.id, m.homeTeamSeasonId)).get()!;
  const awayTeamSeason = m.awayTeamSeasonId !== null ? db.select().from(teamSeasons).where(eq(teamSeasons.id, m.awayTeamSeasonId)).get() : undefined;

  const franchiseIds = [homeTeamSeason.franchiseId, ...(awayTeamSeason ? [awayTeamSeason.franchiseId] : [])];
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).where(inArray(franchises.id, franchiseIds)).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  const homeTeamWeek = db
    .select()
    .from(teamWeek)
    .where(and(eq(teamWeek.season, m.season), eq(teamWeek.week, m.week), eq(teamWeek.franchiseId, homeTeamSeason.franchiseId)))
    .get();
  const awayTeamWeek = awayTeamSeason
    ? db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, m.season), eq(teamWeek.week, m.week), eq(teamWeek.franchiseId, awayTeamSeason.franchiseId)))
        .get()
    : undefined;

  // Box score — pre-2018 has zero roster_slots archived for any week; null (not empty arrays)
  // signals "no lineup data" so the page can render the honest empty state rather than an
  // empty-looking table. Computed before home/away below since each side's `unplayedStarters`
  // reads from its own rows here.
  const teamSeasonIds = [homeTeamSeason.id, ...(awayTeamSeason ? [awayTeamSeason.id] : [])];
  const rosterRows = db
    .select({
      teamSeasonId: rosterSlots.teamSeasonId,
      lineupSlot: rosterSlots.lineupSlot,
      isStarter: rosterSlots.isStarter,
      points: rosterSlots.points,
      playerName: players.fullName,
      position: players.defaultPosition,
      proTeam: players.proTeam,
    })
    .from(rosterSlots)
    .innerJoin(players, eq(rosterSlots.playerId, players.espnPlayerId))
    .where(and(eq(rosterSlots.season, m.season), eq(rosterSlots.week, m.week), inArray(rosterSlots.teamSeasonId, teamSeasonIds)))
    .all();

  const toRosterRow = (r: (typeof rosterRows)[number]): RosterRow => ({
    playerName: r.playerName,
    position: r.position,
    proTeam: r.proTeam,
    lineupSlot: r.lineupSlot,
    isStarter: r.isStarter,
    points: r.points,
  });

  const homeRosterRows = rosterRows.filter((r) => r.teamSeasonId === homeTeamSeason.id).map(toRosterRow);
  const awayRosterRows = awayTeamSeason ? rosterRows.filter((r) => r.teamSeasonId === awayTeamSeason.id).map(toRosterRow) : [];

  const boxScore =
    rosterRows.length === 0
      ? null
      : {
          home: sortRosterRows(homeRosterRows),
          away: sortRosterRows(awayRosterRows),
        };

  const home: MatchupSideDetail = {
    franchiseId: homeTeamSeason.franchiseId,
    franchiseName: nameById.get(homeTeamSeason.franchiseId) ?? "—",
    score: m.homeScore,
    projected: m.homeProjected,
    optimal: {
      actual: m.homeScore,
      optimal: homeTeamWeek?.optimalScore ?? null,
      benchLeft: homeTeamWeek?.benchPointsLeft ?? null,
      efficiency: homeTeamWeek?.efficiency ?? null,
    },
    unplayedStarters: homeRosterRows.length > 0 ? countUnplayedStarters(homeRosterRows) : null,
  };
  const away: MatchupSideDetail | null = awayTeamSeason
    ? {
        franchiseId: awayTeamSeason.franchiseId,
        franchiseName: nameById.get(awayTeamSeason.franchiseId) ?? "—",
        score: m.awayScore,
        projected: m.awayProjected,
        optimal: {
          actual: m.awayScore,
          optimal: awayTeamWeek?.optimalScore ?? null,
          benchLeft: awayTeamWeek?.benchPointsLeft ?? null,
          efficiency: awayTeamWeek?.efficiency ?? null,
        },
        unplayedStarters: awayRosterRows.length > 0 ? countUnplayedStarters(awayRosterRows) : null,
      }
    : null;

  const h2h = awayTeamSeason ? getH2HPairDetail(home.franchiseId, awayTeamSeason.franchiseId) : null;

  const beltMatch = db.select().from(beltMatches).where(eq(beltMatches.matchupId, matchupId)).get();
  const currentReign = db.select({ franchiseId: beltReigns.franchiseId }).from(beltReigns).where(eq(beltReigns.isCurrent, true)).get();
  // Same belt-at-stake HEURISTIC as getWeekMatchupRows above, for the identical reason: a
  // not-yet-final matchup has no real belt_matches row yet, so "the current holder is one of
  // these two teams" is the best available signal, not a certainty. `beltMatch` (a real row)
  // always wins outright when present. LIMITATION: same as above — self-corrects once this game
  // is final and a real belt_matches row exists.
  const holderInThisGame =
    !m.isFinal && currentReign !== undefined && (currentReign.franchiseId === home.franchiseId || currentReign.franchiseId === away?.franchiseId);
  const beltHolderId = beltMatch ? beltMatch.holderFranchiseId : holderInThisGame ? currentReign!.franchiseId : null;
  const belt =
    beltMatch || holderInThisGame
      ? {
          atStake: true,
          result: beltMatch?.result ?? null,
          holderId: beltHolderId,
          challengerId: beltMatch
            ? beltMatch.challengerFranchiseId
            : (currentReign!.franchiseId === home.franchiseId ? (away?.franchiseId ?? null) : home.franchiseId),
          // "Belt holder · reign N" (README score head eyebrow) — resolved for the game's OWN
          // holder at the game's OWN (season, week), so a historical belt game still reads the
          // reign that was live at the time, not whatever reign is current today.
          holderReignNo: beltHolderId !== null ? getReignNoForGame(beltHolderId, m.season, m.week) : null,
        }
      : null;

  const recordRows = db
    .select({ recordKey: recordEntries.recordKey, rank: recordEntries.rank, franchiseId: recordEntries.franchiseId, value: recordEntries.value })
    .from(recordEntries)
    .where(
      and(
        eq(recordEntries.season, m.season),
        eq(recordEntries.week, m.week),
        inArray(recordEntries.franchiseId, franchiseIds),
      ),
    )
    .all()
    .filter((r) => r.rank <= 3);
  const records: MatchupRecordCallout[] = recordRows.map((r) => ({
    recordKey: r.recordKey as RecordKey,
    rank: r.rank,
    franchiseId: r.franchiseId,
    franchiseName: nameById.get(r.franchiseId) ?? "—",
    value: r.value,
  }));

  // Every team_week-sourced note carries this SAME matchupId (build.ts resolves it from the
  // team_week's own matchup_id), so one query on matchup_id alone captures both team-weeks' notes
  // AND the matchup-scoped ones (margin_rank/h2h_milestone/belt_stakes) together. The full
  // (salience, rule_id, id) ORDER BY is a deterministic tiebreak — combining notes from up to 3
  // DIFFERENT subjects here (both team-weeks + the matchup) can genuinely tie on salience, and
  // SQLite's own order for ties is otherwise unspecified.
  const contextNoteRows = db
    .select({
      ruleId: contextNotes.ruleId,
      salience: contextNotes.salience,
      renderedText: contextNotes.renderedText,
      franchiseId: contextNotes.franchiseId,
    })
    .from(contextNotes)
    .where(eq(contextNotes.matchupId, matchupId))
    .orderBy(desc(contextNotes.salience), asc(contextNotes.ruleId), asc(contextNotes.id))
    .limit(3)
    .all();
  const contextNoteViews: MatchupContextNote[] = contextNoteRows.map((r) => ({
    ruleId: r.ruleId,
    salience: r.salience,
    renderedText: r.renderedText,
    franchiseId: r.franchiseId,
    franchiseName: r.franchiseId !== null ? (nameById.get(r.franchiseId) ?? "—") : null,
    isBeltNote: r.ruleId === "belt_stakes",
  }));

  return {
    matchupId,
    season: m.season,
    week: m.week,
    weekType: weekRow?.weekType ?? "regular",
    playoffTier: m.playoffTier,
    isFinal: m.isFinal,
    home,
    away,
    margin: away ? Math.abs(m.homeScore - m.awayScore) : null,
    boxScore,
    h2h,
    belt,
    records,
    contextNotes: contextNoteViews,
  };
}
