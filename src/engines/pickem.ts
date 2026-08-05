/**
 * Weekly Pick'em (Task 31) — pure decision/scoring logic. No DB, no IO, per AGENTS.md. DB
 * orchestration (which week is "current" against real matchup rows, the wall-clock lock check,
 * loading the pre-lock Elo snapshot) lives in src/server/sync/pickem-lock.ts; web-facing reads live
 * in src/features/pickem/queries.ts.
 */
import { ELO_START, eloExpected } from "./replay";

// ---------------------------------------------------------------------------
// Current week resolution
// ---------------------------------------------------------------------------

export interface PickemWeekSignal {
  season: number;
  week: number;
  /** True iff EVERY matchup in this (season, week) is final. A bye counts as final — see
   * normalize.ts: a bye's `isFinal` is always true ("nothing pending"), so an odd-team-count week
   * can never get stuck "not fully final" forever just because of its bye. */
  allFinal: boolean;
}

/**
 * The "current" pick'em week: the EARLIEST week of the newest season that is NOT yet fully final.
 * Deliberately distinct from src/server/queries/matchups.ts's computeLatestMatchupWeek (which
 * shows the latest COMPLETED week until the NEXT week has at least one final game — right for
 * "what to display by default," wrong here: pick'em must open week N+1 for picking the moment
 * week N finishes going final, days before week N+1's own Thursday, not wait for week N+1 to have
 * already started). Real 2026 case verified on a scratch copy: preseason, week 1's 84 matchup
 * shells all non-final (real 0-0 UNDECIDED, per ESPN's pre-kickoff sentinel — never fabricated as
 * "final") -> week 1 is "current" and open. Pure — unit-tested directly.
 */
export function computeCurrentPickemWeek(signals: PickemWeekSignal[]): { season: number; week: number } | null {
  if (signals.length === 0) return null;
  const maxSeason = Math.max(...signals.map((s) => s.season));
  const open = signals.filter((s) => s.season === maxSeason && !s.allFinal);
  if (open.length === 0) return null; // whole season generated so far is final — nothing open to pick
  return { season: maxSeason, week: Math.min(...open.map((s) => s.week)) };
}

// ---------------------------------------------------------------------------
// Lock — data-driven floor (fix round 1)
// ---------------------------------------------------------------------------

export interface PickemLockMatchupSignal {
  isFinal: boolean;
  homeScore: number;
  awayScore: number;
}

/**
 * True iff ANY matchup in the given week has genuinely started — either already final, or
 * carrying a nonzero score on either side. Fix round 1: this is the DATA half of the lock check
 * (src/server/sync/pickem-lock.ts's `isPickemLocked` ORs this with the wall-clock
 * `isThursdayLockPassed` floor) — a wall-clock-only check spuriously reopens the SAME still-current
 * week every Monday-Wednesday, since a week routinely doesn't resolve to fully-final until Tuesday
 * (see the espn-fantasy-data skill's sentinel table: unplayed matchup scores are `0.0` with
 * `winner: 'UNDECIDED'`, and a real score, once nonzero, never resets back to zero). A preseason
 * schedule shell (0-0, not final) always reads `false` here — never fabricates a start that hasn't
 * happened — while a genuinely started game (even mid-live, well before going final) reads `true`
 * the instant its score moves off zero. Pure.
 */
export function hasAnyGameBegun(matchups: PickemLockMatchupSignal[]): boolean {
  return matchups.some((m) => m.isFinal || m.homeScore !== 0 || m.awayScore !== 0);
}

// ---------------------------------------------------------------------------
// "The Algorithm" — deterministic Elo-based picks (no Anthropic API in v1)
// ---------------------------------------------------------------------------

export interface AlgorithmPickMatchupInput {
  matchupId: number;
  homeFranchiseId: number;
  awayFranchiseId: number;
}

export interface AlgorithmPickResult {
  matchupId: number;
  pickedFranchiseId: number;
}

/**
 * "The Algorithm"'s pick for every matchup: whichever side has the higher pre-lock Elo (equivalent
 * to `eloExpected(...) >= 0.5`) wins the pick. `eloByFranchiseId` supplies each franchise's Elo
 * rating AS OF LOCK TIME — see src/server/sync/pickem-lock.ts's `loadPreLockEloByFranchise` for
 * EXACTLY which elo_history snapshot that is. A franchise absent from the map (no elo_history row
 * at all — a brand-new franchise, or before the league's very first completed game) defaults to
 * `ELO_START` (1500), the SAME neutral starting value src/engines/replay.ts itself assigns every
 * franchise's first-ever game — never fabricated. An EXACT Elo tie breaks toward the home side —
 * arbitrary but fixed and documented, never a coin flip, so "same Elo state -> same picks" (the
 * brief's determinism requirement) always holds byte-for-byte.
 */
export function computeAlgorithmPicks(
  matchups: AlgorithmPickMatchupInput[],
  eloByFranchiseId: ReadonlyMap<number, number>,
): AlgorithmPickResult[] {
  return matchups.map((m) => {
    const homeElo = eloByFranchiseId.get(m.homeFranchiseId) ?? ELO_START;
    const awayElo = eloByFranchiseId.get(m.awayFranchiseId) ?? ELO_START;
    const homeExpected = eloExpected(homeElo, awayElo);
    return { matchupId: m.matchupId, pickedFranchiseId: homeExpected >= 0.5 ? m.homeFranchiseId : m.awayFranchiseId };
  });
}

// ---------------------------------------------------------------------------
// Scoring — 1 point per correct pick, FINAL matchups only (no partial credit mid-week)
// ---------------------------------------------------------------------------

export interface PickemPickInput {
  /** Caller-chosen stable id, e.g. `manager:${managerId}` or `"algorithm"` — this engine never
   * needs to know the difference, both are just entrants. */
  entrantId: string;
  matchupId: number;
  pickedFranchiseId: number;
}

export interface PickemMatchupResult {
  matchupId: number;
  isFinal: boolean;
  /** Null when the matchup isn't final yet, OR its real result was a tie (`matchups.winner ===
   * "tie"`) — nobody "won" for a picker to have correctly called, so a tied matchup honestly
   * awards 0 points to every picker rather than crediting an arbitrary side. */
  winningFranchiseId: number | null;
}

/**
 * Per-entrant point total for ONE week: 1 point per pick that targets a FINAL matchup AND named
 * its actual winner. A pick for a not-yet-final matchup scores 0, not "pending" — honest, no
 * partial credit mid-week (this is the pick'em-scoring instance of the same "never render/
 * aggregate a sentinel" rule the third-party-data-honesty skill applies to raw ESPN fields).
 * Every entrant who made at least one pick appears in the output, even at 0 — callers decide
 * whether to hide/show a zero. Pure.
 */
export function computeWeeklyPoints(picks: PickemPickInput[], results: PickemMatchupResult[]): Map<string, number> {
  const resultByMatchup = new Map(results.map((r) => [r.matchupId, r]));
  const points = new Map<string, number>();
  for (const pick of picks) {
    if (!points.has(pick.entrantId)) points.set(pick.entrantId, 0);
    const result = resultByMatchup.get(pick.matchupId);
    if (!result || !result.isFinal || result.winningFranchiseId === null) continue;
    if (result.winningFranchiseId === pick.pickedFranchiseId) {
      points.set(pick.entrantId, points.get(pick.entrantId)! + 1);
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Season leaderboard — total points, weeks won, ties share rank
// ---------------------------------------------------------------------------

export interface WeeklyPointsRow {
  entrantId: string;
  week: number;
  points: number;
}

export interface SeasonLeaderboardRow {
  entrantId: string;
  totalPoints: number;
  /** Count of weeks where this entrant's points equalled that week's MAX points among every
   * entrant who made at least one pick that week — co-champions (a tied top score) each get full
   * credit, same "ties share" philosophy as `rank` below, rather than an arbitrary sole winner.
   * Callers must supply one WeeklyPointsRow per (entrant, week) that entrant actually picked in
   * (0 points included) — omitting a real participant from a week they played would let a lower
   * true-max incorrectly "win" that week. */
  weeksWon: number;
  /** Standard competition ranking (1, 2, 2, 4, ...) by totalPoints desc — same algorithm as
   * src/engines/records.ts's topRecords. */
  rank: number;
}

/**
 * Season-long leaderboard from every week's per-entrant points. `weeksWon` and `rank` both use
 * "ties share" semantics (brief: "Ties share rank") rather than an arbitrary sole winner — this is
 * a private single-league site among ~12 managers where a tie is a real, expected outcome, not a
 * data-quality problem to break arbitrarily. Pure.
 */
export function computeSeasonLeaderboard(weeklyPoints: WeeklyPointsRow[]): SeasonLeaderboardRow[] {
  const totalByEntrant = new Map<string, number>();
  const weeksWonByEntrant = new Map<string, number>();
  const byWeek = new Map<number, WeeklyPointsRow[]>();

  for (const row of weeklyPoints) {
    totalByEntrant.set(row.entrantId, (totalByEntrant.get(row.entrantId) ?? 0) + row.points);
    if (!weeksWonByEntrant.has(row.entrantId)) weeksWonByEntrant.set(row.entrantId, 0);
    const list = byWeek.get(row.week);
    if (list) list.push(row);
    else byWeek.set(row.week, [row]);
  }

  for (const rows of byWeek.values()) {
    const maxPoints = Math.max(...rows.map((r) => r.points));
    for (const r of rows) {
      if (r.points === maxPoints) weeksWonByEntrant.set(r.entrantId, weeksWonByEntrant.get(r.entrantId)! + 1);
    }
  }

  // Secondary sort by entrantId keeps output order deterministic within a tie — Map iteration
  // order is insertion order in practice, but never something to depend on for a stable result.
  const sorted = [...totalByEntrant.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const out: SeasonLeaderboardRow[] = [];
  let rank = 0;
  let lastTotal: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const [entrantId, totalPoints] = sorted[i]!;
    if (lastTotal === null || totalPoints !== lastTotal) {
      rank = i + 1;
      lastTotal = totalPoints;
    }
    out.push({ entrantId, totalPoints, weeksWon: weeksWonByEntrant.get(entrantId) ?? 0, rank });
  }
  return out;
}
