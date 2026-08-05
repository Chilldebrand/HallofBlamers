/**
 * Weekly Pick'em (Task 31) — web-side reads. Thin wrappers over src/server/queries/pickem.ts (DB
 * rows, shared with the worker) + src/engines/pickem.ts (pure scoring/leaderboard), using the
 * getDb() singleton the way every other feature's queries.ts file does.
 */
import { inArray } from "drizzle-orm";
import {
  computeSeasonLeaderboard,
  computeWeeklyPoints,
  type PickemMatchupResult,
  type PickemPickInput,
  type WeeklyPointsRow,
} from "@/engines";
import { getDb } from "@/server/db/client";
import { managers } from "@/server/db/schema";
import {
  getCurrentPickemWeek,
  getManagerPicksForWeek,
  getPickemMatchupRows,
  getPickemMatchupRowsForSeason,
  getPicksForSeason,
  getPicksForWeek,
  type PickemMatchupRow,
  type PickemPickRow,
} from "@/server/queries/pickem";
import { getPickemAiEnabled, isPickemLocked } from "@/server/sync/pickem-lock";

/** "The Algorithm"'s one-line tagline (brief: "label it 'The Algorithm' with one line of edge") —
 * defined once here so the toggle section and any future surface stay in sync verbatim. */
export const ALGORITHM_TAGLINE = "Picks by Elo. No homerism, no mercy, no excuses.";

export const ALGORITHM_ENTRANT_ID = "algorithm";

function entrantIdFor(row: { managerId: number | null; isAlgorithm: boolean }): string {
  return row.isAlgorithm ? ALGORITHM_ENTRANT_ID : `manager:${row.managerId}`;
}

// ---------------------------------------------------------------------------
// Current week + lock state
// ---------------------------------------------------------------------------

export interface PickemCurrentWeekState {
  season: number;
  week: number;
  locked: boolean;
}

/** The week /pickem features: pre-lock, its own form; post-lock, everyone's picks. Null means
 * nothing to pick right now (no season generated any weeks yet, or every generated week is
 * already fully final — offseason). */
export function getCurrentWeekState(now: Date = new Date()): PickemCurrentWeekState | null {
  const db = getDb();
  const current = getCurrentPickemWeek(db);
  if (!current) return null;
  return { season: current.season, week: current.week, locked: isPickemLocked(db, current.season, current.week, now) };
}

export function getAiEnabled(): boolean {
  return getPickemAiEnabled(getDb());
}

export function getPickableMatchups(season: number, week: number): PickemMatchupRow[] {
  return getPickemMatchupRows(getDb(), season, week);
}

/** matchupId -> pickedFranchiseId, for pre-filling/editing this manager's own picks. */
export function getMyPicksForWeek(season: number, week: number, managerId: number): Map<number, number> {
  return getManagerPicksForWeek(getDb(), season, week, managerId);
}

// ---------------------------------------------------------------------------
// Post-lock: everyone's picks for a week, with weekly points
// ---------------------------------------------------------------------------

export interface PickemEntrant {
  entrantId: string;
  displayName: string;
  /** Null for The Algorithm (no franchise) and for a manager with no franchise attached yet —
   * callers skip the FranchiseName identity treatment in either case. */
  franchiseId: number | null;
  isAlgorithm: boolean;
}

export interface PickemWeekGridRow {
  entrant: PickemEntrant;
  /** matchupId -> pickedFranchiseId. */
  picks: Map<number, number>;
  points: number;
}

function buildEntrants(pickRows: PickemPickRow[]): Map<string, PickemEntrant> {
  const db = getDb();
  const managerIds = [...new Set(pickRows.filter((r) => r.managerId !== null).map((r) => r.managerId!))];
  const managerRows =
    managerIds.length > 0
      ? db.select({ id: managers.id, name: managers.name, franchiseId: managers.franchiseId }).from(managers).where(inArray(managers.id, managerIds)).all()
      : [];
  const managerById = new Map(managerRows.map((m) => [m.id, m]));

  const entrants = new Map<string, PickemEntrant>();
  for (const row of pickRows) {
    const entrantId = entrantIdFor(row);
    if (entrants.has(entrantId)) continue;
    if (row.isAlgorithm) {
      entrants.set(entrantId, { entrantId, displayName: "The Algorithm", franchiseId: null, isAlgorithm: true });
    } else {
      const m = managerById.get(row.managerId!);
      entrants.set(entrantId, { entrantId, displayName: m?.name ?? `Manager ${row.managerId}`, franchiseId: m?.franchiseId ?? null, isAlgorithm: false });
    }
  }
  return entrants;
}

/**
 * Everyone's picks for ONE (season, week) — the post-lock "everyone's picks visible" view — plus
 * each entrant's points for that week (only-final scoring, computeWeeklyPoints). Sorted by points
 * desc, then display name, for a stable render order. Callers are responsible for only showing
 * this once the week is actually locked (getCurrentWeekState.locked) — this function itself has
 * no opinion on lock state, it just reads whatever picks already exist.
 */
export function getWeekGrid(season: number, week: number): { matchups: PickemMatchupRow[]; rows: PickemWeekGridRow[] } {
  const db = getDb();
  const matchupRows = getPickemMatchupRows(db, season, week);
  const pickRows = getPicksForWeek(db, season, week);
  const entrants = buildEntrants(pickRows);

  const picksByEntrant = new Map<string, Map<number, number>>();
  for (const row of pickRows) {
    const entrantId = entrantIdFor(row);
    const bucket = picksByEntrant.get(entrantId) ?? new Map<number, number>();
    bucket.set(row.matchupId, row.pickedFranchiseId);
    picksByEntrant.set(entrantId, bucket);
  }

  const results: PickemMatchupResult[] = matchupRows.map((m) => ({ matchupId: m.matchupId, isFinal: m.isFinal, winningFranchiseId: m.winningFranchiseId }));
  const pointsInput: PickemPickInput[] = pickRows.map((r) => ({ entrantId: entrantIdFor(r), matchupId: r.matchupId, pickedFranchiseId: r.pickedFranchiseId }));
  const pointsByEntrant = computeWeeklyPoints(pointsInput, results);

  const rows: PickemWeekGridRow[] = [...entrants.values()]
    .map((entrant) => ({ entrant, picks: picksByEntrant.get(entrant.entrantId) ?? new Map(), points: pointsByEntrant.get(entrant.entrantId) ?? 0 }))
    .sort((a, b) => b.points - a.points || a.entrant.displayName.localeCompare(b.entrant.displayName));

  return { matchups: matchupRows, rows };
}

// ---------------------------------------------------------------------------
// Season leaderboard
// ---------------------------------------------------------------------------

export interface PickemLeaderboardRow {
  entrant: PickemEntrant;
  totalPoints: number;
  weeksWon: number;
  rank: number;
}

/** Total points + weeks won + rank (ties share) across the WHOLE season so far. */
export function getSeasonLeaderboard(season: number): PickemLeaderboardRow[] {
  const db = getDb();
  const pickRows = getPicksForSeason(db, season);
  if (pickRows.length === 0) return [];

  const entrants = buildEntrants(pickRows);
  const matchupRows = getPickemMatchupRowsForSeason(db, season);
  const resultByMatchup = new Map(matchupRows.map((m) => [m.matchupId, m]));

  const picksByWeek = new Map<number, PickemPickRow[]>();
  for (const row of pickRows) {
    const list = picksByWeek.get(row.week);
    if (list) list.push(row);
    else picksByWeek.set(row.week, [row]);
  }

  const weeklyPointsRows: WeeklyPointsRow[] = [];
  for (const [week, rowsThisWeek] of picksByWeek) {
    const results: PickemMatchupResult[] = [...new Set(rowsThisWeek.map((r) => r.matchupId))]
      .map((matchupId) => resultByMatchup.get(matchupId))
      .filter((m): m is PickemMatchupRow => m !== undefined)
      .map((m) => ({ matchupId: m.matchupId, isFinal: m.isFinal, winningFranchiseId: m.winningFranchiseId }));
    const pointsInput: PickemPickInput[] = rowsThisWeek.map((r) => ({ entrantId: entrantIdFor(r), matchupId: r.matchupId, pickedFranchiseId: r.pickedFranchiseId }));
    const pointsByEntrant = computeWeeklyPoints(pointsInput, results);
    for (const [entrantId, points] of pointsByEntrant) {
      weeklyPointsRows.push({ entrantId, week, points });
    }
  }

  const leaderboard = computeSeasonLeaderboard(weeklyPointsRows);
  return leaderboard.map((row) => ({
    entrant: entrants.get(row.entrantId) ?? { entrantId: row.entrantId, displayName: row.entrantId, franchiseId: null, isAlgorithm: false },
    totalPoints: row.totalPoints,
    weeksWon: row.weeksWon,
    rank: row.rank,
  }));
}
