/**
 * Worker process entry point (Task 15 + Task 25). Per AGENTS.md, the worker is the SOLE writer
 * of ESPN-derived data; it and the web process communicate only through the shared SQLite
 * database. `npm run worker` locally, or the `worker` service's command in docker-compose.yml
 * (same image as `web`, different command — see the Dockerfile/compose files).
 *
 * Runs migrations once at startup, then schedules croner jobs against the real `DATABASE_PATH`
 * database:
 *   - `hourly` sync tier  — current season, only the in-progress period.
 *   - `daily` sync tier   — current season, every period refetched (catches
 *     ESPN's retroactive corrections).
 *   - `live` sync tier    — current season, current period ONLY, every 2 minutes, but ONLY while
 *     ALL THREE gates in `runLiveTick` pass: `isWithinLiveWindow` (wall-clock: are we inside a
 *     named Thu/Sun/Mon game window, America/New_York), `isSeasonUnderway` (DB: has the season
 *     actually STARTED — ESPN's own `status.latestScoringPeriod` >= 1, not merely scheduled), and
 *     `hasScheduledNonFinalMatchup` (DB: has the season NOT already fully finished). Four separate
 *     `Cron` registrations below cover the three named windows (Sunday needs two, since its 12:55
 *     start isn't a whole-hour boundary) — see `src/server/sync/live-window.ts`'s `LIVE_WINDOWS`
 *     for the authoritative window definition these cron strings encode.
 *   - nightly backup      — 4:30am America/New_York, VACUUM INTO + 14-day
 *     retention (see src/server/db/backup.ts).
 *
 * `runHourlyTick`/`runDailyTick`/`runLiveTick`/`runNightlyBackupTick` are exported separately
 * from `main()` so a single tick can be triggered directly (e.g. for manual verification against
 * a scratch DB copy) without starting the long-running croner loop — `main()` itself is gated
 * behind `isMainModule()`, same convention as every other CLI entry in this repo (backfill.ts,
 * normalize-cli.ts, run-build.ts).
 *
 * FIX ROUND 1, finding 2 (symmetric run-in-flight guard): every tick entry point below —
 * `runHourlyTick`/`runDailyTick`/`runLiveTick`/`runManualSyncTick` — now checks
 * `isAnySyncRunning` (`src/server/sync/manual-sync.ts`) and skips (with a log line, no
 * `sync_runs` row) when some OTHER sync is already in flight, before calling `runSyncTier`.
 * Originally only the manual tier checked this, so an automatic hourly/daily/live tick could
 * start concurrently with an in-flight manual run — most likely during a live window, when a live
 * tick fires every 2 minutes. `main()` also runs `recoverStaleSyncRuns` once at startup (fix round
 * 1, finding 3) so a 'running' row abandoned by a crashed worker process doesn't linger with a
 * misleading status — see that function's docstring for why the guard itself doesn't actually
 * depend on this recovery pass ever running.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Database from "better-sqlite3";
import { Cron } from "croner";
import pino from "pino";
import { getDb, getSqlite, type Db } from "../src/server/db/client";
import { runBackup, type RunBackupResult } from "../src/server/db/backup";
import { runMigrations } from "../src/server/db/migrate";
import { EspnClient } from "../src/server/espn/client";
import type { BackfillEspnClient } from "../src/server/espn/backfill";
import type { EspnLogger } from "../src/server/espn/types";
import { getEspnCredentials, getLeagueId } from "../src/server/sync/credentials";
import { determineCurrentSeasonYear } from "../src/server/sync/current-season";
import { isWithinLiveWindow, LIVE_TIER_INTERVAL_SECONDS } from "../src/server/sync/live-window";
import { clearManualSyncRequest, getManualSyncRequestState, isAnySyncRunning, recoverStaleSyncRuns } from "../src/server/sync/manual-sync";
import { hasScheduledNonFinalMatchup, isSeasonUnderway, runSyncTier, type SyncTierName, type SyncTierResult } from "../src/server/sync/run-tier";

// ---------------------------------------------------------------------------
// Schedule constants — all times America/New_York (the league's home tz).
// ---------------------------------------------------------------------------

export const WORKER_TIMEZONE = "America/New_York";

/** Top of every hour. */
export const HOURLY_SYNC_CRON = "0 * * * *";
/** 9:00am ET daily — after any overnight ESPN stat corrections, well before that day's business. */
export const DAILY_SYNC_CRON = "0 9 * * *";
/** 4:30am ET nightly, per the brief. */
export const BACKUP_CRON = "30 4 * * *";
/**
 * Every minute (Task 33 audit catch) — polls for a commissioner-requested manual sync
 * (`src/server/sync/manual-sync.ts`). A tight interval is deliberate: the whole point of a
 * "Sync now" button is a fast response, and the poll itself is a single cheap `app_settings`
 * read (no ESPN traffic) whenever nothing is actually pending — see `runManualSyncTick`.
 */
export const MANUAL_SYNC_POLL_CRON = "* * * * *";

/**
 * Live tier (Task 25) — every 2 minutes during each named game window (`LIVE_WINDOWS` in
 * `live-window.ts` is the source of truth these four cron strings encode; `runLiveTick` ALSO
 * re-checks `isWithinLiveWindow` itself, so a cron/window-definition drift would only ever narrow
 * when ticks fire, never cause an out-of-window fetch). Standard 5-field cron (minute hour day
 * month day-of-week; day-of-week 0=Sunday). Sunday needs two registrations because its window
 * opens at :55 past noon, not a whole-hour boundary a single step-value/hour-range pattern can
 * express (i.e. an every-2-minutes-within-an-hour-range pattern, as used for the other windows).
 */
export const LIVE_SYNC_CRON_THURSDAY = "*/2 20-23 * * 4"; // Thu 20:00-23:58 ET
export const LIVE_SYNC_CRON_SUNDAY_EARLY = "55,57,59 12 * * 0"; // Sun 12:55-12:59 ET
export const LIVE_SYNC_CRON_SUNDAY = "*/2 13-23 * * 0"; // Sun 13:00-23:58 ET
export const LIVE_SYNC_CRON_MONDAY = "*/2 20-23 * * 1"; // Mon 20:00-23:58 ET

export const LIVE_SYNC_CRONS = [
  LIVE_SYNC_CRON_THURSDAY,
  LIVE_SYNC_CRON_SUNDAY_EARLY,
  LIVE_SYNC_CRON_SUNDAY,
  LIVE_SYNC_CRON_MONDAY,
] as const;

// ---------------------------------------------------------------------------
// Real dependencies (production only — tests inject their own).
// ---------------------------------------------------------------------------

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkerDeps {
  db: Db;
  client: BackfillEspnClient;
  sleep: (ms: number) => Promise<void>;
  logger: EspnLogger;
}

function buildRealDeps(logger: EspnLogger): WorkerDeps {
  const db = getDb();
  const leagueId = getLeagueId(db);
  const cookies = getEspnCredentials(db);
  const client = new EspnClient({ leagueId, cookies: cookies ?? undefined, logger });
  return { db, client, sleep: realSleep, logger };
}

// ---------------------------------------------------------------------------
// Individual ticks — directly callable (see module docstring: this is the
// "trigger one sync cycle function directly" hook for manual verification).
// ---------------------------------------------------------------------------

/** Logs a `SyncTierResult` without the (potentially large) normalize/build detail objects —
 * those already log their own warnings/errors from inside `runSyncTier`. */
function logTickSummary(logger: EspnLogger, tier: SyncTierName, season: number, result: SyncTierResult): void {
  logger.info(
    {
      tier,
      season,
      syncRunId: result.syncRunId,
      status: result.status,
      viewsFetched: result.viewsFetched,
      snapshotsNew: result.snapshotsNew,
      eventsEmitted: result.eventsEmitted,
      errorText: result.errorText,
    },
    `worker: ${tier} sync tick finished`,
  );
}

/** Runs one hourly sync tier tick against the current season. Returns `null` (no `sync_runs` row)
 * when another sync is already in flight — fix round 1, finding 2's symmetric guard. */
export async function runHourlyTick(deps: WorkerDeps, now: Date = new Date()): Promise<SyncTierResult | null> {
  if (isAnySyncRunning(deps.db, now)) {
    deps.logger.info({ tier: "hourly" }, "worker: another sync is already running; skipping this hourly tick");
    return null;
  }

  const season = determineCurrentSeasonYear(now);
  deps.logger.info({ tier: "hourly", season }, "worker: starting hourly sync tick");
  const result = await runSyncTier(deps, { tier: "hourly", season });
  logTickSummary(deps.logger, "hourly", season, result);
  return result;
}

/** Runs one daily sync tier tick against the current season. Returns `null` (no `sync_runs` row)
 * when another sync is already in flight — fix round 1, finding 2's symmetric guard. */
export async function runDailyTick(deps: WorkerDeps, now: Date = new Date()): Promise<SyncTierResult | null> {
  if (isAnySyncRunning(deps.db, now)) {
    deps.logger.info({ tier: "daily" }, "worker: another sync is already running; skipping this daily tick");
    return null;
  }

  const season = determineCurrentSeasonYear(now);
  deps.logger.info({ tier: "daily", season }, "worker: starting daily sync tick");
  const result = await runSyncTier(deps, { tier: "daily", season });
  logTickSummary(deps.logger, "daily", season, result);
  return result;
}

/**
 * Polls for a commissioner-requested manual sync (Task 33 audit catch — see
 * `src/server/sync/manual-sync.ts`'s module docstring for why this indirection exists instead of
 * the /admin Server Action calling `runSyncTier` itself). Returns `null` (and records no
 * `sync_runs` row) when nothing is pending, OR when some OTHER sync is already running — in the
 * latter case the request flag is deliberately left in place so the NEXT tick (one minute later,
 * `MANUAL_SYNC_POLL_CRON`) retries rather than silently dropping the commissioner's click.
 */
export async function runManualSyncTick(deps: WorkerDeps, now: Date = new Date()): Promise<SyncTierResult | null> {
  const state = getManualSyncRequestState(deps.db, now);
  if (state.requestedAt === null) return null;

  if (state.anySyncRunning) {
    deps.logger.info({ tier: "manual" }, "worker: manual sync requested but another sync is already running; leaving it queued for the next poll");
    return null;
  }

  const season = determineCurrentSeasonYear(now);
  deps.logger.info({ tier: "manual", season }, "worker: starting manual sync tick (commissioner-requested)");
  const result = await runSyncTier(deps, { tier: "manual", season });
  // Cleared AFTER the run finishes (not before) so a worker crash mid-run leaves the request
  // flag in place — the next poll retries rather than silently losing the commissioner's click.
  clearManualSyncRequest(deps.db);
  logTickSummary(deps.logger, "manual", season, result);
  return result;
}

/**
 * Runs one live sync tier tick, IF all three gates pass:
 *   1. `isWithinLiveWindow(now)` — wall-clock: are we inside a named Thu/Sun/Mon game window?
 *   2. `isSeasonUnderway(deps.db, season)` — DB: has the season actually STARTED (ESPN's own
 *      `status.latestScoringPeriod` >= 1), not merely scheduled? FIX ROUND 1: added after a
 *      reviewer confirmed real 2026 data has 84 non-final matchup rows (the full schedule,
 *      generated by ESPN months early) with `latestScoringPeriod` still 0 — without this gate,
 *      every game-window night in the run-up to the season would run a live tick for hours with
 *      nothing to do. See `run-tier.ts`'s `isSeasonUnderway` docstring for the full account.
 *   3. `hasScheduledNonFinalMatchup(deps.db, season)` — DB: has the season NOT already fully
 *      finished (still has at least one non-final matchup)? Catches the offseason AFTER a season
 *      ends, which gate 2 alone can't (ESPN doesn't reset `latestScoringPeriod` back to 0).
 *   4. `!isAnySyncRunning(deps.db, now)` — DB: is some OTHER sync (any tier) already in flight?
 *      (Fix round 1, finding 2 — the symmetric guard; checked last since it's the only gate that
 *      needs a DB round trip beyond gates 2/3, and there's no point paying for it when gates 1-3
 *      already say there's nothing to do.)
 * Returns `null` (and records NO `sync_runs` row at all) when any gate fails — "outside:
 * inactive" per the brief. Re-checking gate 1 here (rather than trusting the caller, i.e. croner,
 * to only ever invoke this inside a window) means a manual/test call is exercised through the
 * exact same logic a real scheduled tick uses, and a cron-string/window-definition drift would
 * only ever cause a MISSED tick, never a spurious out-of-window fetch.
 */
export async function runLiveTick(deps: WorkerDeps, now: Date = new Date()): Promise<SyncTierResult | null> {
  if (!isWithinLiveWindow(now)) {
    deps.logger.info({ tier: "live", now: now.toISOString() }, "worker: outside live window, skipping tick");
    return null;
  }

  const season = determineCurrentSeasonYear(now);

  if (!isSeasonUnderway(deps.db, season)) {
    deps.logger.info({ tier: "live", season }, "worker: season hasn't started yet (preseason — schedule generated but latestScoringPeriod is 0), skipping live tick");
    return null;
  }

  if (!hasScheduledNonFinalMatchup(deps.db, season)) {
    deps.logger.info({ tier: "live", season }, "worker: no scheduled non-final matchup this season (season complete), skipping live tick");
    return null;
  }

  if (isAnySyncRunning(deps.db, now)) {
    deps.logger.info({ tier: "live" }, "worker: another sync is already running; skipping this live tick");
    return null;
  }

  deps.logger.info({ tier: "live", season }, "worker: starting live sync tick");
  const result = await runSyncTier(deps, { tier: "live", season });
  logTickSummary(deps.logger, "live", season, result);
  return result;
}

export interface BackupDeps {
  getSqlite: () => Database.Database;
  backupDir: string;
  logger: EspnLogger;
}

/** Runs one nightly backup tick. */
export function runNightlyBackupTick(deps: BackupDeps, now: Date = new Date()): RunBackupResult {
  deps.logger.info({ backupDir: deps.backupDir }, "worker: starting nightly backup");
  const result = runBackup(deps.getSqlite(), deps.backupDir, now);
  deps.logger.info(result, "worker: nightly backup finished");
  return result;
}

// ---------------------------------------------------------------------------
// main() — real process wiring, gated so importing this module for its
// exports (tests, a manual verification script) never starts croner jobs.
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const logger: EspnLogger = pino();

  const db = getDb();
  runMigrations(db);
  logger.info({}, "worker: migrations applied, starting scheduled jobs");

  // Fix round 1, finding 3 — crash recovery, BEFORE any cron job is registered (so nothing can
  // race a genuinely-in-progress run against this one-time cleanup pass).
  const recovery = recoverStaleSyncRuns(db);
  if (recovery.recovered > 0) {
    logger.warn({ recovered: recovery.recovered }, "worker: marked stale 'running' sync_runs row(s) as failed during startup recovery");
  }

  const deps = buildRealDeps(logger);
  const dbPath = process.env.DATABASE_PATH ?? "./data/league.db";
  const backupDir = path.join(path.dirname(dbPath), "backups");

  new Cron(
    HOURLY_SYNC_CRON,
    { timezone: WORKER_TIMEZONE, protect: true, catch: (err) => logger.error({ err: String(err) }, "hourly tick threw") },
    async () => {
      await runHourlyTick(deps);
    },
  );

  new Cron(
    DAILY_SYNC_CRON,
    { timezone: WORKER_TIMEZONE, protect: true, catch: (err) => logger.error({ err: String(err) }, "daily tick threw") },
    async () => {
      await runDailyTick(deps);
    },
  );

  new Cron(
    MANUAL_SYNC_POLL_CRON,
    { timezone: WORKER_TIMEZONE, protect: true, catch: (err) => logger.error({ err: String(err) }, "manual sync poll threw") },
    async () => {
      await runManualSyncTick(deps);
    },
  );

  new Cron(
    BACKUP_CRON,
    { timezone: WORKER_TIMEZONE, protect: true, catch: (err) => logger.error({ err: String(err) }, "nightly backup tick threw") },
    () => {
      runNightlyBackupTick({ getSqlite, backupDir, logger });
    },
  );

  // Four registrations, one per LIVE_SYNC_CRONS entry (Sunday needs two — see that constant's
  // docstring). `protect: true` means an overlapping tick (shouldn't happen at a 2-minute cadence
  // given how fast a live tick runs, but defensively) is skipped rather than stacked.
  for (const cronExpr of LIVE_SYNC_CRONS) {
    new Cron(
      cronExpr,
      { timezone: WORKER_TIMEZONE, protect: true, catch: (err) => logger.error({ err: String(err), cron: cronExpr }, "live tick threw") },
      async () => {
        await runLiveTick(deps);
      },
    );
  }

  logger.info(
    {
      hourly: HOURLY_SYNC_CRON,
      daily: DAILY_SYNC_CRON,
      manualSyncPoll: MANUAL_SYNC_POLL_CRON,
      live: LIVE_SYNC_CRONS,
      liveIntervalSeconds: LIVE_TIER_INTERVAL_SECONDS,
      backup: BACKUP_CRON,
      timezone: WORKER_TIMEZONE,
    },
    "worker: all jobs scheduled",
  );
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
