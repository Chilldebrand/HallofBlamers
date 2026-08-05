/**
 * Historical context engine — stat-build stage 5. PURE per AGENTS.md: no DB, no IO, no imports
 * from `src/server/`. Interprets already-prepared, precomputed facts about every COMPLETED
 * team-week and matchup (rank lookups, streak/elo trajectories, h2h/belt chronology) into short,
 * broadcast-tight "why this matters" notes — `evaluateContextRules(inputs) -> notes[]`.
 *
 * Determinism: this function does no I/O, reads no clock, and every internal Map/grouping is
 * re-sorted into an explicit, fully-specified order before being returned — same inputs always
 * produce byte-identical output (see the final sort in `evaluateContextRules`).
 *
 * Multi-note subjects (a single team_week or matchup) are CAPPED at the top 3 notes by salience
 * (ties broken by the scope tiebreak below, then rule id) — the rest are dropped, per the brief.
 *
 * Scope tiebreak (brief): league > season > franchise, applied only when salience ties.
 *
 * CHRONOLOGY AUDIT (fix round 1, C1's "apply the same reasoning elsewhere" ask): `record_broken`'s
 * "previously X, {year}" is the ONLY rendered text that makes a "this happened chronologically
 * before" claim — audited every other rule's text for the same class of bug:
 *   - `franchise_best_since` ("since {year}"), `elo_landmark` ("new... peak"/"reaches #1"),
 *     `career_milestone` (cumulative win count), and `h2h_milestone` (lead/drought) are ALL
 *     already computed via a strictly-forward chronological scan/incremental state machine —
 *     structurally incapable of citing a later event as if it were earlier.
 *   - `streak_context` ("franchise record is N") and `belt_stakes` ("N shy of the league
 *     record") compare against a FINAL/full-history summary value (the franchise's all-time-best
 *     streak; the league's all-time-best consecutive-defenses count) rather than an incremental
 *     one — but neither claims temporal precedence the way "previously X" does; both read as "as
 *     measured against today's understanding," the same framing `all_time_score_rank`'s
 *     "Nth-highest ever" uses without controversy. Left unchanged.
 */
import { computeWeeklyBeatdowns, type BeatdownTeamWeekInput, type RecordKey } from "./records";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ContextSubjectType = "team_week" | "matchup";

export interface ContextNote {
  subjectType: ContextSubjectType;
  season: number;
  week: number;
  franchiseId: number | null;
  matchupId: number | null;
  ruleId: string;
  salience: number;
  renderedText: string;
  facts: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Salience — brief gives one value per named category; belt_stakes has no
// explicit entry (see the RULING comment above BELT_DEFENSE/BELT_TRANSFER).
// ---------------------------------------------------------------------------

const SALIENCE = {
  RECORD_BROKEN: 100,
  ALL_TIME_TOP3: 90,
  ALL_TIME_TOP10: 70,
  SEASON_BEST: 60,
  FRANCHISE_TOP5: 55,
  H2H_MILESTONE: 50,
  STREAK: 45,
  ELO_LANDMARK: 45,
  CAREER_MILESTONE: 40,
  /**
   * RULING: the brief's salience table lists 9 named categories for 11 rules and never names
   * `belt_stakes` explicitly. Chosen deliberately from the EXISTING vocabulary rather than
   * inventing an unexplained new number: a defense note's "N shy of the record" framing is
   * structurally identical to `streak_context`'s "franchise record is N" framing, so it reuses
   * STREAK's 45. A transfer (the belt changing hands) is a rarer, bigger single event — reuses
   * SEASON_BEST's 60 rather than colliding with H2H_MILESTONE's 50 or ALL_TIME_TOP10's 70.
   */
  BELT_DEFENSE: 45,
  BELT_TRANSFER: 60,
  /** Task 17 brief: explicit salience 45 for `beatdown_of_week`. */
  BEATDOWN_OF_WEEK: 45,
} as const;

type Scope = "league" | "season" | "franchise";
const SCOPE_RANK: Record<Scope, number> = { league: 0, season: 1, franchise: 2 };

// ---------------------------------------------------------------------------
// Inputs — all plain data, precomputed by stage 5 (src/server/stats/build.ts).
// ---------------------------------------------------------------------------

export type ContextWeekType = "regular" | "playoff" | "consolation" | "championship";

export interface ContextTeamWeekInput {
  franchiseId: number;
  season: number;
  week: number;
  /** Null on a bye — never happens for a DECIDED team-week, but kept nullable for honesty. */
  matchupId: number | null;
  score: number;
  result: "W" | "L" | "T";
  /**
   * COARSE week type (`team_week.week_type`) — never literally 'consolation' in real data (see
   * Task 8's record-book precedent). Used to gate `season_score_rank`/`franchise_best_since`
   * eligibility the same way the record book gates `highest_week_score` etc: coarse-eligible,
   * refined-labeled — consistent with the brief's instruction to match the record book's coarse
   * split for rule 1 (`all_time_score_rank` itself sources straight from `record_entries`, which
   * already encodes this same coarse eligibility, so this field isn't needed for rule 1 itself).
   */
  weekType: ContextWeekType;
  /**
   * REFINED week type (`playoff_tier`-based, via `classifyMatchupWeekType`) — used ONLY to
   * exclude genuine consolation-bracket games from streak/elo/h2h/career framing, mirroring
   * `replay()`'s own exclusion (`weekType !== "consolation"` there uses this refined value).
   */
  refinedWeekType: ContextWeekType;
  /** Active streak AS OF this team-week (after this game), from replay()'s streakHistory. Null
   * only if this team-week was excluded from streak tracking (a genuine consolation game). */
  streakAsOf: { type: "W" | "L" | null; count: number } | null;
  /** This franchise's own career-long longest streak of each type (final replay() summary). */
  franchiseLongestWinStreak: number | null;
  franchiseLongestLossStreak: number | null;
  /** elo_history.elo_post for this franchise/week (always present for a decided, non-bye game). */
  eloPost: number | null;
  /** Whether this team-week's SEASON is genuinely complete as of this build (same signal
   * build.ts's `computeSeasonCompleteBySeason` already derives for the record book). */
  seasonComplete: boolean;
  /** Signed, own score minus opponent score — null on a bye. Task 17: `beatdown_of_week` needs
   * this to find each week's worst loss via `computeWeeklyBeatdowns` (shared with stage 4). */
  margin: number | null;
}

export interface ContextRecordEntryInput {
  recordKey: RecordKey;
  rank: number;
  franchiseId: number;
  season: number;
  /** Null for season-scope keys (highest_season_total, etc.) — never attributable to a single
   * team-week/matchup, so `record_broken` skips those; rules 1/4/9 don't read week-null keys. */
  week: number | null;
  value: number;
}

export interface ContextH2HMatchupInput {
  matchupId: number;
  season: number;
  week: number;
  /** REFINED week type — a genuine consolation game is excluded, matching h2h.ts's own filter. */
  weekType: ContextWeekType;
  homeFranchiseId: number;
  awayFranchiseId: number;
  winner: "home" | "away" | "tie";
}

export interface ContextBeltMatchInput {
  matchupId: number;
  season: number;
  week: number;
  holderFranchiseId: number;
  challengerFranchiseId: number;
  result: "defense" | "transfer";
}

export interface ContextBeltReignInput {
  reignNo: number;
  franchiseId: number;
  startSeason: number;
  startWeek: number;
  /** FINAL defenses count for this reign (a still-current reign's running total as of the build). */
  defenses: number;
}

export interface ContextEngineInputs {
  /** Every COMPLETED (decided) team-week across all seasons/weeks, any order — sorted internally. */
  teamWeeks: ContextTeamWeekInput[];
  /** The full record_entries table (all keys, all ranks) — rules 1/4/8/9 all read this one list. */
  recordEntries: ContextRecordEntryInput[];
  /** Every completed, non-bye matchup, any order — sorted internally per pair. */
  h2hMatchups: ContextH2HMatchupInput[];
  /** Every belt_matches row, any order — sorted internally. */
  beltMatches: ContextBeltMatchInput[];
  beltReigns: ContextBeltReignInput[];
  franchiseNames: Record<number, string>;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** 1st, 2nd, 3rd, 4th, 11th, 21st, ... */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const SMALL_NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** Spells out 0-9 (matching the brief's own "three shy of the league record" example), digits beyond. */
function spellSmall(n: number): string {
  return n >= 0 && n < SMALL_NUMBER_WORDS.length ? SMALL_NUMBER_WORDS[n]! : String(n);
}

function franchiseName(names: Record<number, string>, franchiseId: number): string {
  return names[franchiseId] ?? "—";
}

/**
 * English possessive of a name: a bare apostrophe when the name already ends in "s"
 * ("Pat's Moms All-Stars'"), else the usual "'s" ("Bijan Mustard's"). Used by every template
 * that renders a possessive — a single shared helper so this rule is applied consistently
 * everywhere, not per-callsite (Task 14 fix: the deferred "All-Stars's" possessive nit).
 */
export function possessive(name: string): string {
  // Case-insensitive on purpose — an all-caps franchise name ending in "S" should still take the
  // bare apostrophe, not "'s"; real league names are unlikely to be all-caps, but nothing about
  // "ends in s" should depend on letter casing.
  return name.toLowerCase().endsWith("s") ? `${name}'` : `${name}'s`;
}

export const RECORD_LABELS: Record<RecordKey, string> = {
  highest_week_score: "highest score in a week",
  lowest_week_score: "lowest score in a week",
  largest_blowout: "largest blowout",
  closest_game: "closest game",
  most_points_in_loss: "most points in a loss",
  fewest_points_in_win: "fewest points in a win",
  highest_bench_points_left: "most points left on the bench",
  highest_season_total: "highest season point total",
  lowest_season_total: "lowest season point total",
  best_season_record: "best season record",
  worst_season_record: "worst season record",
  most_season_points_against: "most points against in a season",
  longest_win_streak: "longest win streak",
  longest_loss_streak: "longest losing streak",
  longest_belt_reign: "longest belt reign",
  highest_championship_score: "highest score in a championship game",
  worst_beatdown: "worst beatdown",
};

const PERCENT_KEYS = new Set<RecordKey>(["best_season_record", "worst_season_record"]);
const INTEGER_KEYS = new Set<RecordKey>(["longest_win_streak", "longest_loss_streak", "longest_belt_reign"]);

function formatRecordValue(key: RecordKey, value: number): string {
  if (PERCENT_KEYS.has(key)) return `${(value * 100).toFixed(1)}%`;
  if (INTEGER_KEYS.has(key)) return `${Math.round(value)}`;
  return value.toFixed(1);
}

function teamWeekKey(franchiseId: number, season: number, week: number): string {
  return `${franchiseId}:${season}:${week}`;
}

interface Candidate {
  subjectType: ContextSubjectType;
  season: number;
  week: number;
  franchiseId: number | null;
  matchupId: number | null;
  ruleId: string;
  salience: number;
  scope: Scope;
  renderedText: string;
  facts: Record<string, unknown> | null;
  /** Stable insertion order — used only as the final tiebreak so equal-everything candidates
   * (should not occur, but guarantees a strict total order regardless) sort deterministically. */
  seq: number;
}

// ---------------------------------------------------------------------------
// Rule 1 + 4 + 8 + 9 — all sourced from record_entries
// ---------------------------------------------------------------------------

function tierSalience(rank: number): number {
  return rank <= 3 ? SALIENCE.ALL_TIME_TOP3 : SALIENCE.ALL_TIME_TOP10;
}

function evalRecordSourcedRules(
  recordEntries: ContextRecordEntryInput[],
  teamWeekByKey: Map<string, ContextTeamWeekInput>,
  out: Candidate[],
  seq: () => number,
): void {
  const byKey = new Map<RecordKey, ContextRecordEntryInput[]>();
  for (const e of recordEntries) {
    const list = byKey.get(e.recordKey) ?? [];
    list.push(e);
    byKey.set(e.recordKey, list);
  }

  // --- rule 1: all_time_score_rank ---
  for (const e of byKey.get("highest_week_score") ?? []) {
    if (e.rank > 10 || e.week === null) continue;
    const tw = teamWeekByKey.get(teamWeekKey(e.franchiseId, e.season, e.week));
    const text = e.rank === 1 ? "Highest score in league history" : `${ordinal(e.rank)}-highest score in league history`;
    out.push({
      subjectType: "team_week",
      season: e.season,
      week: e.week,
      franchiseId: e.franchiseId,
      matchupId: tw?.matchupId ?? null,
      ruleId: "all_time_score_rank",
      salience: tierSalience(e.rank),
      scope: "league",
      renderedText: text,
      facts: { direction: "high", rank: e.rank, value: e.value },
      seq: seq(),
    });
  }
  for (const e of byKey.get("lowest_week_score") ?? []) {
    if (e.rank > 10 || e.week === null) continue;
    const tw = teamWeekByKey.get(teamWeekKey(e.franchiseId, e.season, e.week));
    const text = e.rank === 1 ? "Lowest score ever" : `${ordinal(e.rank)}-lowest score ever`;
    out.push({
      subjectType: "team_week",
      season: e.season,
      week: e.week,
      franchiseId: e.franchiseId,
      matchupId: tw?.matchupId ?? null,
      ruleId: "all_time_score_rank",
      salience: tierSalience(e.rank),
      scope: "league",
      renderedText: text,
      facts: { direction: "low", rank: e.rank, value: e.value },
      seq: seq(),
    });
  }

  // --- rule 4: margin_rank (rank form only — see the brief's explicit "keep simple" permission;
  // no since-form fallback for a non-top-10 blowout/closest-game) ---
  for (const e of byKey.get("largest_blowout") ?? []) {
    if (e.rank > 10 || e.week === null) continue;
    const tw = teamWeekByKey.get(teamWeekKey(e.franchiseId, e.season, e.week));
    if (!tw?.matchupId) continue; // can't attach a matchup-scoped note without a matchup id
    const text = e.rank === 1 ? "Largest blowout in league history" : `${ordinal(e.rank)}-largest blowout ever`;
    out.push({
      subjectType: "matchup",
      season: e.season,
      week: e.week,
      franchiseId: null,
      matchupId: tw.matchupId,
      ruleId: "margin_rank",
      salience: tierSalience(e.rank),
      scope: "league",
      renderedText: text,
      facts: { kind: "blowout", rank: e.rank, value: e.value },
      seq: seq(),
    });
  }
  for (const e of byKey.get("closest_game") ?? []) {
    if (e.rank > 10 || e.week === null) continue;
    const tw = teamWeekByKey.get(teamWeekKey(e.franchiseId, e.season, e.week));
    if (!tw?.matchupId) continue;
    const text = e.rank === 1 ? "Closest game in league history" : `${ordinal(e.rank)}-closest game ever`;
    out.push({
      subjectType: "matchup",
      season: e.season,
      week: e.week,
      franchiseId: null,
      matchupId: tw.matchupId,
      ruleId: "margin_rank",
      salience: tierSalience(e.rank),
      scope: "league",
      renderedText: text,
      facts: { kind: "closest", rank: e.rank, value: e.value },
      seq: seq(),
    });
  }

  // --- rule 9: futility_valor (top-5 only) ---
  for (const e of byKey.get("most_points_in_loss") ?? []) {
    if (e.rank > 5 || e.week === null) continue;
    const tw = teamWeekByKey.get(teamWeekKey(e.franchiseId, e.season, e.week));
    const text = e.rank === 1 ? "Most points ever scored in a loss" : `${ordinal(e.rank)}-most points ever scored in a loss`;
    out.push({
      subjectType: "team_week",
      season: e.season,
      week: e.week,
      franchiseId: e.franchiseId,
      matchupId: tw?.matchupId ?? null,
      ruleId: "futility_valor",
      salience: tierSalience(e.rank),
      scope: "league",
      renderedText: text,
      facts: { kind: "most_in_loss", rank: e.rank, value: e.value },
      seq: seq(),
    });
  }
  for (const e of byKey.get("fewest_points_in_win") ?? []) {
    if (e.rank > 5 || e.week === null) continue;
    const tw = teamWeekByKey.get(teamWeekKey(e.franchiseId, e.season, e.week));
    const text = e.rank === 1 ? "Fewest points ever in a win" : `${ordinal(e.rank)}-fewest points ever in a win`;
    out.push({
      subjectType: "team_week",
      season: e.season,
      week: e.week,
      franchiseId: e.franchiseId,
      matchupId: tw?.matchupId ?? null,
      ruleId: "futility_valor",
      salience: tierSalience(e.rank),
      scope: "league",
      renderedText: text,
      facts: { kind: "fewest_in_win", rank: e.rank, value: e.value },
      seq: seq(),
    });
  }

  // --- rule 8: record_broken — see `findRecordComparisons` (shared with emit-events.ts, Task 25)
  // for the chronology-safe "what record did this break" derivation itself; this loop only turns
  // its output into rendered notes.
  for (const { recordKey: key, entry: e, comparisonEntry } of findRecordComparisons(recordEntries)) {
    const tw = teamWeekByKey.get(teamWeekKey(e.franchiseId, e.season, e.week));
    const label = RECORD_LABELS[key];
    let text: string;
    if (!comparisonEntry) {
      text = `Sets the league record for ${label} (${formatRecordValue(key, e.value)})`;
    } else if (e.value === comparisonEntry.value) {
      text = `Ties the league record for ${label} (${formatRecordValue(key, e.value)}, also ${comparisonEntry.season})`;
    } else {
      text = `Breaks the league record for ${label} (previously ${formatRecordValue(key, comparisonEntry.value)}, ${comparisonEntry.season})`;
    }
    out.push({
      subjectType: "team_week",
      season: e.season,
      week: e.week,
      franchiseId: e.franchiseId,
      matchupId: tw?.matchupId ?? null,
      ruleId: "record_broken",
      salience: SALIENCE.RECORD_BROKEN,
      scope: "league",
      renderedText: text,
      facts: { recordKey: key, value: e.value, previousValue: comparisonEntry?.value ?? null },
      seq: seq(),
    });
  }
}

// ---------------------------------------------------------------------------
// Shared with src/server/sync/emit-events.ts (Task 25): the chronology-safe "what record did
// this rank-1 result break" derivation, factored out of rule 8 above so the context engine's
// notes and the live ticker's `RecordBroken` events can never disagree about which historical
// record a given result actually broke — one derivation, two consumers, same pattern as
// `computeWeeklyBeatdowns` (src/engines/records.ts) being shared by stage 4 and the
// `beatdown_of_week` rule below.
// ---------------------------------------------------------------------------

export interface RecordComparison {
  recordKey: RecordKey;
  /** The rank-1, week-attributable entry being evaluated. */
  entry: ContextRecordEntryInput & { week: number };
  /**
   * The best-ranked (lowest rank number) entry STRICTLY chronologically before `entry`'s own
   * (season, week), or null when `entry` is the earliest attributable entry for this record key
   * (i.e. it SET the record rather than breaking/tying an earlier one).
   */
  comparisonEntry: ContextRecordEntryInput | null;
}

/**
 * For every record_key, finds each rank-1, week-attributable entry and compares it against "the
 * standing record immediately before this one broke it": the BEST-RANKED (lowest rank number)
 * entry among those chronologically STRICTLY BEFORE the rank-1 entry's own (season, week) — NOT
 * simply "rank 2" (fix round 1, C1). The brief's own "compare vs rank-2" suggestion is unsound:
 * `record_entries` ranks by VALUE across all time, with no guarantee rank 2 (or any other non-1
 * rank) is chronologically earlier than rank 1 — confirmed on real data, where the 2019 187.7
 * game's rank-2 comparison entry was dated 2021 (LATER), rendering "previously 186.8, 2021" on a
 * 2019 game. Picking the best-ranked entry among only the chronologically-earlier ones is what
 * "previously X, {year}" actually means: the highest bar that stood at the time, not merely the
 * next-best value overall (which might not have existed yet, or might have been chronologically
 * superseded by something even better in between). A multi-way rank-1 tie collapses into this
 * naturally: the chronologically LATER of two same-value entries finds the earlier one (also rank
 * 1) as its best chronologically-earlier match -> "Ties" (correct); the chronologically EARLIER
 * one finds nothing before it (if it's truly first) -> "Sets" (also correct — it set the record;
 * the later entry merely tied it).
 */
export function findRecordComparisons(recordEntries: ContextRecordEntryInput[]): RecordComparison[] {
  const byKey = new Map<RecordKey, ContextRecordEntryInput[]>();
  for (const e of recordEntries) {
    const list = byKey.get(e.recordKey) ?? [];
    list.push(e);
    byKey.set(e.recordKey, list);
  }

  const out: RecordComparison[] = [];
  for (const [key, entries] of byKey) {
    const attributable = entries.filter((e): e is ContextRecordEntryInput & { week: number } => e.week !== null);
    const rank1 = attributable.filter((e) => e.rank === 1);

    for (const e of rank1) {
      let comparisonEntry: ContextRecordEntryInput | undefined;
      for (const other of attributable) {
        if (other === e) continue;
        const otherIsEarlier = other.season < e.season || (other.season === e.season && other.week < e.week);
        if (!otherIsEarlier) continue;
        if (!comparisonEntry || other.rank < comparisonEntry.rank) comparisonEntry = other;
      }
      out.push({ recordKey: key, entry: e, comparisonEntry: comparisonEntry ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule 2: season_score_rank — top 3 WITHIN a season, high direction only (the
// brief doesn't parenthetically extend this rule to a season-low variant the
// way rule 1 explicitly does for all-time, so only the high side is implemented).
// ---------------------------------------------------------------------------

function evalSeasonScoreRank(teamWeeks: ContextTeamWeekInput[], out: Candidate[], seq: () => number): void {
  const bySeason = new Map<number, ContextTeamWeekInput[]>();
  for (const tw of teamWeeks) {
    if (tw.weekType === "consolation") continue; // coarse eligibility, matches the record book
    const list = bySeason.get(tw.season) ?? [];
    list.push(tw);
    bySeason.set(tw.season, list);
  }

  for (const [season, rows] of bySeason) {
    const sorted = [...rows].sort((a, b) => b.score - a.score);
    const seasonComplete = sorted[0]?.seasonComplete ?? false;
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      const tw = sorted[i]!;
      const suffix = seasonComplete ? "" : " (so far)";
      const text = i === 0 ? `Highest score of the ${season} season${suffix}` : `${ordinal(i + 1)}-highest score of the ${season} season${suffix}`;
      out.push({
        subjectType: "team_week",
        season: tw.season,
        week: tw.week,
        franchiseId: tw.franchiseId,
        matchupId: tw.matchupId,
        ruleId: "season_score_rank",
        salience: SALIENCE.SEASON_BEST,
        scope: "season",
        renderedText: text,
        facts: { rank: i + 1, value: tw.score, seasonComplete },
        seq: seq(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 3: franchise_best_since — a franchise's best score at least since some
// earlier PAST week with score >= this one, gated to a >=2-season span (or,
// with no earlier peak at all, "ever" gated to >=2 seasons of prior history)
// so a same-year rebound or a rookie franchise's debut never fires.
// ---------------------------------------------------------------------------

function evalFranchiseBestSince(teamWeeks: ContextTeamWeekInput[], out: Candidate[], seq: () => number): void {
  const byFranchise = new Map<number, ContextTeamWeekInput[]>();
  for (const tw of teamWeeks) {
    if (tw.weekType === "consolation") continue;
    const list = byFranchise.get(tw.franchiseId) ?? [];
    list.push(tw);
    byFranchise.set(tw.franchiseId, list);
  }

  for (const rows of byFranchise.values()) {
    const sorted = [...rows].sort((a, b) => a.season - b.season || a.week - b.week);
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]!;
      let priorPeakSeason: number | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (sorted[j]!.score >= cur.score) {
          priorPeakSeason = sorted[j]!.season;
          break;
        }
      }

      let text: string | null = null;
      if (priorPeakSeason !== null) {
        if (cur.season - priorPeakSeason >= 2) text = `Their best week since ${priorPeakSeason}`;
      } else {
        const firstSeason = sorted[0]!.season;
        if (cur.season - firstSeason >= 2) text = "Their best week ever";
      }
      if (!text) continue;

      out.push({
        subjectType: "team_week",
        season: cur.season,
        week: cur.week,
        franchiseId: cur.franchiseId,
        matchupId: cur.matchupId,
        ruleId: "franchise_best_since",
        salience: SALIENCE.FRANCHISE_TOP5,
        scope: "franchise",
        renderedText: text,
        facts: { sinceSeason: priorPeakSeason },
        seq: seq(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 5: streak_context — active streak >= 4, compared to the franchise's
// own career-long record of that type.
// ---------------------------------------------------------------------------

function evalStreakContext(teamWeeks: ContextTeamWeekInput[], out: Candidate[], seq: () => number): void {
  for (const tw of teamWeeks) {
    const streak = tw.streakAsOf;
    if (!streak || streak.type === null || streak.count < 4) continue;

    const franchiseRecord = streak.type === "W" ? tw.franchiseLongestWinStreak : tw.franchiseLongestLossStreak;
    const label = streak.type === "W" ? "win streak" : "losing streak";
    let text: string;
    if (franchiseRecord === null) {
      text = `Extends the ${label} to ${streak.count}`;
    } else if (streak.count >= franchiseRecord) {
      text = `Extends the ${label} to ${streak.count} — ties the franchise record`;
    } else {
      text = `Extends the ${label} to ${streak.count} — franchise record is ${franchiseRecord}`;
    }

    out.push({
      subjectType: "team_week",
      season: tw.season,
      week: tw.week,
      franchiseId: tw.franchiseId,
      matchupId: tw.matchupId,
      ruleId: "streak_context",
      salience: SALIENCE.STREAK,
      scope: "franchise",
      renderedText: text,
      facts: { type: streak.type, count: streak.count, franchiseRecord },
      seq: seq(),
    });
  }
}

// ---------------------------------------------------------------------------
// Rule 10: elo_landmark — reaching #1 (first time in >=1 season) or a fresh
// franchise peak. Both computed via a single chronological pass, mirroring
// replay()'s own running-Elo-map pattern.
// ---------------------------------------------------------------------------

function evalEloLandmark(teamWeeks: ContextTeamWeekInput[], out: Candidate[], seq: () => number): void {
  const decided = teamWeeks.filter((tw) => tw.eloPost !== null);
  const byWeek = new Map<string, ContextTeamWeekInput[]>();
  for (const tw of decided) {
    const key = `${tw.season}:${tw.week}`;
    const list = byWeek.get(key) ?? [];
    list.push(tw);
    byWeek.set(key, list);
  }
  const weekKeys = [...byWeek.keys()].sort((a, b) => {
    const [as, aw] = a.split(":").map(Number) as [number, number];
    const [bs, bw] = b.split(":").map(Number) as [number, number];
    return as - bs || aw - bw;
  });

  const runningElo = new Map<number, number>();
  const runningPeak = new Map<number, number>();
  const lastNo1Season = new Map<number, number>();

  for (const wk of weekKeys) {
    const group = byWeek.get(wk)!;
    for (const tw of group) runningElo.set(tw.franchiseId, tw.eloPost!);

    let leagueMax = -Infinity;
    for (const v of runningElo.values()) if (v > leagueMax) leagueMax = v;

    for (const tw of group) {
      // --- new franchise peak ---
      const priorPeak = runningPeak.get(tw.franchiseId);
      if (priorPeak !== undefined && tw.eloPost! > priorPeak) {
        out.push({
          subjectType: "team_week",
          season: tw.season,
          week: tw.week,
          franchiseId: tw.franchiseId,
          matchupId: tw.matchupId,
          ruleId: "elo_landmark",
          salience: SALIENCE.ELO_LANDMARK,
          scope: "franchise",
          renderedText: `New franchise peak Elo (${Math.round(tw.eloPost!)})`,
          facts: { kind: "peak", elo: tw.eloPost },
          seq: seq(),
        });
      }
      if (priorPeak === undefined || tw.eloPost! > priorPeak) runningPeak.set(tw.franchiseId, tw.eloPost!);

      // --- reaches #1 ---
      if (tw.eloPost === leagueMax) {
        const last = lastNo1Season.get(tw.franchiseId);
        if (last === undefined || tw.season - last >= 1) {
          out.push({
            subjectType: "team_week",
            season: tw.season,
            week: tw.week,
            franchiseId: tw.franchiseId,
            matchupId: tw.matchupId,
            ruleId: "elo_landmark",
            salience: SALIENCE.ELO_LANDMARK,
            scope: "league",
            renderedText: `Reaches #1 in the league Elo rankings (${Math.round(tw.eloPost!)})`,
            facts: { kind: "no1", elo: tw.eloPost },
            seq: seq(),
          });
        }
        lastNo1Season.set(tw.franchiseId, tw.season);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 11: career_milestone — career win count crossing 25/50/75/100.
// Uses ALL weekTypes (unlike streak_context) — mirrors career_stats.wins'
// own semantics (copied verbatim from team_seasons, never gated by bracket).
//
// RULING (fix round 1, I3): attributed to the FRANCHISE ("{Name}'s 75th all-time win"), not
// "Manager's" — franchise is the atomic identity for all stats per AGENTS.md, and a real
// ownership change (a franchise surviving a manager swap) would make "Manager's" factually wrong
// for wins accumulated under a DIFFERENT manager than whoever's in charge now.
// ---------------------------------------------------------------------------

const CAREER_WIN_MILESTONES = new Set([25, 50, 75, 100]);

function evalCareerMilestone(teamWeeks: ContextTeamWeekInput[], names: Record<number, string>, out: Candidate[], seq: () => number): void {
  const byFranchise = new Map<number, ContextTeamWeekInput[]>();
  for (const tw of teamWeeks) {
    const list = byFranchise.get(tw.franchiseId) ?? [];
    list.push(tw);
    byFranchise.set(tw.franchiseId, list);
  }

  for (const rows of byFranchise.values()) {
    const sorted = [...rows].sort((a, b) => a.season - b.season || a.week - b.week);
    let wins = 0;
    for (const tw of sorted) {
      if (tw.result !== "W") continue;
      wins += 1;
      if (!CAREER_WIN_MILESTONES.has(wins)) continue;
      out.push({
        subjectType: "team_week",
        season: tw.season,
        week: tw.week,
        franchiseId: tw.franchiseId,
        matchupId: tw.matchupId,
        ruleId: "career_milestone",
        salience: SALIENCE.CAREER_MILESTONE,
        scope: "franchise",
        renderedText: `${possessive(franchiseName(names, tw.franchiseId))} ${ordinal(wins)} all-time win`,
        facts: { wins },
        seq: seq(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 6: h2h_milestone — series lead flip and drought broken (>=4 straight
// losses in the series). Chronological single pass per unordered franchise
// pair, mirroring h2h.ts's own exclusion of consolation-bracket games.
// ---------------------------------------------------------------------------

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function evalH2HMilestone(matchupsInput: ContextH2HMatchupInput[], names: Record<number, string>, out: Candidate[], seq: () => number): void {
  const eligible = matchupsInput.filter((m) => m.weekType !== "consolation");
  const sorted = [...eligible].sort((a, b) => a.season - b.season || a.week - b.week || a.matchupId - b.matchupId);

  interface PairState {
    winsA: number;
    winsB: number;
    droughtA: number;
    droughtB: number;
    lastWinSeasonA: number | null;
    lastWinSeasonB: number | null;
    /**
     * DECISIVE meetings so far (ties never increment this) — gates lead_flip below.
     *
     * FIX ROUND 1 (minor a): gating on "any prior meeting at all" (including ties) let a
     * first-decisive-game-after-one-or-more-ties fire a trivial "takes the lead" — going from
     * leaderBefore=null (0-0, or tied after N ties with 0 decisive games) to leaderAfter='A' on
     * the FIRST real result is just as meaningless as the very-first-meeting case this gate was
     * originally built to exclude: there's no established competitive series to "flip" from
     * either way. Gating on DECISIVE meetings specifically (not total meetings) correctly still
     * fires a genuine flip when the series is tied 1-1+ from real prior decisive games (that IS
     * a meaningful series with real history, just currently balanced).
     */
    decisiveMeetings: number;
  }
  const newPairState = (): PairState => ({ winsA: 0, winsB: 0, droughtA: 0, droughtB: 0, lastWinSeasonA: null, lastWinSeasonB: null, decisiveMeetings: 0 });
  const state = new Map<string, PairState>();

  for (const m of sorted) {
    const franchiseA = Math.min(m.homeFranchiseId, m.awayFranchiseId);
    const franchiseB = Math.max(m.homeFranchiseId, m.awayFranchiseId);
    const key = pairKey(franchiseA, franchiseB);

    if (m.winner === "tie") {
      const s = state.get(key) ?? newPairState();
      s.droughtA = 0;
      s.droughtB = 0;
      state.set(key, s);
      continue;
    }

    const s = state.get(key) ?? newPairState();
    const preGameDecisiveMeetings = s.decisiveMeetings;

    const winnerFranchiseId = m.winner === "home" ? m.homeFranchiseId : m.awayFranchiseId;
    const loserFranchiseId = m.winner === "home" ? m.awayFranchiseId : m.homeFranchiseId;
    const winnerIsA = winnerFranchiseId === franchiseA;

    const leaderBefore: "A" | "B" | null = s.winsA === s.winsB ? null : s.winsA > s.winsB ? "A" : "B";
    const preGameDrought = winnerIsA ? s.droughtA : s.droughtB;
    const preGameLastWin = winnerIsA ? s.lastWinSeasonA : s.lastWinSeasonB;

    if (winnerIsA) {
      s.winsA += 1;
      s.droughtA = 0;
      s.droughtB += 1;
      s.lastWinSeasonA = m.season;
    } else {
      s.winsB += 1;
      s.droughtB = 0;
      s.droughtA += 1;
      s.lastWinSeasonB = m.season;
    }
    s.decisiveMeetings += 1;
    state.set(key, s);

    const leaderAfter: "A" | "B" | null = s.winsA === s.winsB ? null : s.winsA > s.winsB ? "A" : "B";

    if (preGameDecisiveMeetings > 0 && leaderAfter !== null && leaderAfter !== leaderBefore) {
      const winsFor = winnerIsA ? s.winsA : s.winsB;
      const winsAgainst = winnerIsA ? s.winsB : s.winsA;
      const opponentName = franchiseName(names, loserFranchiseId);
      out.push({
        subjectType: "matchup",
        season: m.season,
        week: m.week,
        franchiseId: null,
        matchupId: m.matchupId,
        ruleId: "h2h_milestone",
        salience: SALIENCE.H2H_MILESTONE,
        scope: "franchise",
        renderedText: `Takes the all-time series lead over ${opponentName}, ${winsFor}-${winsAgainst}`,
        facts: { kind: "lead_flip", winnerFranchiseId, loserFranchiseId, winsFor, winsAgainst },
        seq: seq(),
      });
    }

    if (preGameDrought >= 4) {
      const opponentName = franchiseName(names, loserFranchiseId);
      const text = preGameLastWin === null ? `First-ever win over ${opponentName}` : `First win over ${opponentName} since ${preGameLastWin}`;
      out.push({
        subjectType: "matchup",
        season: m.season,
        week: m.week,
        franchiseId: null,
        matchupId: m.matchupId,
        ruleId: "h2h_milestone",
        salience: SALIENCE.H2H_MILESTONE,
        scope: "franchise",
        renderedText: text,
        facts: { kind: "drought_broken", winnerFranchiseId, loserFranchiseId, sinceSeason: preGameLastWin, drought: preGameDrought },
        seq: seq(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 7: belt_stakes — every belt_matches row gets a defense or transfer note.
// ---------------------------------------------------------------------------

function evalBeltStakes(
  beltMatches: ContextBeltMatchInput[],
  beltReigns: ContextBeltReignInput[],
  names: Record<number, string>,
  out: Candidate[],
  seq: () => number,
): void {
  const sorted = [...beltMatches].sort((a, b) => a.season - b.season || a.week - b.week || a.matchupId - b.matchupId);
  const reignByStart = new Map(beltReigns.map((r) => [`${r.franchiseId}:${r.startSeason}:${r.startWeek}`, r]));
  const leagueRecordDefenses = beltReigns.length > 0 ? Math.max(...beltReigns.map((r) => r.defenses)) : 0;

  let consecutiveDefenses = 0;
  for (const bm of sorted) {
    if (bm.result === "defense") {
      consecutiveDefenses += 1;
      const shy = leagueRecordDefenses - consecutiveDefenses;
      const tiedCount = beltReigns.filter((r) => r.defenses === leagueRecordDefenses).length;
      // FIX ROUND 1 (minor c): "1st straight defense" reads oddly for the very first defense of a
      // reign — a real ordinal only makes sense once there's a STREAK of 2+ to count.
      const countPhrase = consecutiveDefenses === 1 ? "First defense of the reign" : `${ordinal(consecutiveDefenses)} straight defense`;
      let text: string;
      if (shy > 0) {
        text = `${countPhrase} — ${spellSmall(shy)} shy of the league record`;
      } else if (tiedCount > 1) {
        text = `${countPhrase} — ties the league record for consecutive defenses`;
      } else {
        text = `${countPhrase} — a new league record for consecutive defenses`;
      }
      out.push({
        subjectType: "matchup",
        season: bm.season,
        week: bm.week,
        franchiseId: null,
        matchupId: bm.matchupId,
        ruleId: "belt_stakes",
        salience: SALIENCE.BELT_DEFENSE,
        scope: "league",
        renderedText: text,
        facts: { kind: "defense", holderFranchiseId: bm.holderFranchiseId, consecutiveDefenses, leagueRecordDefenses },
        seq: seq(),
      });
    } else {
      const newReign = reignByStart.get(`${bm.challengerFranchiseId}:${bm.season}:${bm.week}`);
      const holderName = franchiseName(names, bm.holderFranchiseId);
      const challengerName = franchiseName(names, bm.challengerFranchiseId);
      // FIX ROUND 1 (minor b): the `!newReign` branch is NOT reachable via real production data —
      // `beltMatches` and `beltReigns` are always both outputs of the SAME replay() call, which
      // always starts a new reign at the exact (challengerFranchiseId, season, week) of a
      // 'transfer' result (see replay.ts's startReign/endReign pairing). Kept (not removed)
      // because the engine is pure and accepts these as two independently-provided inputs — a
      // future caller passing inconsistent/incomplete fixture data (verified directly: see
      // context.test.ts's "unreachable via real data" belt_stakes test) would otherwise hit an
      // `undefined` reign and render nonsense. Graceful degradation over a crash/garbled string.
      //
      // TASK 14 FIX (user-reported): the count in this text must be the FRANCHISE's own reign
      // count, not `reignNo` (the LEAGUE-WIDE sequential reign number — that belongs on /belt,
      // never in this sentence, which otherwise reads as if it were the franchise's own count).
      // Derived from `beltReigns` filtered to this franchise, counting every one of ITS reigns up
      // to and including this new one (reignNo is chronological/monotonic across the whole
      // league, so `<=` correctly counts only this franchise's OWN reigns so far).
      let franchiseReignCount: number | null = null;
      let text: string;
      if (newReign) {
        franchiseReignCount = beltReigns.filter((r) => r.franchiseId === bm.challengerFranchiseId && r.reignNo <= newReign.reignNo).length;
        text =
          franchiseReignCount === 1
            ? `The belt changes hands — ${challengerName} claims it for the first time`
            : `The belt changes hands — ${challengerName} claims it for the ${ordinal(franchiseReignCount)} time`;
      } else {
        text = `The belt changes hands — ${challengerName} takes it from ${holderName}`;
      }
      out.push({
        subjectType: "matchup",
        season: bm.season,
        week: bm.week,
        franchiseId: null,
        matchupId: bm.matchupId,
        ruleId: "belt_stakes",
        salience: SALIENCE.BELT_TRANSFER,
        scope: "league",
        renderedText: text,
        facts: {
          kind: "transfer",
          holderFranchiseId: bm.holderFranchiseId,
          challengerFranchiseId: bm.challengerFranchiseId,
          reignNo: newReign?.reignNo ?? null,
          franchiseReignCount,
        },
        seq: seq(),
      });
      consecutiveDefenses = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Rule: beatdown_of_week (Task 17, user-requested) — the losing franchise with
// the largest losing margin THAT WEEK. Eligibility/tie-handling is shared
// with stage 4's `season_stats.beatdowns`/`career_stats.beatdowns` counts via
// `computeWeeklyBeatdowns` (src/engines/records.ts) — one derivation, two
// consumers, so they can never disagree on who won a given week's award.
//
// RULING — the brief's two example strings ("Beatdown of the Week — the
// week's worst loss (-38.4)" and "The 2nd-worst beatdown in league history")
// aren't full templates for both branches; read together with the brief's
// own naming ruling ("Named exactly 'Beatdown of the Week' in all
// user-facing copy"), the "Beatdown of the Week —" prefix is treated as
// ALWAYS present, with only the descriptive clause after the dash escalating
// when the week's worst loss ALSO ranks in the all-time top-3 worst
// beatdowns (`record_entries` key `worst_beatdown`, rank <= 3):
//   - default:  "Beatdown of the Week — the week's worst loss (-38.4)"
//   - rank 1:   "Beatdown of the Week — the worst beatdown in league history (-38.4)"
//   - rank 2/3: "Beatdown of the Week — the 2nd-worst beatdown in league history (-38.4)"
// The margin is rendered with a plain ASCII minus (`toFixed(1)`'s own
// output), matching every other signed number in this file — not a
// typographic Unicode minus, which would be inconsistent with the rest of
// the codebase's number formatting.
// ---------------------------------------------------------------------------

function evalBeatdownOfWeek(teamWeeks: ContextTeamWeekInput[], recordEntries: ContextRecordEntryInput[], out: Candidate[], seq: () => number): void {
  const beatdownInputs: BeatdownTeamWeekInput[] = teamWeeks.map((tw) => ({
    franchiseId: tw.franchiseId,
    season: tw.season,
    week: tw.week,
    result: tw.result,
    margin: tw.margin,
  }));
  const awards = computeWeeklyBeatdowns(beatdownInputs);
  if (awards.length === 0) return;

  const teamWeekByKey = new Map(teamWeeks.map((tw) => [teamWeekKey(tw.franchiseId, tw.season, tw.week), tw]));

  // All-time top-3 worst_beatdown rank, keyed by the SAME (franchiseId, season, week) an award
  // would use — escalates the text below when this week's worst loss is ALSO globally notable.
  const topBeatdownRankByKey = new Map<string, number>();
  for (const e of recordEntries) {
    if (e.recordKey !== "worst_beatdown" || e.week === null || e.rank > 3) continue;
    topBeatdownRankByKey.set(teamWeekKey(e.franchiseId, e.season, e.week), e.rank);
  }

  for (const award of awards) {
    const key = teamWeekKey(award.franchiseId, award.season, award.week);
    const tw = teamWeekByKey.get(key);
    const allTimeRank = topBeatdownRankByKey.get(key) ?? null;
    const marginText = award.margin.toFixed(1);
    const descriptor =
      allTimeRank === null
        ? "the week's worst loss"
        : allTimeRank === 1
          ? "the worst beatdown in league history"
          : `the ${ordinal(allTimeRank)}-worst beatdown in league history`;

    out.push({
      subjectType: "team_week",
      season: award.season,
      week: award.week,
      franchiseId: award.franchiseId,
      matchupId: tw?.matchupId ?? null,
      ruleId: "beatdown_of_week",
      salience: SALIENCE.BEATDOWN_OF_WEEK,
      scope: "league",
      renderedText: `Beatdown of the Week — ${descriptor} (${marginText})`,
      facts: { margin: award.margin, allTimeRank },
      seq: seq(),
    });
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function subjectKey(c: Candidate): string {
  return c.subjectType === "team_week" ? `tw:${c.franchiseId}:${c.season}:${c.week}` : `m:${c.matchupId}`;
}

export function evaluateContextRules(inputs: ContextEngineInputs): ContextNote[] {
  let seqCounter = 0;
  const seq = () => seqCounter++;

  const teamWeekByKey = new Map(inputs.teamWeeks.map((tw) => [teamWeekKey(tw.franchiseId, tw.season, tw.week), tw]));

  const candidates: Candidate[] = [];
  evalRecordSourcedRules(inputs.recordEntries, teamWeekByKey, candidates, seq);
  evalSeasonScoreRank(inputs.teamWeeks, candidates, seq);
  evalFranchiseBestSince(inputs.teamWeeks, candidates, seq);
  evalStreakContext(inputs.teamWeeks, candidates, seq);
  evalEloLandmark(inputs.teamWeeks, candidates, seq);
  evalCareerMilestone(inputs.teamWeeks, inputs.franchiseNames, candidates, seq);
  evalH2HMilestone(inputs.h2hMatchups, inputs.franchiseNames, candidates, seq);
  evalBeltStakes(inputs.beltMatches, inputs.beltReigns, inputs.franchiseNames, candidates, seq);
  evalBeatdownOfWeek(inputs.teamWeeks, inputs.recordEntries, candidates, seq);

  // Cap each subject at its top 3 by (salience desc, scope rank asc, ruleId asc, seq asc).
  const bySubject = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = subjectKey(c);
    const list = bySubject.get(key) ?? [];
    list.push(c);
    bySubject.set(key, list);
  }

  const capped: Candidate[] = [];
  for (const list of bySubject.values()) {
    const sorted = [...list].sort(
      (a, b) => b.salience - a.salience || SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || a.ruleId.localeCompare(b.ruleId) || a.seq - b.seq,
    );
    capped.push(...sorted.slice(0, 3));
  }

  // Final deterministic overall order — independent of any Map/object iteration order above.
  capped.sort((a, b) => {
    return (
      a.season - b.season ||
      a.week - b.week ||
      a.subjectType.localeCompare(b.subjectType) ||
      (a.franchiseId ?? -1) - (b.franchiseId ?? -1) ||
      (a.matchupId ?? -1) - (b.matchupId ?? -1) ||
      b.salience - a.salience ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.seq - b.seq
    );
  });

  return capped.map((c) => ({
    subjectType: c.subjectType,
    season: c.season,
    week: c.week,
    franchiseId: c.franchiseId,
    matchupId: c.matchupId,
    ruleId: c.ruleId,
    salience: c.salience,
    renderedText: c.renderedText,
    facts: c.facts,
  }));
}
