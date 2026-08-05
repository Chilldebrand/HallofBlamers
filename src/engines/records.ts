/**
 * Top-10 record book entries per record key. Pure per AGENTS.md: no DB, no
 * IO — the orchestrator extracts these typed candidate rows from team_week
 * + matchup + season-rollup (+ belt/streak, both replay() outputs) data.
 */

export type RecordWeekType = "regular" | "playoff" | "consolation" | "championship";

export interface RecordCandidate {
  franchiseId: number;
  season: number;
  week: number | null;
  value: number;
  weekType: RecordWeekType | null;
  detail?: Record<string, unknown> | null;
}

export interface RecordEntry extends RecordCandidate {
  rank: number;
}

/**
 * Sorts best-to-worst by `direction` ("desc" = higher value wins rank 1,
 * "asc" = lower value wins rank 1), assigns standard competition ranking
 * (ties share the better rank: 1, 2, 2, 4, ...), then caps the RESULT to
 * `limit` ROWS (not distinct ranks) — per the brief's "cap list at 10 rows
 * per key after tie-handling", a tie that straddles the 10th row is not
 * specially preserved intact; only as many of its rows as fit make the cut.
 */
export function topRecords(candidates: RecordCandidate[], direction: "asc" | "desc", limit = 10): RecordEntry[] {
  const sorted = [...candidates].sort((a, b) => (direction === "desc" ? b.value - a.value : a.value - b.value));

  const ranked: RecordEntry[] = [];
  let rank = 0;
  let lastValue: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (lastValue === null || c.value !== lastValue) {
      rank = i + 1;
      lastValue = c.value;
    }
    ranked.push({ ...c, rank });
  }

  return ranked.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Full record-book assembly
// ---------------------------------------------------------------------------

export interface RecordsTeamWeekInput {
  franchiseId: number;
  season: number;
  week: number;
  /** The COARSE regular/playoff split (never 'consolation' in real data) — drives eligibility. */
  weekType: RecordWeekType;
  /**
   * The refined bracket classification (e.g. 'consolation' for a real `LOSERS_CONSOLATION_LADDER`
   * game that's still coarsely 'playoff') — stored on the resulting record entry for an honest UI
   * caption, but NEVER used to decide eligibility. Falls back to `weekType` when omitted.
   * Deliberately two different fields: excluding a genuinely-consolation game from the record book
   * entirely would have dropped the league's actual highest-ever score (187.7, scored in exactly
   * such a game) — approved as coarse-eligible, refined-labeled.
   */
  displayWeekType?: RecordWeekType;
  score: number;
  result: "W" | "L" | "T" | null;
  /** Signed, own score minus opponent score — null on a bye. */
  margin: number | null;
  benchPointsLeft: number | null;
  opponentFranchiseId: number | null;
  /** Precomputed by the caller: is this team-week part of THE championship-deciding matchup? */
  isChampionshipGame: boolean;
}

export interface RecordsSeasonStatInput {
  franchiseId: number;
  season: number;
  pointsFor: number;
  pointsAgainst: number;
  wins: number;
  losses: number;
  ties: number;
  /**
   * Precomputed by the caller (`seasons.status === 'complete'`, or "every matchup final" as a
   * fallback signal). SEASON-scope keys (highest/lowest_season_total, best/worst_season_record,
   * most_season_points_against) only ever draw from a season where this is true — a partial
   * season's running total must never rank next to a full season's, high OR low. Games-played
   * alone (wins+losses+ties>0) is NOT a safe proxy for this: an in-progress season keeps
   * accumulating wins/losses well before it's complete.
   */
  seasonComplete: boolean;
}

export interface RecordsBeltReignInput {
  franchiseId: number;
  startSeason: number;
  startWeek: number;
  weeksHeld: number;
}

export interface RecordsStreakSpanInput {
  count: number;
  startSeason: number;
  startWeek: number;
  endSeason: number;
  endWeek: number;
}

export interface RecordsStreakInput {
  franchiseId: number;
  longestWinStreak: RecordsStreakSpanInput | null;
  longestLossStreak: RecordsStreakSpanInput | null;
}

export interface RecordsInput {
  teamWeeks: RecordsTeamWeekInput[];
  seasonStats: RecordsSeasonStatInput[];
  beltReigns: RecordsBeltReignInput[];
  streaks: RecordsStreakInput[];
}

export const RECORD_KEYS = [
  "highest_week_score",
  "lowest_week_score",
  "largest_blowout",
  "closest_game",
  "most_points_in_loss",
  "fewest_points_in_win",
  "highest_season_total",
  "lowest_season_total",
  "best_season_record",
  "worst_season_record",
  "longest_win_streak",
  "longest_loss_streak",
  "most_season_points_against",
  "highest_bench_points_left",
  "longest_belt_reign",
  "highest_championship_score",
  // Task 17 — "Beatdown of the Week": the top-10 all-time largest LOSING margins, attributed to
  // the LOSER. Distinct from `largest_blowout` (winner-attributed, same underlying games) — both
  // keys coexist on purpose, one for the shame side, one for the glory side of the same blowout.
  "worst_beatdown",
] as const;

export type RecordKey = (typeof RECORD_KEYS)[number];

/** "regular+playoff unless noted" — consolation-bracket weeks are dropped from every team-week-sourced key. */
function isNonConsolation(tw: RecordsTeamWeekInput): boolean {
  return tw.weekType !== "consolation";
}

export function buildRecordEntries(input: RecordsInput): Record<RecordKey, RecordEntry[]> {
  const eligibleWeeks = input.teamWeeks.filter(isNonConsolation);
  // A DECIDED team-week only — excludes a bye (result null, no opponent) AND, critically, an
  // unplayed/future week (score-so-far of 0, result null) from ever being crowned a "lowest week
  // ever": an "upcoming" season's placeholder rows must never fabricate a record.
  const playedWeeks = eligibleWeeks.filter((tw) => tw.result !== null);
  const wins = eligibleWeeks.filter((tw) => tw.result === "W" && tw.margin !== null);
  const losses = eligibleWeeks.filter((tw) => tw.result === "L" && tw.margin !== null);
  // SEASON-scope keys only ever draw from a COMPLETE season (see `seasonComplete`'s docstring) —
  // NOT merely "has played >=1 game": an in-progress season keeps accumulating a running total
  // that must never rank next to a full season's, in either direction.
  const completeSeasons = input.seasonStats.filter((s) => s.seasonComplete);

  const highest_week_score = topRecords(
    playedWeeks.map((tw) => weekCandidate(tw, tw.score)),
    "desc",
  );
  const lowest_week_score = topRecords(
    playedWeeks.map((tw) => weekCandidate(tw, tw.score)),
    "asc",
  );

  const largest_blowout = topRecords(
    wins.map((tw) => weekCandidate(tw, tw.margin!, { opponentFranchiseId: tw.opponentFranchiseId })),
    "desc",
  );
  const closest_game = topRecords(
    wins.map((tw) => weekCandidate(tw, tw.margin!, { opponentFranchiseId: tw.opponentFranchiseId })),
    "asc",
  );

  const most_points_in_loss = topRecords(
    losses.map((tw) => weekCandidate(tw, tw.score)),
    "desc",
  );
  const fewest_points_in_win = topRecords(
    wins.map((tw) => weekCandidate(tw, tw.score)),
    "asc",
  );

  // Task 17 — "worst_beatdown": ranked by MARGIN ascending (a loss's margin is always negative,
  // so the most-negative value is the worst beatdown, rank 1) — same `losses` list
  // `most_points_in_loss` already uses (same coarse eligibility, same DECIDED-loss gate), just a
  // different value/direction. `detail` carries the WINNER's identity + both raw scores (brief:
  // "detail_json carries winner + scores") — the winner's score is derivable from this team-week's
  // own `score - margin` (margin = ownScore - opponentScore, so opponentScore = ownScore - margin)
  // without needing a new input field.
  const worst_beatdown = topRecords(
    losses.map((tw) =>
      weekCandidate(tw, tw.margin!, {
        winnerFranchiseId: tw.opponentFranchiseId,
        winnerScore: tw.score - tw.margin!,
        loserScore: tw.score,
      }),
    ),
    "asc",
  );

  const highest_season_total = topRecords(
    completeSeasons.map((s) => seasonCandidate(s.franchiseId, s.season, s.pointsFor)),
    "desc",
  );
  const lowest_season_total = topRecords(
    completeSeasons.map((s) => seasonCandidate(s.franchiseId, s.season, s.pointsFor)),
    "asc",
  );

  // Defensive divide-by-zero guard, kept separate from `seasonComplete`: a genuinely complete
  // real season always has wins+losses+ties>0, but `seasonComplete` alone (season-status/
  // matchup-finality) says nothing about THIS row's game count — without this, a 0-0-0
  // team_seasons row belonging to a season judged "complete" would compute 0/0 = NaN.
  const winPctCandidates = completeSeasons
    .filter((s) => s.wins + s.losses + s.ties > 0)
    .map((s) => seasonCandidate(s.franchiseId, s.season, (s.wins + 0.5 * s.ties) / (s.wins + s.losses + s.ties)));
  const best_season_record = topRecords(winPctCandidates, "desc");
  const worst_season_record = topRecords(winPctCandidates, "asc");

  const most_season_points_against = topRecords(
    completeSeasons.map((s) => seasonCandidate(s.franchiseId, s.season, s.pointsAgainst)),
    "desc",
  );

  const highest_bench_points_left = topRecords(
    eligibleWeeks.filter((tw) => tw.benchPointsLeft !== null).map((tw) => weekCandidate(tw, tw.benchPointsLeft!)),
    "desc",
  );

  const longest_win_streak = topRecords(
    input.streaks.filter((s) => s.longestWinStreak !== null).map((s) => streakCandidate(s.franchiseId, s.longestWinStreak!)),
    "desc",
  );
  const longest_loss_streak = topRecords(
    input.streaks.filter((s) => s.longestLossStreak !== null).map((s) => streakCandidate(s.franchiseId, s.longestLossStreak!)),
    "desc",
  );

  const longest_belt_reign = topRecords(
    input.beltReigns.map((r) => seasonCandidate(r.franchiseId, r.startSeason, r.weeksHeld, r.startWeek)),
    "desc",
  );

  const highest_championship_score = topRecords(
    input.teamWeeks.filter((tw) => tw.isChampionshipGame).map((tw) => weekCandidate(tw, tw.score)),
    "desc",
  );

  return {
    highest_week_score,
    lowest_week_score,
    largest_blowout,
    closest_game,
    most_points_in_loss,
    fewest_points_in_win,
    highest_season_total,
    lowest_season_total,
    best_season_record,
    worst_season_record,
    longest_win_streak,
    longest_loss_streak,
    most_season_points_against,
    highest_bench_points_left,
    longest_belt_reign,
    highest_championship_score,
    worst_beatdown,
  };
}

function weekCandidate(tw: RecordsTeamWeekInput, value: number, detail?: Record<string, unknown>): RecordCandidate {
  return {
    franchiseId: tw.franchiseId,
    season: tw.season,
    week: tw.week,
    value,
    weekType: tw.displayWeekType ?? tw.weekType,
    detail: detail ?? null,
  };
}

function seasonCandidate(franchiseId: number, season: number, value: number, week: number | null = null): RecordCandidate {
  return { franchiseId, season, week, value, weekType: null };
}

function streakCandidate(franchiseId: number, span: RecordsStreakSpanInput): RecordCandidate {
  return {
    franchiseId,
    season: span.endSeason,
    week: span.endWeek,
    value: span.count,
    weekType: null,
    detail: { startSeason: span.startSeason, startWeek: span.startWeek, endSeason: span.endSeason, endWeek: span.endWeek },
  };
}

// ---------------------------------------------------------------------------
// Task 17 — "Beatdown of the Week" weekly award derivation.
//
// Distinct from `worst_beatdown` above: that key ranks the top-10 worst losing margins ALL TIME
// (a `record_entries` concern). This derives, for EVERY (season, week), which franchise(s) WON
// the weekly award that week — used by stage 4 to count `season_stats.beatdowns` /
// `career_stats.beatdowns`, and by stage 5's `beatdown_of_week` context rule to decide per-week
// eligibility. A single shared derivation (not reimplemented independently in build.ts and
// context.ts) so the two consumers can never drift out of sync on tie-handling.
// ---------------------------------------------------------------------------

export interface BeatdownTeamWeekInput {
  franchiseId: number;
  season: number;
  week: number;
  result: "W" | "L" | "T" | null;
  /** Signed, own score minus opponent score — a loss's margin is always negative. */
  margin: number | null;
}

export interface BeatdownAward {
  franchiseId: number;
  season: number;
  week: number;
  /** Negative — the losing margin. */
  margin: number;
}

/**
 * "Beatdown of the Week": among a week's COMPLETED head-to-head matchups (`result != null`), the
 * losing franchise with the largest losing margin (most negative). Regular season AND playoff/
 * consolation weeks are ALL eligible (a playoff beatdown is still a beatdown) — deliberately no
 * weekType filter of any kind, coarse or refined, per the brief's explicit ruling. Bye/unplayed
 * (`result === null`) and tied (`result === 'T'`) team-weeks are never eligible — a tie is never a
 * beatdown. A week with no completed losses at all (e.g. no games played, or every decided game
 * was a tie) gets no award — never fabricated. Ties WITHIN a week (rare — two franchises losing by
 * the exact same margin) award ALL tied losers, sorted by franchiseId for a deterministic output
 * order. Pure — unit-tested directly.
 */
export function computeWeeklyBeatdowns(teamWeeks: BeatdownTeamWeekInput[]): BeatdownAward[] {
  const losses = teamWeeks.filter((tw) => tw.result === "L" && tw.margin !== null);

  const byWeek = new Map<string, BeatdownTeamWeekInput[]>();
  for (const tw of losses) {
    const key = `${tw.season}:${tw.week}`;
    const list = byWeek.get(key) ?? [];
    list.push(tw);
    byWeek.set(key, list);
  }

  const out: BeatdownAward[] = [];
  for (const list of byWeek.values()) {
    const worstMargin = Math.min(...list.map((tw) => tw.margin!));
    const winners = list.filter((tw) => tw.margin === worstMargin);
    for (const w of winners) out.push({ franchiseId: w.franchiseId, season: w.season, week: w.week, margin: w.margin! });
  }

  // Deterministic overall order (season, week, franchiseId) — not load-bearing for callers, which
  // key by franchiseId:season:week regardless, but keeps this function's own output stable.
  out.sort((a, b) => a.season - b.season || a.week - b.week || a.franchiseId - b.franchiseId);
  return out;
}
