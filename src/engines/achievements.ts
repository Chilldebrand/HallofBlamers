/**
 * Achievements engine — stat-build stage 6. Pure per AGENTS.md: no DB, no IO, no imports from
 * `src/server/`. Takes already-derived stage 1-4 outputs (team_week rows incl. optimal/
 * efficiency, belt match outcomes, per-week pre-game Elo snapshots, and week-scope
 * `record_entries` rows) and returns deterministic achievement awards — upserted by
 * AGENTS.md's "deterministic key, never appended" rule via `dedupeKey`, so a full rebuild
 * always reproduces the exact same set of rows.
 *
 * SETTLEMENT GATE (brief: "a week only produces awards once it is final for all its
 * matchups"): callers pass `finalWeeks`, a set of `"season:week"` keys for weeks where every
 * matchup row that season/week is final — computed the same "structural evidence" way
 * build.ts already computes season completeness (never inferred from "every row currently in
 * the DB happens to be final", which is unsound the instant a week's rows don't exist yet —
 * see build.ts's own `computeSeasonCompleteBySeason` docstring for why). Any team-week whose
 * (season, week) isn't in this set is silently skipped by every rule below — never fabricated
 * mid-week, and the sentinel/honest-data rule ("no awards from ... the current in-progress
 * week") falls straight out of this one gate rather than being special-cased per achievement.
 *
 * Determinism: no I/O, no clock, no Map/Set iteration order leaks into the output — the final
 * array is explicitly sorted before being returned (see `sortAwards`).
 *
 * NO week-type (regular/playoff/consolation) filter anywhere in this file, deliberately — same
 * ruling as `computeWeeklyBeatdowns` (src/engines/records.ts): a playoff Perfect Lineup or a
 * consolation-bracket Giant Killer is still a real one, and `weekly_high`/`record_breaker` in
 * particular MUST include genuine consolation games (the real all-time weekly high, 187.7, was
 * scored in exactly such a game — see build.ts's own `buildRecordEntryRows` docstring for the
 * same precedent on the record book itself).
 */

export type AchievementKey =
  | "perfect_lineup"
  | "bench_disaster"
  | "weekly_high"
  | "narrow_escape"
  | "heartbreaker"
  | "belt_thief"
  | "belt_defender"
  | "giant_killer"
  | "record_breaker"
  | "lucky_winner";

export interface AchievementAward {
  achievementKey: AchievementKey;
  franchiseId: number;
  season: number;
  week: number;
  /** Deterministic, order-independent — same inputs always produce the same key set. */
  dedupeKey: string;
  payload: Record<string, unknown> | null;
}

export interface AchievementsTeamWeekInput {
  franchiseId: number;
  season: number;
  week: number;
  score: number;
  /** Null on a bye or an unsettled matchup — such rows are never eligible for any award below. */
  result: "W" | "L" | "T" | null;
  /** Signed, own score minus opponent score — null exactly when `result` is null. */
  margin: number | null;
  /** Null exactly when `result` is null (byes/unsettled never have an opponent to compare to). */
  opponentFranchiseId: number | null;
  /**
   * Null whenever optimal isn't computable — pre-2018 seasons have zero archived roster data
   * (see AGENTS.md/build.ts), so this stays NULL for every 2015-2017 team-week, never faked.
   * `perfect_lineup`/`bench_disaster` are the only two rules that read this; both produce NO
   * award (not a fabricated one) when it's null.
   */
  optimalScore: number | null;
  /** Null exactly when `optimalScore` is null (same "all null together" invariant as team_week). */
  efficiency: number | null;
}

export interface AchievementsBeltMatchInput {
  matchupId: number;
  season: number;
  week: number;
  /** The holder GOING INTO this matchup (pre-transfer, if it transfers). */
  holderFranchiseId: number;
  challengerFranchiseId: number;
  result: "defense" | "transfer";
  holderScore: number;
  challengerScore: number;
}

export interface AchievementsEloInput {
  franchiseId: number;
  season: number;
  week: number;
  /** Elo going INTO this franchise's matchup that week (before this week's result is applied). */
  eloPre: number;
}

/**
 * Only week-scope keys (`week !== null`) are ever attributable to a single team-week — the
 * caller may pass every `record_entries` row (any recordKey, any rank); non-attributable
 * season/streak/belt-scope rows (`week === null`) and any rank other than 1 are simply never
 * matched by `evalRecordBreaker` below, so filtering upstream isn't required.
 */
export interface AchievementsRecordEntryInput {
  recordKey: string;
  rank: number;
  franchiseId: number;
  season: number;
  week: number | null;
  value: number;
}

export interface AchievementsInput {
  /** Every team_week row worth considering, any order — the engine sorts internally as needed. */
  teamWeeks: AchievementsTeamWeekInput[];
  beltMatches: AchievementsBeltMatchInput[];
  elo: AchievementsEloInput[];
  recordEntries: AchievementsRecordEntryInput[];
  /** `"season:week"` keys — see the module docstring's SETTLEMENT GATE. */
  finalWeeks: ReadonlySet<string>;
}

/** Giant Killer: beat an opponent whose PRE-GAME Elo was at least this much above yours. */
const GIANT_KILLER_ELO_GAP = 150;
/** Narrow Escape / Heartbreaker: margin strictly less than this — exactly 2.0 is excluded. */
const NARROW_MARGIN = 2.0;
/**
 * Perfect Lineup: `efficiency === 1.0` per the brief, compared with a tight float-safety
 * epsilon rather than bit-exact `===` — `optimalScore` and `score` are two independently
 * computed sums over the same set of numbers (ESPN's reported total vs. this engine's own
 * lineup-selection sum), which IEEE 754 addition does not guarantee are bit-identical even
 * when the actual starting lineup IS the optimal one. 1e-9 is many orders of magnitude tighter
 * than any real scoring difference (fantasy scores are quantized to 0.01 at loosest) while
 * comfortably absorbing floating-point summation-order noise.
 */
const PERFECT_LINEUP_EPSILON = 1e-9;
/**
 * FIX ROUND 1 (Important finding): `margin` (`team_week.margin`) is raw, unrounded
 * `score - opponentScore` float subtraction (build.ts's `buildTeamWeekCandidates`) — NOT
 * pre-rounded to cents the way a UI display value would be. For a genuinely decimal-exact 2.00
 * margin, that subtraction is not guaranteed to land on the bit-exact double `2.0`: e.g.
 * `128.01 - 126.01 === 1.9999999999999858` in IEEE 754, even though both inputs are exact
 * 2-decimal fantasy scores and the "true" margin is exactly 2.00. A bare `margin < NARROW_MARGIN`
 * would incorrectly award `narrow_escape`/`heartbreaker` on that noise alone — the reviewer's
 * ~20,000-sample empirical scan found this on ~1% of decimal-exact-2.00 score pairs. Shifting the
 * boundary down by the SAME 1e-9 float-safety epsilon `PERFECT_LINEUP_EPSILON` already uses (real
 * fantasy scores are quantized to 0.01 at loosest, so 1e-9 can never swallow a genuine narrow
 * margin) makes the exact-2.00 case exclude reliably regardless of which way the float noise
 * happens to land, without moving the boundary for any real, non-2.00 margin at all.
 */
const NARROW_MARGIN_THRESHOLD = NARROW_MARGIN - PERFECT_LINEUP_EPSILON;

function weekKey(season: number, week: number): string {
  return `${season}:${week}`;
}

function makeKey(achievementKey: AchievementKey, season: number, week: number, franchiseId: number, suffix?: string): string {
  const base = `${achievementKey}:${season}:${week}:${franchiseId}`;
  return suffix ? `${base}:${suffix}` : base;
}

// ---------------------------------------------------------------------------
// perfect_lineup / bench_disaster — both gate on efficiency/optimalScore being
// non-null (never fabricated for pre-2018 seasons with no roster data).
// ---------------------------------------------------------------------------

function evalPerfectLineupAndBenchDisaster(teamWeeks: AchievementsTeamWeekInput[], out: AchievementAward[]): void {
  for (const tw of teamWeeks) {
    if (tw.efficiency === null || tw.optimalScore === null) continue;

    if (Math.abs(tw.efficiency - 1) < PERFECT_LINEUP_EPSILON) {
      out.push({
        achievementKey: "perfect_lineup",
        franchiseId: tw.franchiseId,
        season: tw.season,
        week: tw.week,
        dedupeKey: makeKey("perfect_lineup", tw.season, tw.week, tw.franchiseId),
        payload: { score: tw.score, optimalScore: tw.optimalScore },
      });
    }

    if (tw.result === "L" && tw.margin !== null && tw.opponentFranchiseId !== null) {
      const opponentScore = tw.score - tw.margin;
      if (tw.optimalScore > opponentScore) {
        out.push({
          achievementKey: "bench_disaster",
          franchiseId: tw.franchiseId,
          season: tw.season,
          week: tw.week,
          dedupeKey: makeKey("bench_disaster", tw.season, tw.week, tw.franchiseId),
          payload: {
            score: tw.score,
            optimalScore: tw.optimalScore,
            opponentFranchiseId: tw.opponentFranchiseId,
            opponentScore,
          },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// weekly_high / lucky_winner — both need the full set of scores for their
// (season, week), so they share one grouping pass.
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function evalWeeklyHighAndLuckyWinner(teamWeeks: AchievementsTeamWeekInput[], out: AchievementAward[]): void {
  const byWeek = new Map<string, AchievementsTeamWeekInput[]>();
  for (const tw of teamWeeks) {
    const key = weekKey(tw.season, tw.week);
    const list = byWeek.get(key) ?? [];
    list.push(tw);
    byWeek.set(key, list);
  }

  for (const list of byWeek.values()) {
    const scores = list.map((tw) => tw.score);
    const maxScore = Math.max(...scores);
    const medianScore = median(scores);

    for (const tw of list) {
      // Ties: EVERY franchise at the week's top score earns Weekly High.
      if (tw.score === maxScore) {
        out.push({
          achievementKey: "weekly_high",
          franchiseId: tw.franchiseId,
          season: tw.season,
          week: tw.week,
          dedupeKey: makeKey("weekly_high", tw.season, tw.week, tw.franchiseId),
          payload: { score: tw.score },
        });
      }

      if (tw.result === "W" && tw.score < medianScore) {
        out.push({
          achievementKey: "lucky_winner",
          franchiseId: tw.franchiseId,
          season: tw.season,
          week: tw.week,
          dedupeKey: makeKey("lucky_winner", tw.season, tw.week, tw.franchiseId),
          payload: { score: tw.score, median: medianScore },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// narrow_escape / heartbreaker — strict margin threshold, exactly 2.0 excluded (see
// NARROW_MARGIN_THRESHOLD's docstring above for why this is float-safety-epsilon-adjusted,
// not a bare `< NARROW_MARGIN`).
// ---------------------------------------------------------------------------

function evalNarrowMargins(teamWeeks: AchievementsTeamWeekInput[], out: AchievementAward[]): void {
  for (const tw of teamWeeks) {
    if (tw.margin === null) continue;

    if (tw.result === "W" && tw.margin > 0 && tw.margin < NARROW_MARGIN_THRESHOLD) {
      out.push({
        achievementKey: "narrow_escape",
        franchiseId: tw.franchiseId,
        season: tw.season,
        week: tw.week,
        dedupeKey: makeKey("narrow_escape", tw.season, tw.week, tw.franchiseId),
        payload: { margin: tw.margin, opponentFranchiseId: tw.opponentFranchiseId },
      });
    }

    if (tw.result === "L" && tw.margin < 0 && -tw.margin < NARROW_MARGIN_THRESHOLD) {
      out.push({
        achievementKey: "heartbreaker",
        franchiseId: tw.franchiseId,
        season: tw.season,
        week: tw.week,
        dedupeKey: makeKey("heartbreaker", tw.season, tw.week, tw.franchiseId),
        payload: { margin: tw.margin, opponentFranchiseId: tw.opponentFranchiseId },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// belt_thief / belt_defender — straight from belt_matches (already only
// produced for decided, non-bye matchups by replay()).
// ---------------------------------------------------------------------------

function evalBeltAwards(beltMatches: AchievementsBeltMatchInput[], finalWeeks: ReadonlySet<string>, out: AchievementAward[]): void {
  for (const bm of beltMatches) {
    if (!finalWeeks.has(weekKey(bm.season, bm.week))) continue;

    if (bm.result === "transfer") {
      out.push({
        achievementKey: "belt_thief",
        franchiseId: bm.challengerFranchiseId,
        season: bm.season,
        week: bm.week,
        dedupeKey: makeKey("belt_thief", bm.season, bm.week, bm.challengerFranchiseId),
        payload: {
          matchupId: bm.matchupId,
          holderFranchiseId: bm.holderFranchiseId,
          holderScore: bm.holderScore,
          challengerScore: bm.challengerScore,
        },
      });
    } else {
      out.push({
        achievementKey: "belt_defender",
        franchiseId: bm.holderFranchiseId,
        season: bm.season,
        week: bm.week,
        dedupeKey: makeKey("belt_defender", bm.season, bm.week, bm.holderFranchiseId),
        payload: {
          matchupId: bm.matchupId,
          challengerFranchiseId: bm.challengerFranchiseId,
          holderScore: bm.holderScore,
          challengerScore: bm.challengerScore,
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// giant_killer — needs both sides' PRE-GAME Elo for the same (season, week).
// ---------------------------------------------------------------------------

function evalGiantKiller(teamWeeks: AchievementsTeamWeekInput[], elo: AchievementsEloInput[], out: AchievementAward[]): void {
  const eloByKey = new Map<string, number>();
  for (const e of elo) eloByKey.set(`${e.franchiseId}:${e.season}:${e.week}`, e.eloPre);

  for (const tw of teamWeeks) {
    if (tw.result !== "W" || tw.opponentFranchiseId === null) continue;

    const ownEloPre = eloByKey.get(`${tw.franchiseId}:${tw.season}:${tw.week}`);
    const opponentEloPre = eloByKey.get(`${tw.opponentFranchiseId}:${tw.season}:${tw.week}`);
    if (ownEloPre === undefined || opponentEloPre === undefined) continue;

    const gap = opponentEloPre - ownEloPre;
    if (gap >= GIANT_KILLER_ELO_GAP) {
      out.push({
        achievementKey: "giant_killer",
        franchiseId: tw.franchiseId,
        season: tw.season,
        week: tw.week,
        dedupeKey: makeKey("giant_killer", tw.season, tw.week, tw.franchiseId),
        payload: { opponentFranchiseId: tw.opponentFranchiseId, ownEloPre, opponentEloPre, gap },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// record_breaker — every current all-time #1 in a week-scope record_entries
// key, mirroring the context engine's `record_broken` rule 8 (src/engines/
// context.ts): same source (record_entries), same filter (attributable —
// week !== null — entries at rank 1), same "every rank-1 row gets one,
// including a multi-way tie" cardinality. Unlike context.ts's rendered
// "previously X, {year}" text, an achievement never CITES a comparison
// entry, so there's no "previously" claim that could point at a future
// row — the chronology-safety concern context.ts had to solve for its own
// text (never comparing against a later same-rank entry) simply doesn't
// arise here; reusing record_entries' already-computed rank-1 set is
// sufficient on its own.
// ---------------------------------------------------------------------------

function evalRecordBreaker(recordEntries: AchievementsRecordEntryInput[], finalWeeks: ReadonlySet<string>, out: AchievementAward[]): void {
  for (const e of recordEntries) {
    if (e.rank !== 1 || e.week === null) continue;
    if (!finalWeeks.has(weekKey(e.season, e.week))) continue;

    out.push({
      achievementKey: "record_breaker",
      franchiseId: e.franchiseId,
      season: e.season,
      week: e.week,
      dedupeKey: makeKey("record_breaker", e.season, e.week, e.franchiseId, e.recordKey),
      payload: { recordKey: e.recordKey, value: e.value },
    });
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function sortAwards(a: AchievementAward, b: AchievementAward): number {
  return (
    a.season - b.season ||
    a.week - b.week ||
    a.achievementKey.localeCompare(b.achievementKey) ||
    a.franchiseId - b.franchiseId ||
    a.dedupeKey.localeCompare(b.dedupeKey)
  );
}

export function computeAchievements(input: AchievementsInput): AchievementAward[] {
  // Only settled, fully-final-week team-weeks ever produce an award — see the module
  // docstring's SETTLEMENT GATE. This one filter is what makes "no awards from ... the
  // current in-progress week" true for every per-team-week rule below without each rule
  // having to re-derive it.
  const settled = input.teamWeeks.filter((tw) => tw.result !== null && input.finalWeeks.has(weekKey(tw.season, tw.week)));

  const out: AchievementAward[] = [];
  evalPerfectLineupAndBenchDisaster(settled, out);
  evalWeeklyHighAndLuckyWinner(settled, out);
  evalNarrowMargins(settled, out);
  evalBeltAwards(input.beltMatches, input.finalWeeks, out);
  evalGiantKiller(settled, input.elo, out);
  evalRecordBreaker(input.recordEntries, input.finalWeeks, out);

  out.sort(sortAwards);
  return out;
}
