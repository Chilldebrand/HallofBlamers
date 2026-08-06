import { and, eq } from "drizzle-orm";
import {
  bestWorstSchedule,
  optimalLineupSeason,
  scheduleSwap,
  validateWhatIfScheduleCoverage,
  type BestWorstScheduleResult,
  type OptimalLineupSeasonResult,
  type OptimalLineupWeekInput,
  type ScheduleSwapResult,
  type WhatIfWeekInput,
} from "@/engines/whatIf";
import type { Db } from "../db/client";
import { getDb } from "../db/client";
import { franchises, teamSeasons, teamWeek } from "../db/schema";
import { getDefaultStandingsSeason, getSeasonOptions as loadSeasonOptions, type SeasonOption } from "./standings";

export type {
  BestWorstScheduleEntry,
  BestWorstScheduleResult,
  OptimalLineupSeasonResult,
  ScheduleSwapFranchiseResult,
  ScheduleSwapResult,
  WhatIfSeasonRecord,
  WhatIfSeasonWeek,
} from "@/engines/whatIf";
export { HEAD_TO_HEAD_WEEK_RULE, PRE_OPTIMAL_LINEUP_DATA_REASON } from "@/engines/whatIf";

// ---------------------------------------------------------------------------
// Season picker — reuses Standings' season list/default (Task 29 precedent);
// What-If has no "career" scope, so `SeasonOption` is used directly.
// ---------------------------------------------------------------------------

export { getSeasonOptions, getDefaultStandingsSeason as getDefaultWhatIfSeason } from "./standings";

// ---------------------------------------------------------------------------
// Franchise picker, scoped to a single season (only franchises that actually
// fielded a team that season — a departed/not-yet-joined franchise can't be
// picked for a season it didn't play).
// ---------------------------------------------------------------------------

export interface WhatIfFranchiseOption {
  id: number;
  name: string;
}

export function getWhatIfFranchiseOptions(season: number): WhatIfFranchiseOption[] {
  const db = getDb();
  const rows = db
    .select({ id: franchises.id, name: franchises.canonicalName })
    .from(teamSeasons)
    .innerJoin(franchises, eq(teamSeasons.franchiseId, franchises.id))
    .where(eq(teamSeasons.season, season))
    .all();
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// URL-param parsing — pure, exported, unit-testable without a DB. Same
// defensive-fallback shape as resolveStandingsScope/resolveStandingsTab
// (src/server/queries/standings.ts, Task 29 precedent): garbage or missing
// input never 404s, it falls back to a sane default.
// ---------------------------------------------------------------------------

export type WhatIfMode = "swap" | "bestworst" | "lineup";

export function resolveWhatIfMode(raw: string | undefined): WhatIfMode {
  if (raw === "bestworst" || raw === "lineup") return raw;
  return "swap";
}

export function resolveWhatIfSeason(raw: string | undefined, seasonOptions: SeasonOption[], defaultSeason: number): number {
  const n = Number(raw);
  return seasonOptions.some((s) => s.season === n) ? n : defaultSeason;
}

/** Falls back to `fallbackId` when `raw` doesn't parse to an id present in `options`. */
export function resolveWhatIfFranchise(raw: string | undefined, options: WhatIfFranchiseOption[], fallbackId: number): number {
  const n = Number(raw);
  return options.some((o) => o.id === n) ? n : fallbackId;
}

export interface WhatIfFranchisePair {
  franchiseAId: number;
  franchiseBId: number;
}

/**
 * Resolves BOTH sides of the Schedule Swap picker together because they can't be validated
 * independently: A and B must land on two DIFFERENT franchises from the same season's option
 * list. Each side first falls back individually via `resolveWhatIfFranchise` (season's first two
 * options, by name, as defaults); if the two resolved ids still collide — `?franchiseA=5&franchiseB=5`,
 * or a season the same single id defaults into on both sides — B is bumped to the next option
 * after A (wrapping around) rather than silently letting a franchise "play itself." Returns
 * `-1`/`-1` only when the season has no franchises at all (defensive; never happens for a season
 * that reached this page, since the page itself only lists seasons with options).
 */
export function resolveWhatIfFranchisePair(rawA: string | undefined, rawB: string | undefined, options: WhatIfFranchiseOption[]): WhatIfFranchisePair {
  if (options.length === 0) return { franchiseAId: -1, franchiseBId: -1 };
  const fallbackA = options[0]!.id;
  const fallbackB = options.length > 1 ? options[1]!.id : options[0]!.id;

  const franchiseAId = resolveWhatIfFranchise(rawA, options, fallbackA);
  let franchiseBId = resolveWhatIfFranchise(rawB, options, fallbackB);

  if (franchiseBId === franchiseAId) {
    const idx = options.findIndex((o) => o.id === franchiseAId);
    franchiseBId = options[(idx + 1) % options.length]!.id;
  }

  return { franchiseAId, franchiseBId };
}

// ---------------------------------------------------------------------------
// Shared row loading — team_week -> engine input translation. Isolated here
// so the "which weeks are honestly usable" decision is made in exactly one
// place for every mode.
// ---------------------------------------------------------------------------

interface RawTeamWeekRow {
  week: number;
  franchiseId: number;
  opponentFranchiseId: number | null;
  score: number;
  result: "W" | "L" | "T" | null;
}

/**
 * Excludes a not-yet-played/undecided matchup (ESPN's `0.0`/`winner: 'UNDECIDED'` sentinel for a
 * future week of an active season — see the espn-fantasy-data skill) — `result` is null there for
 * a DISHONEST reason. A genuine bye also has `result === null`, but for an honest reason
 * (`opponentFranchiseId === null`, nothing to decide), so it's kept.
 */
function isUsableRow(r: Pick<RawTeamWeekRow, "result" | "opponentFranchiseId">): boolean {
  return r.result !== null || r.opponentFranchiseId === null;
}

/** franchiseId:week -> that franchise's real score that week, from the same filtered row set. */
function buildScoreIndex(rows: RawTeamWeekRow[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const r of rows) index.set(`${r.franchiseId}:${r.week}`, r.score);
  return index;
}

/**
 * Resolves `r`'s opponent + opponent's real score for that week, or "no game" if either side of
 * the pairing didn't survive `isUsableRow` — defensive: in real data both team_week rows for one
 * matchup are written in the same normalize/stats-build pass and can't disagree, but this keeps
 * the WhatIfWeekInput contract (opponentScore null iff opponentFranchiseId null) honest even if
 * they ever did.
 */
function resolveOpponent(r: RawTeamWeekRow, scoreIndex: Map<string, number>): { opponentFranchiseId: number | null; opponentScore: number | null } {
  if (r.opponentFranchiseId === null) return { opponentFranchiseId: null, opponentScore: null };
  const opponentScore = scoreIndex.get(`${r.opponentFranchiseId}:${r.week}`);
  if (opponentScore === undefined) return { opponentFranchiseId: null, opponentScore: null };
  return { opponentFranchiseId: r.opponentFranchiseId, opponentScore };
}

function loadRegularSeasonRows(db: Db, season: number): RawTeamWeekRow[] {
  const rows = db
    .select({
      week: teamWeek.week,
      franchiseId: teamWeek.franchiseId,
      opponentFranchiseId: teamWeek.opponentFranchiseId,
      score: teamWeek.score,
      result: teamWeek.result,
    })
    .from(teamWeek)
    .where(and(eq(teamWeek.season, season), eq(teamWeek.weekType, "regular")))
    .all();
  return rows.filter(isUsableRow);
}

/** Regular-season-only weekly inputs, keyed by franchise — feeds Schedule Swap and
 * Best/Worst Schedule (see src/engines/whatIf.ts's module docstring for why those two modes are
 * scoped to the regular season: playoff pairings are seeded, not a fixed schedule). */
interface RegularSeasonWeekInputs {
  byFranchise: Map<number, WhatIfWeekInput[]>;
  coverage: ReturnType<typeof validateWhatIfScheduleCoverage>;
}

function buildRegularSeasonWeekInputs(season: number): RegularSeasonWeekInputs {
  const db = getDb();
  const rows = loadRegularSeasonRows(db, season);
  const scoreIndex = buildScoreIndex(rows);

  const byFranchise = new Map<number, WhatIfWeekInput[]>();
  for (const r of rows) {
    const { opponentFranchiseId, opponentScore } = resolveOpponent(r, scoreIndex);
    const list = byFranchise.get(r.franchiseId) ?? [];
    list.push({ week: r.week, ownScore: r.score, opponentFranchiseId, opponentScore });
    byFranchise.set(r.franchiseId, list);
  }
  const expectedFranchiseIds = db
    .select({ franchiseId: teamSeasons.franchiseId })
    .from(teamSeasons)
    .where(eq(teamSeasons.season, season))
    .all()
    .map((row) => row.franchiseId);
  const coverage = validateWhatIfScheduleCoverage(
    [...byFranchise.entries()].map(([franchiseId, weeks]) => ({ franchiseId, weeks })),
    true,
    expectedFranchiseIds,
  );
  return { byFranchise, coverage };
}

// ---------------------------------------------------------------------------
// Mode 1: Schedule Swap
// ---------------------------------------------------------------------------

/** Null when either franchise has no regular-season team_week rows for this season (shouldn't
 * happen once the picker only offers season-scoped options, but stays honest rather than crash). */
export function getScheduleSwapResult(season: number, franchiseAId: number, franchiseBId: number): ScheduleSwapResult | null {
  const { byFranchise, coverage } = buildRegularSeasonWeekInputs(season);
  if (!coverage.available) return null;
  const weeksA = byFranchise.get(franchiseAId);
  const weeksB = byFranchise.get(franchiseBId);
  if (!weeksA || !weeksB) return null;
  return scheduleSwap(season, franchiseAId, weeksA, franchiseBId, weeksB);
}

// ---------------------------------------------------------------------------
// Mode 2: Best/Worst Schedule
// ---------------------------------------------------------------------------

export function getBestWorstScheduleResult(season: number, franchiseId: number): BestWorstScheduleResult | null {
  const { byFranchise, coverage } = buildRegularSeasonWeekInputs(season);
  if (!coverage.available) return null;
  const ownWeeks = byFranchise.get(franchiseId);
  if (!ownWeeks) return null;

  const otherFranchises = [...byFranchise.entries()]
    .filter(([id]) => id !== franchiseId)
    .map(([id, weeks]) => ({ franchiseId: id, weeks }));

  return bestWorstSchedule(season, franchiseId, ownWeeks, otherFranchises);
}

// ---------------------------------------------------------------------------
// Mode 3: Perfect Lineups — every decided week (regular + playoff), since this mode never
// touches who the opponent was.
// ---------------------------------------------------------------------------

interface RawOptimalRow extends RawTeamWeekRow {
  optimalScore: number | null;
}

/** Null when the franchise has no decided team_week rows for this season at all. */
export function getOptimalLineupSeasonResult(season: number, franchiseId: number): OptimalLineupSeasonResult | null {
  const db = getDb();
  const rows: RawOptimalRow[] = db
    .select({
      week: teamWeek.week,
      franchiseId: teamWeek.franchiseId,
      opponentFranchiseId: teamWeek.opponentFranchiseId,
      score: teamWeek.score,
      optimalScore: teamWeek.optimalScore,
      result: teamWeek.result,
    })
    .from(teamWeek)
    .where(eq(teamWeek.season, season))
    .all()
    .filter(isUsableRow);

  const scoreIndex = buildScoreIndex(rows);
  const own = rows.filter((r) => r.franchiseId === franchiseId);
  if (own.length === 0) return null;

  const weeks: OptimalLineupWeekInput[] = own.map((r) => {
    const { opponentFranchiseId, opponentScore } = resolveOpponent(r, scoreIndex);
    return { week: r.week, actualScore: r.score, optimalScore: r.optimalScore, opponentFranchiseId, opponentScore };
  });

  return optimalLineupSeason(season, franchiseId, weeks);
}

// ---------------------------------------------------------------------------
// Page model adapter
// ---------------------------------------------------------------------------

export interface WhatIfPageParams {
  mode?: string;
  season?: string;
  franchiseA?: string;
  franchiseB?: string;
  franchise?: string;
}

export type WhatIfPageResult =
  | { kind: "schedule-swap"; value: ScheduleSwapResult }
  | { kind: "best-worst"; value: BestWorstScheduleResult }
  | { kind: "perfect-lineup"; value: OptimalLineupSeasonResult };

export interface WhatIfPageData {
  available: boolean;
  unavailableReason: string | null;
  mode: WhatIfMode;
  season: number | null;
  seasonOptions: SeasonOption[];
  franchiseOptions: WhatIfFranchiseOption[];
  result: WhatIfPageResult | null;
}

/** Validates every URL control server-side and returns only read models from archived data. */
export function getWhatIfPageData(params: WhatIfPageParams): WhatIfPageData {
  const seasonOptions = loadSeasonOptions();
  const mode = resolveWhatIfMode(params.mode);
  if (seasonOptions.length === 0) {
    return {
      available: false,
      unavailableReason: "No archived seasons are available.",
      mode,
      season: null,
      seasonOptions,
      franchiseOptions: [],
      result: null,
    };
  }

  const defaultSeason = getDefaultStandingsSeason() ?? seasonOptions[0]!.season;
  const season = resolveWhatIfSeason(params.season, seasonOptions, defaultSeason);
  const franchiseOptions = getWhatIfFranchiseOptions(season);
  if (franchiseOptions.length === 0) {
    return {
      available: false,
      unavailableReason: `No franchise schedule data is available for ${season}.`,
      mode,
      season,
      seasonOptions,
      franchiseOptions,
      result: null,
    };
  }

  if (mode === "swap") {
    const scheduleCoverage = buildRegularSeasonWeekInputs(season).coverage;
    if (!scheduleCoverage.available) {
      return {
        available: false,
        unavailableReason: scheduleCoverage.unavailableReason,
        mode,
        season,
        seasonOptions,
        franchiseOptions,
        result: null,
      };
    }
    const pair = resolveWhatIfFranchisePair(params.franchiseA, params.franchiseB, franchiseOptions);
    const value = getScheduleSwapResult(season, pair.franchiseAId, pair.franchiseBId);
    return {
      available: value !== null,
      unavailableReason: value ? null : "Both franchises need archived schedule data for this season.",
      mode,
      season,
      seasonOptions,
      franchiseOptions,
      result: value ? { kind: "schedule-swap", value } : null,
    };
  }

  const franchiseId = resolveWhatIfFranchise(params.franchise, franchiseOptions, franchiseOptions[0]!.id);
  if (mode === "bestworst") {
    const value = getBestWorstScheduleResult(season, franchiseId);
    return {
      available: value?.available ?? false,
      unavailableReason: value?.unavailableReason ?? "No comparison schedules are available for this season.",
      mode,
      season,
      seasonOptions,
      franchiseOptions,
      result: value ? { kind: "best-worst", value } : null,
    };
  }

  const value = getOptimalLineupSeasonResult(season, franchiseId);
  return {
    available: value?.available ?? false,
    unavailableReason: value?.unavailableReason ?? "No archived lineup data is available for this franchise and season.",
    mode,
    season,
    seasonOptions,
    franchiseOptions,
    result: value ? { kind: "perfect-lineup", value } : null,
  };
}
