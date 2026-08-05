/**
 * Weekly Pick'em lock + "The Algorithm" AI-pick computation (Task 31). Called from `run-tier.ts`'s
 * hourly tier tick — same wiring shape as `lineup-holes.ts` (a modular function invoked from the
 * tier's own try/catch block, never crashing the tick, idempotent by construction so a re-run
 * against unchanged state is always a safe no-op).
 *
 * LOCK SEMANTICS (brief: "all picks for a week lock at the week's first live window open —
 * Thursday 20:00 ET of that week"): once a week's picks lock, they MUST STAY locked until that
 * week stops being the current pick'em week (`computeCurrentPickemWeek` rolls over to the next
 * one) — never re-open mid-week just because a few days of wall-clock time passed. `isPickemLocked`
 * combines three signals, always gated by `isSeasonUnderway`:
 *
 *   1. `isSeasonUnderway(db, season)` (imported from `run-tier.ts`, unchanged) — is the season
 *      actually past kickoff (ESPN's own `status.latestScoringPeriod` >= 1)? Preseason is NEVER
 *      locked, full stop, regardless of day-of-week or scores — verified against the real 2026 DB
 *      state (84 scheduled matchups, `latestScoringPeriod` 0) on a scratch copy. This gates BOTH
 *      terms below; neither can lock anything while the season hasn't started.
 *   2. `isThursdayLockPassed(now)` — a PURE, wall-clock-only floor (America/New_York): is `now` on
 *      Thursday at/after 20:00, or Friday/Saturday/Sunday? This is the WALL-CLOCK FLOOR ONLY — by
 *      itself it is a recurring weekly pattern with NO memory of which specific week it's locking,
 *      so on its own it is `false` every Monday/Tuesday/Wednesday, INCLUDING Mon/Tue/Wed of the
 *      SAME week that just played over the weekend (a week routinely doesn't finish going final
 *      until Tuesday — see `computeCurrentPickemWeek`'s docstring). Term 3 below is what actually
 *      holds the lock through that gap.
 *   3. `hasAnyGameBegun` (`src/engines/pickem.ts`, fix round 1) — the DATA-DRIVEN floor: has ANY
 *      matchup in the current week actually started (final, or a real nonzero score)? Real ESPN
 *      scores never reset back to zero once a game has begun (see the espn-fantasy-data skill's
 *      sentinel table: an untouched matchup is `0.0`/`UNDECIDED`), so this term stays `true`
 *      through the ENTIRE Mon-Wed gap once Thursday's game has kicked off, and only reads `false`
 *      again once `computeCurrentPickemWeek` has actually rolled over to the NEXT (untouched, all-
 *      zero) week — which is exactly the "reopens picking for the new week" behavior this feature
 *      needs. `isPickemLocked` is `isSeasonUnderway && (isThursdayLockPassed(now) ||
 *      hasAnyGameBegun(...))` — the wall-clock term is the FLOOR that locks a week even before any
 *      score exists yet (right at Thursday 20:00 kickoff), the data term is what HOLDS the lock
 *      once real results start arriving, regardless of how many days have passed since.
 *
 * FIX ROUND 1 (reviewer-flagged Critical): the ORIGINAL implementation used `isThursdayLockPassed`
 * alone as the entire lock check (no term 3) — reproducibly wrong: any Monday/Tuesday/Wednesday
 * while the just-played week was STILL current (the normal case, not an edge case — see above)
 * read as unlocked, letting managers edit picks with full knowledge of Thursday/Sunday/Monday
 * results. The data-driven `hasAnyGameBegun` term closes this; see `src/engines/pickem.ts`'s
 * docstring for the pure decision itself.
 *
 * `isThursdayLockPassed`'s own Intl-based day/minute check is duplicated (not imported) from
 * `live-window.ts` — Task 31's brief scopes this task's ONE shared-file touch to `nav-items.ts`, so
 * `live-window.ts` itself is left untouched; this file only reads its already-exported
 * `LIVE_WINDOWS`/`LIVE_WINDOW_TIMEZONE` constants (read-only) to derive the Thursday-20:00
 * threshold, so the two stay in sync automatically if that window's start time ever changes.
 */
import { and, eq, isNull } from "drizzle-orm";
import { computeAlgorithmPicks, hasAnyGameBegun, type AlgorithmPickMatchupInput } from "../../engines";
import type { Db } from "../db/client";
import { appSettings, eloHistory, pickemPicks } from "../db/schema";
import { getCurrentPickemWeek, getPickemMatchupRows } from "../queries/pickem";
import { isSeasonUnderway } from "./run-tier";
import { LIVE_WINDOW_TIMEZONE, LIVE_WINDOWS } from "./live-window";

/** The season Task 31 shipped in — same fixed-epoch scoping rule as emit-events.ts's
 * EMISSION_MIN_SEASON: pick'em is a new, forward-looking feature with no historical picks to
 * backfill, so this guard keeps its behavior identical regardless of when it happens to run. */
export const PICKEM_MIN_SEASON = 2026;

/** `app_settings` key for the commissioner's "AI Picks" toggle — single source of truth, read by
 * both this worker module and src/features/pickem (web reads + the toggle action). */
export const PICKEM_AI_ENABLED_KEY = "pickem_ai_enabled";

/** True iff the commissioner has enabled "The Algorithm" (default false — opt-in). */
export function getPickemAiEnabled(db: Db): boolean {
  const row = db.select({ valueJson: appSettings.valueJson }).from(appSettings).where(eq(appSettings.key, PICKEM_AI_ENABLED_KEY)).get();
  return row?.valueJson === true;
}

// ---------------------------------------------------------------------------
// Term 2 (wall-clock floor) — pure Thursday-20:00-ET check. Term 3 (data-driven floor,
// hasAnyGameBegun) lives in src/engines/pickem.ts; term 1 (isSeasonUnderway) is imported below.
// ---------------------------------------------------------------------------

const THURSDAY_WINDOW = LIVE_WINDOWS.find((w) => w.dayOfWeek === 4);
if (!THURSDAY_WINDOW) {
  throw new Error("pickem-lock: LIVE_WINDOWS has no Thursday entry to derive the lock threshold from.");
}
/** 20:00 ET, read from live-window.ts's own Thursday window rather than duplicated as a literal —
 * stays in sync automatically if that window's start time ever changes. */
const THURSDAY_LOCK_MINUTE_OF_DAY = THURSDAY_WINDOW.startMinuteOfDay;

/** Duplicated from live-window.ts's private helper of the same shape (see module docstring for
 * why this file doesn't import it instead) — Intl-based, so DST (America/New_York) is handled
 * correctly with no manual UTC-offset table. */
function localDayAndMinute(now: Date): { dayOfWeek: number; minuteOfDay: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LIVE_WINDOW_TIMEZONE,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);

  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dayOfWeek: WEEKDAY_INDEX[weekdayShort] ?? 0, minuteOfDay: hour * 60 + minute };
}

/**
 * The WALL-CLOCK FLOOR ONLY (fix round 1 — corrected from a previous, wrong docstring that claimed
 * this alone stayed true "through the following Wednesday 23:59," which the code never actually
 * did): true on Thursday at/after 20:00 ET, or on Friday/Saturday/Sunday; **false** on Monday,
 * Tuesday, and Wednesday — INCLUDING Mon/Tue/Wed of the same week whose games just played over the
 * weekend. This function has no memory of which specific week is "current" and no access to real
 * results, so by itself it is NOT sufficient to keep a week locked once it stops being Thu-Sun —
 * see `isPickemLocked` (which ORs this with the data-driven `hasAnyGameBegun` term) and the module
 * docstring for the full, corrected semantics. Pure — no DB. Exported for direct, fixture-driven
 * DST/boundary testing.
 */
export function isThursdayLockPassed(now: Date): boolean {
  const { dayOfWeek, minuteOfDay } = localDayAndMinute(now);
  if (dayOfWeek === 4) return minuteOfDay >= THURSDAY_LOCK_MINUTE_OF_DAY;
  return dayOfWeek === 5 || dayOfWeek === 6 || dayOfWeek === 0; // Fri, Sat, Sun
}

/**
 * The full, corrected lock check (fix round 1) — see module docstring for why each term exists.
 * `week` is now a required parameter: a lock decision is inherently PER (season, week) once the
 * data-driven term is involved (it reads that week's own matchup scores), not "whichever week
 * happens to be current right now" the way the original (broken, wall-clock-only) design
 * implicitly assumed.
 */
export function isPickemLocked(db: Db, season: number, week: number, now: Date): boolean {
  if (!isSeasonUnderway(db, season)) return false;
  if (isThursdayLockPassed(now)) return true;
  return hasAnyGameBegun(getPickemMatchupRows(db, season, week));
}

// ---------------------------------------------------------------------------
// Pre-lock Elo snapshot
// ---------------------------------------------------------------------------

/**
 * "The latest elo_history rows at lock time," defined exactly: for each franchise, its `eloPost`
 * (the rating AFTER that game, not `eloPre`) from the elo_history row with the greatest (season,
 * week) — i.e. its Elo entering whatever game it plays NEXT. Since elo_history only ever contains
 * rows for matchups `replay()` has actually chronologically processed (completed games), and the
 * CURRENT pick'em week's games haven't been played yet at lock time BY DEFINITION (lock fires the
 * instant that week's own Thursday window opens, before any result exists), the single global
 * "latest row per franchise" is automatically the correct pre-lock snapshot — no explicit
 * `< current week` filter is needed. A franchise with zero elo_history rows at all (never finished
 * a completed game) is simply ABSENT from the returned map; `computeAlgorithmPicks` defaults an
 * absent franchise to `ELO_START`, never fabricating a rating here.
 */
export function loadPreLockEloByFranchise(db: Db): Map<number, number> {
  const rows = db
    .select({ franchiseId: eloHistory.franchiseId, season: eloHistory.season, week: eloHistory.week, eloPost: eloHistory.eloPost })
    .from(eloHistory)
    .all();

  const latest = new Map<number, { season: number; week: number; eloPost: number }>();
  for (const r of rows) {
    const cur = latest.get(r.franchiseId);
    if (!cur || r.season > cur.season || (r.season === cur.season && r.week > cur.week)) {
      latest.set(r.franchiseId, { season: r.season, week: r.week, eloPost: r.eloPost });
    }
  }

  return new Map([...latest].map(([franchiseId, v]) => [franchiseId, v.eloPost]));
}

// ---------------------------------------------------------------------------
// Orchestration — called from run-tier.ts's hourly tier
// ---------------------------------------------------------------------------

export interface ComputeAlgorithmPicksResult {
  inserted: number;
  /** Non-null whenever nothing was computed this call — always a normal, expected outcome (not an
   * error), logged at info level by the caller. */
  skippedReason:
    | "pre-2026-epoch"
    | "ai-disabled"
    | "no-current-week"
    | "not-locked-yet"
    | "already-computed"
    | "no-pickable-matchups"
    | null;
}

/**
 * Computes and stores "The Algorithm"'s picks for the current pick'em week, exactly once, the
 * first hourly tick that observes the week as locked. Idempotent: if algorithm-authored rows
 * already exist for (season, week), this is a no-op — a re-run against unchanged state (e.g. the
 * next hourly tick, still within the same locked week) inserts nothing new. Never throws; the
 * caller (run-tier.ts) wraps this the same try/catch-and-log way it wraps `emitLineupHoleEvents`.
 */
export function computeAndStoreAlgorithmPicks(db: Db, season: number, now: Date = new Date()): ComputeAlgorithmPicksResult {
  if (season < PICKEM_MIN_SEASON) return { inserted: 0, skippedReason: "pre-2026-epoch" };
  if (!getPickemAiEnabled(db)) return { inserted: 0, skippedReason: "ai-disabled" };

  const current = getCurrentPickemWeek(db);
  if (!current || current.season !== season) return { inserted: 0, skippedReason: "no-current-week" };

  if (!isPickemLocked(db, current.season, current.week, now)) return { inserted: 0, skippedReason: "not-locked-yet" };

  const alreadyComputed = db
    .select({ id: pickemPicks.id })
    .from(pickemPicks)
    .where(and(eq(pickemPicks.season, current.season), eq(pickemPicks.week, current.week), eq(pickemPicks.isAlgorithm, true), isNull(pickemPicks.managerId)))
    .limit(1)
    .get();
  if (alreadyComputed) return { inserted: 0, skippedReason: "already-computed" };

  const pickableMatchups = getPickemMatchupRows(db, current.season, current.week);
  if (pickableMatchups.length === 0) return { inserted: 0, skippedReason: "no-pickable-matchups" };

  const eloByFranchiseId = loadPreLockEloByFranchise(db);
  const algorithmInputs: AlgorithmPickMatchupInput[] = pickableMatchups.map((m) => ({
    matchupId: m.matchupId,
    homeFranchiseId: m.homeFranchiseId,
    awayFranchiseId: m.awayFranchiseId,
  }));
  const picks = computeAlgorithmPicks(algorithmInputs, eloByFranchiseId);

  const result = db
    .insert(pickemPicks)
    .values(
      picks.map((p) => ({
        managerId: null,
        isAlgorithm: true,
        season: current.season,
        week: current.week,
        matchupId: p.matchupId,
        pickedFranchiseId: p.pickedFranchiseId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    // No `target` — the partial unique index (`pickem_picks_algorithm_matchup_unique`, WHERE
    // is_algorithm = 1) can't be named as an ON CONFLICT target the way a plain unique column can
    // (SQLite requires the ON CONFLICT clause's own WHERE to match a partial index's WHERE exactly
    // to use it as a target). Bare `ON CONFLICT DO NOTHING` catches a violation against ANY unique
    // constraint on this table regardless, which is exactly the defensive belt-and-suspenders this
    // needs — the `alreadyComputed` check above is the real idempotency guard; this is a second
    // line of defense against a hypothetical concurrent double-insert, not the primary mechanism.
    .onConflictDoNothing()
    .run();

  return { inserted: result.changes, skippedReason: null };
}
