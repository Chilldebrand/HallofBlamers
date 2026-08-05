/**
 * Live/hourly/daily sync tiers (Tasks 15 + 25): current-season-only ESPN fetch ->
 * normalize -> stat build -> event emission, wired for the worker process.
 * Deliberately reuses `backfill.ts`'s request/store/politeness machinery
 * rather than reinventing it — the only real differences between tiers are
 * scope (exactly ONE season: the current one) and how many periods get
 * refetched:
 *
 *   - "hourly": season-scope snapshot, plus (only) whichever single period
 *     is currently in progress (`status.latestScoringPeriod`) — cheap,
 *     frequent, catches this week's score/roster movement.
 *   - "daily": season-scope snapshot, plus EVERY period 1..N — catches
 *     ESPN's retroactive stat corrections across the whole season. Heavier,
 *     so it runs once a day rather than hourly.
 *   - "live" (Task 25): fetches ONLY the current period's weekly combined
 *     view (`mBoxscore,mMatchupScore,mRoster`) — no season-scope, no
 *     transactions fetch, since neither meaningfully changes minute-to-
 *     minute during a live window and both are already kept fresh by the
 *     hourly tier (which always runs at least once before any live window
 *     opens — see `worker/index.ts`'s cron registrations). The current
 *     period is read from the latest ALREADY-ARCHIVED season-scope snapshot
 *     (no new HTTP request) — if none exists yet at all (a fresh DB with no
 *     hourly tick having run yet), the live tier logs a warning and skips
 *     the fetch for that tick, still running normalize/build/emission
 *     against whatever's already archived. See `worker/index.ts`'s `runLiveTick`
 *     (`isWithinLiveWindow` + `isSeasonUnderway` + `hasScheduledNonFinalMatchup`) for the full
 *     three-gate decision on when a "live" tick actually runs at all.
 *
 * Non-live tiers fetch their period list UNCONDITIONALLY (no `hasSnapshot`
 * pre-check like backfill.ts uses) — the whole point of a periodic sync tier
 * is re-polling data that may have changed since it was last archived, so
 * skipping a refetch because a snapshot already exists would defeat the
 * purpose. `storeSnapshot`'s own hash comparison already makes an unchanged
 * re-fetch cheap (no new archive row), just not a skipped HTTP request.
 *
 * Every tier then normalizes the season and runs a full stat rebuild — cheap
 * and always safe to rerun (see AGENTS.md: derived stats are a full rebuild
 * every time, never incremental; `runStatBuild` itself is digest-gated, so
 * an unchanged season's rebuild is skipped cheaply). Finally, `emit-events.ts`
 * diffs the resulting state into the `events` table (Task 25) — see that
 * module for the event set and idempotency rules.
 */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { matchups, syncRuns, type NewSyncRun } from "../db/schema";
import { determineScoringPeriodCount, type BackfillEspnClient } from "../espn/backfill";
import { EspnAuthError } from "../espn/client";
import type { EspnLogger, EspnView } from "../espn/types";
import { emitEvents } from "./emit-events";
import { SEASON_SCOPE_VIEW_KEY, TRANSACTIONS_VIEW_KEY, WEEK_SCOPE_VIEW_KEY } from "./espn-shapes";
import { emitLineupHoleEvents } from "./lineup-holes";
import { normalizeSeason, type NormalizeOptions, type NormalizeSummary } from "./normalize";
import { computeAndStoreAlgorithmPicks } from "./pickem-lock";
import { getLatestSnapshot, storeSnapshot, viewKey } from "./snapshots";
import { runStatBuild, type BuildResult } from "../stats/build";

// Derived by splitting the normalizer's own deterministic (sorted,
// comma-joined) view keys — guarantees the fetch plan always matches
// exactly what normalizeSeason expects to find archived, with no risk of
// the two lists drifting apart.
const SEASON_SCOPE_VIEWS = SEASON_SCOPE_VIEW_KEY.split(",") as EspnView[];
const PERIOD_VIEWS = WEEK_SCOPE_VIEW_KEY.split(",") as EspnView[];
const TRANSACTIONS_VIEWS = [TRANSACTIONS_VIEW_KEY] as EspnView[];

const SLEEP_BASE_MS = 2500;
const SLEEP_JITTER_MS = 500;

/** [2000, 3000) — same politeness window as backfill.ts. */
function nextSleepDelayMs(): number {
  return SLEEP_BASE_MS + (Math.random() * 2 - 1) * SLEEP_JITTER_MS;
}

/**
 * "manual" (Task 33 audit catch): a commissioner-triggered one-off from /admin's "Sync now"
 * button, tagged distinctly from an automatic tick in `sync_runs.tier` — see
 * `src/server/sync/manual-sync.ts`'s module docstring for the full request/poll design (the web
 * process only ever writes a request flag; the worker is still the one that calls this function).
 * Behaves exactly like "hourly" throughout this file (the fetch-plan/lineup-hole branches below
 * both treat it identically) — the ONLY difference is the `tier` value recorded on the row.
 */
export type SyncTierName = "hourly" | "daily" | "live" | "manual";

/**
 * DB half of the live tier's "has the season ENDED (or not populated at all yet)" gate — see
 * `live-window.ts`'s docstring for the wall-clock half, and `isSeasonUnderway` below for the
 * complementary "has the season STARTED" half. True iff the season has at least one non-final
 * matchup row at all. On its own this is NOT sufficient to detect "outside the season" — see
 * `isSeasonUnderway`'s docstring — but it's still the right (and only) signal for "the season
 * that already started is now fully complete," which `isSeasonUnderway` alone can't detect (ESPN
 * doesn't reset `status.latestScoringPeriod` back to 0 once a season ends).
 */
export function hasScheduledNonFinalMatchup(db: Db, season: number): boolean {
  const row = db
    .select({ id: matchups.id })
    .from(matchups)
    .where(and(eq(matchups.season, season), ne(matchups.isFinal, true)))
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * The complementary DB half of the live tier's gate: has the season actually STARTED (ESPN's own
 * `status.latestScoringPeriod` on the latest archived season-scope snapshot is >= 1, i.e. week 1
 * has genuinely kicked off) — NOT merely "the schedule has been generated."
 *
 * FIX ROUND 1 (reviewer finding): `hasScheduledNonFinalMatchup` alone is NOT sufficient to detect
 * "outside the season." Confirmed against real 2026 data: ESPN generates the full season's
 * matchup shells (84 rows, all non-final, real 0-0 scores) MONTHS before Week 1 actually kicks
 * off, so `hasScheduledNonFinalMatchup(2026)` was already `true` in August with `status.
 * latestScoringPeriod` still `0`. Without this check, every Thu/Sun/Mon night in the run-up to the
 * season would run a full live tick every 2 minutes for hours — no ESPN HTTP calls and no bad
 * data (the live tier's own fetch phase already no-ops when the latest period is 0), but real
 * needless `sync_runs`/normalize/build/emission churn, contradicting the brief's "outside:
 * inactive." `runLiveTick` requires BOTH this AND `hasScheduledNonFinalMatchup` to proceed.
 *
 * Returns `false` (never assumes "underway") when no season-scope snapshot has been archived yet
 * at all — there's nothing to derive "underway" from, so the safe default matches "inactive."
 */
export function isSeasonUnderway(db: Db, season: number): boolean {
  const snapshot = getLatestSnapshot(db, { season, view: viewKey(SEASON_SCOPE_VIEWS), scoringPeriod: null });
  if (!snapshot) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.payload);
  } catch {
    return false;
  }

  return determineLatestScoringPeriod(parsed) > 0;
}

/**
 * Task 20: the SAME "which period is currently in progress" signal `isSeasonUnderway` derives
 * internally, exposed so `lineup-holes.ts` can key its detection to the exact same week without a
 * second, potentially-divergent notion of "current." Returns `null` in every case
 * `isSeasonUnderway` would return `false` (no archived season-scope snapshot yet, unparseable
 * payload, or `latestScoringPeriod` still 0/preseason) — never a guessed period.
 */
export function getCurrentScoringPeriod(db: Db, season: number): number | null {
  const snapshot = getLatestSnapshot(db, { season, view: viewKey(SEASON_SCOPE_VIEWS), scoringPeriod: null });
  if (!snapshot) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.payload);
  } catch {
    return null;
  }

  const period = determineLatestScoringPeriod(parsed);
  return period > 0 ? period : null;
}

export interface SyncTierDeps {
  db: Db;
  client: BackfillEspnClient;
  /** Injected so tests can make this instant; production gets a real setTimeout-based sleep. */
  sleep: (ms: number) => Promise<void>;
  logger: EspnLogger;
}

export interface SyncTierOptions {
  tier: SyncTierName;
  season: number;
  /**
   * Passed straight through to `normalizeSeason`. Production (the worker)
   * always omits this, so normalize loads the real `seed/franchises.json` —
   * same default every other CLI in this repo uses. Tests inject a fixture
   * seed here instead of depending on that real file's contents.
   */
  normalizeOpts?: NormalizeOptions;
  /** Injected so tests can fixture the Thursday-lock boundary (Task 31's pick'em lock check);
   * production always omits this (real `new Date()`). See `pickem-lock.ts`. */
  now?: Date;
}

export interface SyncTierResult {
  syncRunId: number;
  status: "ok" | "partial" | "auth_failed";
  viewsFetched: number;
  snapshotsNew: number;
  /** Rows actually written to `events` this tick (post-dedupe) — 0 whenever normalize/build never
   * ran (auth failure) or nothing new was detected. See `emit-events.ts`. */
  eventsEmitted: number;
  errorText?: string;
  /** Null only when normalize/build never ran — i.e. this run hit an auth failure. */
  normalize: NormalizeSummary | null;
  statBuild: BuildResult | null;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

interface SeasonStatusShape {
  status?: { latestScoringPeriod?: unknown };
}

/**
 * Which period is currently in progress/most recently active, per ESPN's
 * own `status.latestScoringPeriod` — 0 before the season has kicked off
 * (nothing to fetch yet at the period level). Deliberately distinct from
 * `determineScoringPeriodCount` (backfill.ts), which answers "how many
 * periods will this season have in total" (from `finalScoringPeriod`, known
 * from day one) rather than "how far has it actually progressed."
 */
function determineLatestScoringPeriod(json: unknown): number {
  const obj = (json ?? {}) as SeasonStatusShape;
  const v = obj.status?.latestScoringPeriod;
  return isNonNegativeFiniteNumber(v) ? Math.trunc(v) : 0;
}

/**
 * NOTE the wording here is deliberate: `worker/index.ts` builds ONE `EspnClient` (with cookies
 * resolved once) at process startup and reuses it for every scheduled tick — see
 * `buildRealDeps()`. A later hourly/daily tick reuses that SAME client with the SAME (still
 * expired) cookies, so it will keep failing identically; only restarting the worker process
 * (which re-resolves credentials from scratch) picks up newly-updated ones. Saying "wait for the
 * next tick" here would be actively wrong, not just imprecise — see docs/RUNBOOK.md's "ESPN
 * credentials expired" entry, which already documents the real (restart-required) procedure this
 * message needs to match.
 */
function authErrorMessage(err: EspnAuthError, season: number, period?: number): string {
  const where = period !== undefined ? `season ${season} period ${period}` : `season ${season}`;
  return (
    `ESPN authentication failed while fetching ${where} (HTTP ${err.status}) during a sync tier run. ` +
    `Update cookies via ESPN_S2/ESPN_SWID env vars or the "espn_s2"/"swid" app_settings keys, then run ` +
    `./ops/deploy.sh to restart the worker and pick them up — a later scheduled tick will NOT retry with ` +
    `new credentials on its own, since the ESPN client is only built once at worker startup.`
  );
}

/**
 * Runs one hourly or daily sync tier tick for a single season. Records
 * exactly one `sync_runs` row (tier `"hourly"` or `"daily"`), moving it from
 * `running` to a terminal status when done — same lifecycle as
 * `runBackfill`. An `EspnAuthError` anywhere aborts the fetch loop
 * immediately (status `auth_failed`, normalize/build skipped entirely — no
 * point rebuilding from snapshots we already had before this run started).
 * Any other per-request error is logged, counted, and the loop continues
 * (ending `partial`), and normalize + stat build still run against whatever
 * got archived — always safe, since both are full, idempotent rebuilds.
 */
export async function runSyncTier(deps: SyncTierDeps, opts: SyncTierOptions): Promise<SyncTierResult> {
  const { db, client, sleep, logger } = deps;
  const { tier, season, normalizeOpts, now: tickNow } = opts;

  const runRow = db
    .insert(syncRuns)
    .values({ startedAt: new Date(), tier, status: "running" })
    .returning({ id: syncRuns.id })
    .get();

  let viewsFetched = 0;
  let snapshotsNew = 0;
  let failureCount = 0;
  let authFailureMessage: string | undefined;
  let requestCount = 0;

  async function fetchWithPoliteness(params: Parameters<BackfillEspnClient["fetchLeague"]>[0]) {
    if (requestCount > 0) {
      await sleep(nextSleepDelayMs());
    }
    requestCount++;
    return client.fetchLeague(params);
  }

  let seasonJson: unknown;

  fetchPhase: {
    if (tier === "live") {
      // No season-scope, no transactions fetch — see the module docstring for why. The current
      // period comes from the latest ALREADY-ARCHIVED season-scope snapshot (no new HTTP request).
      const latestSnapshot = getLatestSnapshot(db, { season, view: viewKey(SEASON_SCOPE_VIEWS), scoringPeriod: null });
      if (!latestSnapshot) {
        logger.warn(
          { tier, season },
          "sync tier: live tick has no archived season-scope snapshot to read the current period from yet " +
            "(an hourly/daily tick must run first) — skipping fetch this tick",
        );
        break fetchPhase;
      }

      let parsedSeasonJson: unknown;
      try {
        parsedSeasonJson = JSON.parse(latestSnapshot.payload);
      } catch (err) {
        failureCount++;
        logger.error({ tier, season, err: String(err) }, "sync tier: live tick could not parse the archived season-scope snapshot; skipping fetch this tick");
        break fetchPhase;
      }

      const latestPeriod = determineLatestScoringPeriod(parsedSeasonJson);
      if (latestPeriod === 0) {
        logger.info({ tier, season }, "sync tier: live tick found no in-progress period (preseason); nothing to fetch this tick");
        break fetchPhase;
      }

      try {
        const periodViews = [...PERIOD_VIEWS].sort() as EspnView[];
        const result = await fetchWithPoliteness({ season, views: periodViews, scoringPeriodId: latestPeriod });
        viewsFetched++;
        const stored = storeSnapshot(db, {
          season,
          scoringPeriod: latestPeriod,
          view: viewKey(PERIOD_VIEWS),
          url: result.url,
          httpStatus: result.status,
          payload: result.payload,
        });
        if (stored.inserted) snapshotsNew++;
      } catch (err) {
        if (err instanceof EspnAuthError) {
          authFailureMessage = authErrorMessage(err, season, latestPeriod);
          logger.error({ tier, season, period: latestPeriod, err: String(err) }, "sync tier: auth failure on live period fetch; aborting");
        } else {
          failureCount++;
          logger.error({ tier, season, period: latestPeriod, err: String(err) }, "sync tier: live period fetch failed");
        }
      }
      break fetchPhase;
    }

    try {
      const seasonViews = [...SEASON_SCOPE_VIEWS].sort() as EspnView[];
      const result = await fetchWithPoliteness({ season, views: seasonViews });
      seasonJson = result.json;
      viewsFetched++;
      const stored = storeSnapshot(db, {
        season,
        scoringPeriod: null,
        view: viewKey(seasonViews),
        url: result.url,
        httpStatus: result.status,
        payload: result.payload,
      });
      if (stored.inserted) snapshotsNew++;
      logger.info(
        { tier, season, inserted: stored.inserted },
        stored.inserted ? "sync tier: season-scope fetched, new snapshot" : "sync tier: season-scope fetched, unchanged",
      );
    } catch (err) {
      if (err instanceof EspnAuthError) {
        authFailureMessage = authErrorMessage(err, season);
        logger.error({ tier, season, err: String(err) }, "sync tier: auth failure on season-scope fetch; aborting");
      } else {
        failureCount++;
        logger.error({ tier, season, err: String(err) }, "sync tier: season-scope fetch failed; nothing else to fetch this tick");
      }
      break fetchPhase;
    }

    const periodViewKeyStr = viewKey(PERIOD_VIEWS);
    const txViewKeyStr = viewKey(TRANSACTIONS_VIEWS);

    const periods: number[] =
      tier === "daily"
        ? Array.from({ length: determineScoringPeriodCount(seasonJson, season, logger) }, (_, i) => i + 1)
        : (() => {
            const latest = determineLatestScoringPeriod(seasonJson);
            return latest > 0 ? [latest] : [];
          })();

    if ((tier === "hourly" || tier === "manual") && periods.length === 0) {
      logger.info({ tier, season }, "sync tier: no in-progress period yet (preseason) — season-scope only this tick");
    }

    // Deliberately UNCONDITIONAL — no `hasSnapshot` pre-check here (unlike backfill.ts). Both
    // tiers' whole reason to exist is re-polling data that may have changed since it was last
    // archived (an in-progress week's live score for "hourly"; retroactive corrections anywhere
    // in the season for "daily") — skipping a period because it already has SOME snapshot would
    // defeat that purpose. `periods` is already tiny by construction (1 item for hourly, one
    // season's worth for daily), so there's no backfill-style cost problem to avoid here.
    // `storeSnapshot`'s own hash comparison still means an unchanged payload costs a DB row scan,
    // not a wasted archive write.
    periodLoop: for (const period of periods) {
      try {
        const periodViews = [...PERIOD_VIEWS].sort() as EspnView[];
        const result = await fetchWithPoliteness({ season, views: periodViews, scoringPeriodId: period });
        viewsFetched++;
        const stored = storeSnapshot(db, {
          season,
          scoringPeriod: period,
          view: periodViewKeyStr,
          url: result.url,
          httpStatus: result.status,
          payload: result.payload,
        });
        if (stored.inserted) snapshotsNew++;
      } catch (err) {
        if (err instanceof EspnAuthError) {
          authFailureMessage = authErrorMessage(err, season, period);
          logger.error({ tier, season, period, err: String(err) }, "sync tier: auth failure on period fetch; aborting");
          break periodLoop;
        }
        failureCount++;
        logger.error({ tier, season, period, err: String(err) }, "sync tier: period fetch failed; continuing");
      }

      try {
        const transactionsViews = [...TRANSACTIONS_VIEWS];
        const result = await fetchWithPoliteness({ season, views: transactionsViews, scoringPeriodId: period });
        viewsFetched++;
        const stored = storeSnapshot(db, {
          season,
          scoringPeriod: period,
          view: txViewKeyStr,
          url: result.url,
          httpStatus: result.status,
          payload: result.payload,
        });
        if (stored.inserted) snapshotsNew++;
      } catch (err) {
        if (err instanceof EspnAuthError) {
          authFailureMessage = authErrorMessage(err, season, period);
          logger.error({ tier, season, period, err: String(err) }, "sync tier: auth failure on transactions fetch; aborting");
          break periodLoop;
        }
        failureCount++;
        logger.error({ tier, season, period, err: String(err) }, "sync tier: transactions fetch failed; continuing");
      }
    }
  }

  let normalizeSummary: NormalizeSummary | null = null;
  let statBuildResult: BuildResult | null = null;
  let eventsEmitted = 0;

  if (!authFailureMessage) {
    try {
      normalizeSummary = normalizeSeason(db, season, normalizeOpts);
      if (normalizeSummary.warnings.length > 0) {
        logger.warn({ tier, season, warnings: normalizeSummary.warnings }, "sync tier: normalize completed with warnings");
      }
    } catch (err) {
      failureCount++;
      logger.error({ tier, season, err: String(err) }, "sync tier: normalize threw unexpectedly");
    }

    try {
      statBuildResult = runStatBuild(db);
      if (statBuildResult.status === "failed") {
        failureCount++;
        logger.error({ tier, season, errorText: statBuildResult.errorText }, "sync tier: stat build failed");
      }
    } catch (err) {
      failureCount++;
      logger.error({ tier, season, err: String(err) }, "sync tier: stat build threw unexpectedly");
    }

    // Task 25: diff current state into `events`. Runs regardless of statBuildResult's status —
    // even a "skipped" (digest-unchanged) or "failed" build leaves the derived tables in the last
    // known-good, fully-consistent state (AGENTS.md: readers never see a half-built state), so
    // it's always safe to emit from whatever's there. A failure here is logged and counted like
    // any other step, never allowed to crash the tick.
    try {
      const emitResult = emitEvents(db, { season });
      eventsEmitted += emitResult.inserted;
      if (emitResult.inserted > 0) {
        logger.info({ tier, season, eventsEmitted: emitResult.inserted }, "sync tier: emitted new events");
      }
    } catch (err) {
      failureCount++;
      logger.error({ tier, season, err: String(err) }, "sync tier: event emission threw unexpectedly");
    }

    // Task 20: lineup-hole detection — hourly + live + manual tiers ONLY (daily's whole-season
    // retroactive sweep has no "before kickoff" meaning), and only once the season has actually
    // kicked off (`isSeasonUnderway` — the same gate the live tier's own game-window logic uses;
    // real 2026 data confirms this correctly produces nothing in preseason, where matchup shells
    // exist months before `latestScoringPeriod` leaves 0). `getCurrentScoringPeriod` reads the
    // SAME signal, so detection is always keyed to the exact week the rest of this tick just
    // fetched/rebuilt for. "manual" included (Task 33) so a commissioner's "Sync now" click also
    // refreshes the who's-not-set admin panel, matching the brief's "hourly-tier run... tier
    // 'manual'" framing — it's meant to behave like an hourly tick end to end, not a lighter one.
    if ((tier === "hourly" || tier === "live" || tier === "manual") && isSeasonUnderway(db, season)) {
      const week = getCurrentScoringPeriod(db, season);
      if (week !== null) {
        try {
          const holeResult = emitLineupHoleEvents(db, { season, week });
          eventsEmitted += holeResult.inserted;
          if (holeResult.inserted > 0) {
            logger.info({ tier, season, week, lineupHoleEventsEmitted: holeResult.inserted }, "sync tier: emitted lineup-hole events");
          }
        } catch (err) {
          failureCount++;
          logger.error({ tier, season, week, err: String(err) }, "sync tier: lineup-hole event emission threw unexpectedly");
        }
      }
    }

    // Task 31: "The Algorithm" AI-pick computation — hourly tier ONLY (extends it the same modular
    // way lineup-hole detection does above: a single function call, try/catch-and-log, never
    // crashing the tick). computeAndStoreAlgorithmPicks is fully self-gating (AI toggle, current
    // week resolution, the Thursday-lock + isSeasonUnderway check, and already-computed
    // idempotency all live inside it — see pickem-lock.ts) so there's no season/week precondition
    // to check here, unlike lineup-holes' isSeasonUnderway+getCurrentScoringPeriod guard above.
    if (tier === "hourly") {
      try {
        const pickemResult = computeAndStoreAlgorithmPicks(db, season, tickNow);
        if (pickemResult.inserted > 0) {
          logger.info({ tier, season, pickemPicksInserted: pickemResult.inserted }, "sync tier: computed and stored The Algorithm's pick'em picks");
        }
      } catch (err) {
        failureCount++;
        logger.error({ tier, season, err: String(err) }, "sync tier: pick'em algorithm-pick computation threw unexpectedly");
      }
    }
  }

  const status: SyncTierResult["status"] = authFailureMessage ? "auth_failed" : failureCount > 0 ? "partial" : "ok";
  const errorText =
    authFailureMessage ?? (failureCount > 0 ? `${failureCount} step(s) failed during the ${tier} sync tier; see logs.` : undefined);

  const updateValues: Partial<NewSyncRun> = { finishedAt: new Date(), status, viewsFetched, snapshotsNew, eventsEmitted };
  if (errorText !== undefined) updateValues.errorText = errorText;
  db.update(syncRuns).set(updateValues).where(eq(syncRuns.id, runRow.id)).run();

  return {
    syncRunId: runRow.id,
    status,
    viewsFetched,
    snapshotsNew,
    eventsEmitted,
    errorText,
    normalize: normalizeSummary,
    statBuild: statBuildResult,
  };
}
