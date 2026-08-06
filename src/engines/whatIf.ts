/**
 * What-If Simulator (Task 35, roadmap §21 v1) — pure, no DB, no IO, no imports from
 * `src/server/`, per AGENTS.md. Three replay modes, all built on ONE shared primitive
 * (`replayUnderSchedule`): take a franchise's own REAL per-week scores and pair them against a
 * different real set of weekly opponent scores. Nothing here ever invents or projects a score —
 * every number in and out is a real score that actually happened somewhere in league history;
 * only the PAIRING of who-played-whom (or which lineup a franchise started) changes.
 *
 * Scoping decisions pushed here from the callers (queries/whatIf.ts translates real team_week
 * rows into these inputs, same "engine stays dumb, caller resolves" pattern as optimalLineup.ts):
 *   - Schedule Swap / Best-Worst Schedule operate on REGULAR SEASON weeks only. Playoff pairings
 *     are seeded by standings, not a fixed round-robin schedule — "swapping" a playoff bracket
 *     slot doesn't mean anything the way swapping a regular-season opponent does.
 *   - Perfect Lineups uses every decided week (regular + playoff) — it never touches who the
 *     opponent was, only the franchise's own score, so playoff weeks are fair game.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface WhatIfWeekInput {
  week: number;
  /** This franchise's own real score that week — never recomputed, never invented. */
  ownScore: number;
  /** Null on a bye — no opponent that week. */
  opponentFranchiseId: number | null;
  /** Real score. Null if and only if `opponentFranchiseId` is null. */
  opponentScore: number | null;
}

export interface WhatIfScheduleCoverageResult {
  available: boolean;
  unavailableReason: string | null;
}

/** Proves that every supplied franchise covers the same weeks and that every in-scope matchup is
 * reciprocal. Query callers pass `requireAllOpponents=true` with the full season field; the public
 * two-franchise adapter validates reciprocal head-to-head rows without pretending it can prove
 * opponents that were not supplied. */
export function validateWhatIfScheduleCoverage(
  franchiseSchedules: { franchiseId: number; weeks: WhatIfWeekInput[] }[],
  requireAllOpponents = false,
  expectedFranchiseIds?: readonly number[],
): WhatIfScheduleCoverageResult {
  if (franchiseSchedules.length === 0 || franchiseSchedules.some((entry) => entry.weeks.length === 0)) {
    return { available: false, unavailableReason: "Complete schedule coverage is unavailable for this season." };
  }

  const expectedWeeks = new Set(franchiseSchedules[0]!.weeks.map((week) => week.week));
  const franchiseIds = new Set(franchiseSchedules.map((entry) => entry.franchiseId));
  if (expectedFranchiseIds) {
    const expected = new Set(expectedFranchiseIds);
    if (
      expected.size !== expectedFranchiseIds.length ||
      franchiseIds.size !== expected.size ||
      [...expected].some((franchiseId) => !franchiseIds.has(franchiseId))
    ) {
      return { available: false, unavailableReason: "Expected franchise coverage is incomplete for this schedule." };
    }
  }
  const rows = new Map<string, WhatIfWeekInput>();
  for (const entry of franchiseSchedules) {
    const weeks = new Set(entry.weeks.map((week) => week.week));
    if (weeks.size !== entry.weeks.length || weeks.size !== expectedWeeks.size || [...expectedWeeks].some((week) => !weeks.has(week))) {
      return { available: false, unavailableReason: "Expected week coverage is incomplete or duplicated for this season." };
    }
    for (const week of entry.weeks) rows.set(`${entry.franchiseId}:${week.week}`, week);
  }

  for (const entry of franchiseSchedules) {
    for (const week of entry.weeks) {
      if ((week.opponentFranchiseId === null) !== (week.opponentScore === null)) {
        return { available: false, unavailableReason: "Reciprocal schedule coverage is incomplete for this season." };
      }
      if (week.opponentFranchiseId === null) continue;
      if (!requireAllOpponents && !franchiseIds.has(week.opponentFranchiseId)) continue;
      const opponent = rows.get(`${week.opponentFranchiseId}:${week.week}`);
      if (
        !opponent ||
        opponent.opponentFranchiseId !== entry.franchiseId ||
        opponent.ownScore !== week.opponentScore ||
        opponent.opponentScore !== week.ownScore
      ) {
        return { available: false, unavailableReason: "Reciprocal schedule coverage is incomplete for this season." };
      }
    }
  }

  return { available: true, unavailableReason: null };
}

export type WhatIfResultLetter = "W" | "L" | "T";

function decide(own: number, opp: number): WhatIfResultLetter {
  if (own > opp) return "W";
  if (own < opp) return "L";
  return "T";
}

export interface WhatIfSeasonWeek {
  week: number;
  ownScore: number;
  /** Null = no game this week (a bye, inherited or original) — excluded from the season record. */
  opponentFranchiseId: number | null;
  opponentScore: number | null;
  result: WhatIfResultLetter | null;
}

export interface WhatIfSeasonRecord {
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  /** Chronological (week asc). Bye weeks (no opponent) are included here for display but never
   * contribute to wins/losses/points — a what-if table can still show "Wk4 — bye, no game." */
  weeks: WhatIfSeasonWeek[];
}

function summarize(weeks: WhatIfSeasonWeek[]): WhatIfSeasonRecord {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let pointsFor = 0;
  let pointsAgainst = 0;
  for (const w of weeks) {
    if (w.opponentFranchiseId === null || w.opponentScore === null) continue; // no game — no stat
    pointsFor += w.ownScore;
    pointsAgainst += w.opponentScore;
    if (w.result === "W") wins += 1;
    else if (w.result === "L") losses += 1;
    else ties += 1;
  }
  return { wins, losses, ties, pointsFor, pointsAgainst, weeks };
}

/**
 * Replays `ownWeeks` (a franchise's real per-week scores) against `scheduleWeeks` (another
 * franchise's real per-week OPPONENTS): "what would `ownFranchiseId`'s record have been if it had
 * played `scheduleFranchiseId`'s schedule instead of its own." `ownWeeks`'s own scores are never
 * touched — only the opponent identity/score each week is substituted from `scheduleWeeks`.
 *
 * HEAD-TO-HEAD WEEK RULE (the disclosed design decision — surfaced on the /what-if page verbatim
 * as `HEAD_TO_HEAD_WEEK_RULE`): a week where `ownFranchiseId` and `scheduleFranchiseId` ACTUALLY
 * played each other is exempt from substitution and keeps its real result. Naive substitution
 * would point `ownFranchiseId`'s new opponent at `scheduleFranchiseId`'s own real opponent that
 * week — but `scheduleFranchiseId`'s real opponent that week WAS `ownFranchiseId` itself, so an
 * un-exempted swap has each side "playing itself." There's no sensible substitute for a game the
 * two of them already played against each other, so it carries over unchanged. This is also what
 * makes swapping twice an identity operation (see whatIf.test.ts's double-swap fixture): the
 * exemption fires again on the second pass for exactly the same week, for exactly the same reason.
 *
 * Passing the same franchise id as both `ownFranchiseId` and `scheduleFranchiseId` (with
 * `scheduleWeeks === ownWeeks`) degenerates to "replay a franchise under its own real schedule" —
 * used by `bestWorstSchedule` as a free, self-checking baseline (must reproduce the real record).
 */
function replayUnderSchedule(
  ownFranchiseId: number,
  ownWeeks: WhatIfWeekInput[],
  scheduleFranchiseId: number,
  scheduleWeeks: WhatIfWeekInput[],
): WhatIfSeasonWeek[] {
  const ownByWeek = new Map(ownWeeks.map((w) => [w.week, w]));
  const scheduleByWeek = new Map(scheduleWeeks.map((w) => [w.week, w]));
  const allWeeks = new Set<number>([...ownByWeek.keys(), ...scheduleByWeek.keys()]);

  const result: WhatIfSeasonWeek[] = [];
  for (const week of [...allWeeks].sort((a, b) => a - b)) {
    const own = ownByWeek.get(week);
    if (!own) continue; // this franchise has no data for this week at all — nothing to replay

    let opponentFranchiseId: number | null;
    let opponentScore: number | null;
    if (own.opponentFranchiseId === scheduleFranchiseId) {
      // H2H exemption — see docstring. Covers the self-schedule (ownFranchiseId === scheduleFranchiseId)
      // case too, vacuously: a franchise's own opponent is never itself, so this only ever fires
      // for a genuine two-different-franchise head-to-head week.
      opponentFranchiseId = own.opponentFranchiseId;
      opponentScore = own.opponentScore;
    } else {
      const sched = scheduleByWeek.get(week);
      opponentFranchiseId = sched?.opponentFranchiseId ?? null;
      opponentScore = sched?.opponentScore ?? null;
    }

    result.push({
      week,
      ownScore: own.ownScore,
      opponentFranchiseId,
      opponentScore,
      result: opponentFranchiseId !== null && opponentScore !== null ? decide(own.ownScore, opponentScore) : null,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mode 1: Schedule Swap
// ---------------------------------------------------------------------------

export const HEAD_TO_HEAD_WEEK_RULE =
  "Weeks the two franchises actually played each other keep their real result — a schedule swap can't un-play a game they already played against one another.";

export interface ScheduleSwapFranchiseResult {
  franchiseId: number;
  record: WhatIfSeasonRecord;
  /** Real regular-season record, same week scope as `record` — see `scheduleSwap`'s docstring. */
  actual: WhatIfSeasonRecord;
}

export interface ScheduleSwapResult {
  season: number;
  /** Disclosed verbatim on the page — see HEAD_TO_HEAD_WEEK_RULE. */
  headToHeadRule: string;
  franchiseA: ScheduleSwapFranchiseResult;
  franchiseB: ScheduleSwapFranchiseResult;
}

/** A faces B's real weekly opponents and vice versa (regular season only — see module docstring). */
export function scheduleSwap(
  season: number,
  franchiseAId: number,
  weeksA: WhatIfWeekInput[],
  franchiseBId: number,
  weeksB: WhatIfWeekInput[],
): ScheduleSwapResult {
  const aWeeks = replayUnderSchedule(franchiseAId, weeksA, franchiseBId, weeksB);
  const bWeeks = replayUnderSchedule(franchiseBId, weeksB, franchiseAId, weeksA);
  // Self-schedule replay (same trick bestWorstSchedule uses) — the franchise's REAL regular-season
  // record, same week scope as the swapped one above, so a page-level "vs. actual" verdict compares
  // apples to apples instead of against a full-season (incl. playoffs) standings total.
  const aActual = replayUnderSchedule(franchiseAId, weeksA, franchiseAId, weeksA);
  const bActual = replayUnderSchedule(franchiseBId, weeksB, franchiseBId, weeksB);
  return {
    season,
    headToHeadRule: HEAD_TO_HEAD_WEEK_RULE,
    franchiseA: { franchiseId: franchiseAId, record: summarize(aWeeks), actual: summarize(aActual) },
    franchiseB: { franchiseId: franchiseBId, record: summarize(bWeeks), actual: summarize(bActual) },
  };
}

// ---------------------------------------------------------------------------
// Mode 2: Best/Worst Schedule
// ---------------------------------------------------------------------------

export interface BestWorstScheduleEntry {
  /** The OTHER franchise whose weekly opponents were adopted — `franchiseId`'s own scores are
   * unchanged throughout; only whose schedule it's replayed under varies. */
  scheduleSourceFranchiseId: number;
  record: WhatIfSeasonRecord;
}

export interface BestWorstScheduleResult {
  season: number;
  franchiseId: number;
  available: boolean;
  unavailableReason: string | null;
  /** The target replayed under its OWN real schedule via the same machinery — must equal its
   * real record (self-check; see whatIf.test.ts). Included so the page can show "vs. actual." */
  actual: WhatIfSeasonRecord;
  /** One entry per other franchise in the season, sorted best-first (see `compareRecords`). */
  schedules: BestWorstScheduleEntry[];
  best: BestWorstScheduleEntry | null;
  worst: BestWorstScheduleEntry | null;
}

/** Best-first: win% desc, then wins desc, then points-for desc. Ties beyond that are broken by
 * the caller (schedule-source franchise id asc) for a total, deterministic order. */
function compareRecords(a: WhatIfSeasonRecord, b: WhatIfSeasonRecord): number {
  const gamesA = a.wins + a.losses + a.ties;
  const gamesB = b.wins + b.losses + b.ties;
  const pctA = gamesA > 0 ? (a.wins + 0.5 * a.ties) / gamesA : 0;
  const pctB = gamesB > 0 ? (b.wins + 0.5 * b.ties) / gamesB : 0;
  if (pctB !== pctA) return pctB - pctA;
  if (b.wins !== a.wins) return b.wins - a.wins;
  return b.pointsFor - a.pointsFor;
}

/** `franchiseId`'s record under every OTHER franchise's real regular-season schedule, min/max. */
export function bestWorstSchedule(
  season: number,
  franchiseId: number,
  ownWeeks: WhatIfWeekInput[],
  otherFranchises: { franchiseId: number; weeks: WhatIfWeekInput[] }[],
): BestWorstScheduleResult {
  const actual = summarize(replayUnderSchedule(franchiseId, ownWeeks, franchiseId, ownWeeks));

  const schedules = otherFranchises
    .filter((o) => o.franchiseId !== franchiseId)
    .map((o) => ({
      scheduleSourceFranchiseId: o.franchiseId,
      record: summarize(replayUnderSchedule(franchiseId, ownWeeks, o.franchiseId, o.weeks)),
    }))
    .sort((x, y) => compareRecords(x.record, y.record) || x.scheduleSourceFranchiseId - y.scheduleSourceFranchiseId);

  return {
    season,
    franchiseId,
    available: schedules.length > 0,
    unavailableReason: schedules.length > 0 ? null : "No comparison schedules are available for this season.",
    actual,
    schedules,
    best: schedules[0] ?? null,
    worst: schedules.length > 0 ? schedules[schedules.length - 1]! : null,
  };
}

// ---------------------------------------------------------------------------
// Mode 3: Perfect Lineups
// ---------------------------------------------------------------------------

export interface OptimalLineupWeekInput {
  week: number;
  /** The franchise's real score is a floor: a perfect lineup can never score fewer points than
   * the lineup that actually started. Optional for historical callers that only archived the
   * optimal total; DB callers in this app always provide it. */
  actualScore?: number;
  /** Null = no roster_slots data archived for this week. Never faked as 0. */
  optimalScore: number | null;
  /** Null on a bye. */
  opponentFranchiseId: number | null;
  /** The opponent's REAL actual score (honest baseline — the opponent doesn't also get their
   * optimal lineup). Null if and only if `opponentFranchiseId` is null. */
  opponentScore: number | null;
}

export interface OptimalLineupSeasonResult {
  season: number;
  franchiseId: number;
  available: boolean;
  /** Set only when `available` is false. */
  unavailableReason: string | null;
  /** Null when `available` is false. */
  record: WhatIfSeasonRecord | null;
}

export const PRE_OPTIMAL_LINEUP_DATA_REASON =
  "No lineup data is archived for every decided week in this season, so Perfect Lineups can't be computed honestly.";
export const NO_DECIDED_LINEUP_GAMES_REASON =
  "No decided games with an opponent are archived for this season, so Perfect Lineups is unavailable.";

/** Season record if `franchiseId` had started its optimal lineup every week — opponents keep
 * their real actual scores (honest baseline: nobody else is optimized either). Regular season +
 * playoffs both included (see module docstring); a season with ANY decided week missing
 * `optimalScore` is refused wholesale rather than silently under-counted. */
export function optimalLineupSeason(season: number, franchiseId: number, weeks: OptimalLineupWeekInput[]): OptimalLineupSeasonResult {
  const playable = weeks.filter((w): w is OptimalLineupWeekInput & { opponentFranchiseId: number; opponentScore: number } => w.opponentFranchiseId !== null && w.opponentScore !== null);

  if (playable.length === 0) {
    return { season, franchiseId, available: false, unavailableReason: NO_DECIDED_LINEUP_GAMES_REASON, record: null };
  }

  if (playable.some((w) => w.optimalScore === null)) {
    return { season, franchiseId, available: false, unavailableReason: PRE_OPTIMAL_LINEUP_DATA_REASON, record: null };
  }

  const seasonWeeks: WhatIfSeasonWeek[] = playable.map((w) => {
    const ownScore = Math.max(w.actualScore ?? w.optimalScore!, w.optimalScore!);
    return {
      week: w.week,
      ownScore,
      opponentFranchiseId: w.opponentFranchiseId,
      opponentScore: w.opponentScore,
      result: decide(ownScore, w.opponentScore),
    };
  });

  return { season, franchiseId, available: true, unavailableReason: null, record: summarize(seasonWeeks) };
}

// ---------------------------------------------------------------------------
// Typed public adapter
// ---------------------------------------------------------------------------

export type WhatIfScenarioInput =
  | {
      mode: "schedule-swap";
      season: number;
      franchiseAId: number;
      weeksA: WhatIfWeekInput[];
      franchiseBId: number;
      weeksB: WhatIfWeekInput[];
    }
  | {
      mode: "best-worst";
      season: number;
      franchiseId: number;
      ownWeeks: WhatIfWeekInput[];
      otherFranchises: { franchiseId: number; weeks: WhatIfWeekInput[] }[];
      expectedFranchiseIds: readonly number[];
    }
  | {
      mode: "perfect-lineup";
      season: number;
      franchiseId: number;
      weeks: OptimalLineupWeekInput[];
    };

export interface WhatIfScenarioEnvelope<T> {
  available: boolean;
  unavailableReason: string | null;
  result: T | null;
}

type ScheduleSwapScenario = Extract<WhatIfScenarioInput, { mode: "schedule-swap" }>;
type BestWorstScenario = Extract<WhatIfScenarioInput, { mode: "best-worst" }>;
type PerfectLineupScenario = Extract<WhatIfScenarioInput, { mode: "perfect-lineup" }>;

export function runWhatIfScenario(input: ScheduleSwapScenario): WhatIfScenarioEnvelope<ScheduleSwapResult>;
export function runWhatIfScenario(input: BestWorstScenario): WhatIfScenarioEnvelope<BestWorstScheduleResult>;
export function runWhatIfScenario(input: PerfectLineupScenario): WhatIfScenarioEnvelope<OptimalLineupSeasonResult>;
export function runWhatIfScenario(
  input: WhatIfScenarioInput,
): WhatIfScenarioEnvelope<ScheduleSwapResult | BestWorstScheduleResult | OptimalLineupSeasonResult> {
  if (input.mode === "schedule-swap") {
    const coverage = validateWhatIfScheduleCoverage([
      { franchiseId: input.franchiseAId, weeks: input.weeksA },
      { franchiseId: input.franchiseBId, weeks: input.weeksB },
    ]);
    if (!coverage.available) {
      return { available: false, unavailableReason: coverage.unavailableReason, result: null };
    }
    return {
      available: true,
      unavailableReason: null,
      result: scheduleSwap(input.season, input.franchiseAId, input.weeksA, input.franchiseBId, input.weeksB),
    };
  }

  if (input.mode === "best-worst") {
    const coverage = validateWhatIfScheduleCoverage(
      [{ franchiseId: input.franchiseId, weeks: input.ownWeeks }, ...input.otherFranchises],
      true,
      input.expectedFranchiseIds,
    );
    if (!coverage.available) {
      return { available: false, unavailableReason: coverage.unavailableReason, result: null };
    }
    const result = bestWorstSchedule(input.season, input.franchiseId, input.ownWeeks, input.otherFranchises);
    return { available: result.available, unavailableReason: result.unavailableReason, result };
  }

  const result = optimalLineupSeason(input.season, input.franchiseId, input.weeks);
  return result.available
    ? { available: true, unavailableReason: null, result }
    : { available: false, unavailableReason: result.unavailableReason, result: null };
}
