/**
 * Historical backfill CLI: `npm run backfill -- --from 2018 --to 2026 [--force]`.
 *
 * ESPN silently deletes old league history, so this walks every requested
 * season and archives everything ESPN still has, one snapshot row at a
 * time, via `src/server/sync/snapshots.ts`. It is safe to re-run: the
 * hash-skip in `storeSnapshot` and the `hasSnapshot` pre-check make repeat
 * invocations cheap.
 *
 * The CLI entrypoint (`main`, gated by `isMainModule`) is a thin wrapper
 * over `runBackfill`, which takes its `{ db, client, sleep, logger }`
 * dependencies injected so it can be exercised in tests with a mocked
 * client, an instant `sleep`, and a temp-file DB — no real network calls,
 * no multi-minute test runs.
 */
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import pino from "pino";
import { getDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { syncRuns, type NewSyncRun } from "../db/schema";
import { getEspnCredentials, getLeagueId } from "../sync/credentials";
import { hasSnapshot, storeSnapshot, viewKey } from "../sync/snapshots";
import { EspnAuthError, EspnClient } from "./client";
import type { EspnLogger, EspnView, FetchLeagueParams, FetchLeagueResult } from "./types";

// Mirrors EspnClient's own modern/history endpoint-era cutoff (see client.ts):
// seasons before this only have the season-scope payload left in ESPN's
// leagueHistory endpoint — no per-period boxscore/roster data survives.
const MODERN_SEASON_CUTOFF = 2018;

const SEASON_SCOPE_VIEWS: readonly EspnView[] = [
  "mSettings",
  "mTeam",
  "mStandings",
  "mDraftDetail",
  "mTransactions2",
  "mMatchup",
];

const PERIOD_VIEWS: readonly EspnView[] = ["mBoxscore", "mMatchupScore", "mRoster"];

/**
 * Confirmed by live probe (Task 7): `mTransactions2` is per-period-only —
 * fetched WITHOUT `scoringPeriodId` it returns no `transactions` key at all;
 * fetched WITH one it returns that period's transactions. This is therefore
 * its own snapshot lineage (view key `mTransactions2`, `scoring_period` set)
 * — deliberately NOT the same view key as `PERIOD_VIEWS` (mixing them in
 * would orphan the existing `mBoxscore,mMatchupScore,mRoster` archive) and
 * NOT the season-scope combined view either (which already includes
 * `mTransactions2` in its view list but — confirmed live — never actually
 * returns transaction data without the period param).
 */
const TRANSACTIONS_VIEWS: readonly EspnView[] = ["mTransactions2"];

const FALLBACK_SCORING_PERIODS = 17;
const MAX_SCORING_PERIODS = 25;

const SLEEP_BASE_MS = 2500;
const SLEEP_JITTER_MS = 500;

/** [2000, 3000) — 2500ms base with ±500ms jitter, per the brief's politeness requirement. */
function nextSleepDelayMs(): number {
  return SLEEP_BASE_MS + (Math.random() * 2 - 1) * SLEEP_JITTER_MS;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

interface SeasonScopeJsonShape {
  status?: { finalScoringPeriod?: unknown };
  settings?: { scheduleSettings?: { matchupPeriodCount?: unknown } };
}

/**
 * Determines how many scoring periods (weeks) to fetch per-period data for,
 * from the already-fetched season-scope response:
 *   1. `status.finalScoringPeriod` when present and positive.
 *   2. Else `settings.scheduleSettings.matchupPeriodCount` as a hint.
 *   3. Else fall back to 17 (logged as a warning — this is a guess).
 * Always capped at 25 regardless of source, as a sanity guard against a
 * malformed/unexpected payload sending this into a runaway fetch loop.
 * This is deliberately NOT full payload parsing (that's Task 5's job) — just
 * enough structure-sniffing to bound the per-period fetch loop.
 */
export function determineScoringPeriodCount(json: unknown, season: number, logger: EspnLogger): number {
  const obj = (json ?? {}) as SeasonScopeJsonShape;

  const fromStatus = obj.status?.finalScoringPeriod;
  if (isPositiveFiniteNumber(fromStatus)) {
    return Math.min(Math.trunc(fromStatus), MAX_SCORING_PERIODS);
  }

  const fromSchedule = obj.settings?.scheduleSettings?.matchupPeriodCount;
  if (isPositiveFiniteNumber(fromSchedule)) {
    return Math.min(Math.trunc(fromSchedule), MAX_SCORING_PERIODS);
  }

  logger.warn(
    { season },
    `season ${season}: no status.finalScoringPeriod or settings.scheduleSettings.matchupPeriodCount in the ` +
      `season-scope response; falling back to ${FALLBACK_SCORING_PERIODS} scoring periods`,
  );
  return Math.min(FALLBACK_SCORING_PERIODS, MAX_SCORING_PERIODS);
}

/** Minimal shape `runBackfill` needs from an ESPN client — real `EspnClient` satisfies this structurally. */
export interface BackfillEspnClient {
  fetchLeague(params: FetchLeagueParams): Promise<FetchLeagueResult>;
}

export interface BackfillDeps {
  db: Db;
  client: BackfillEspnClient;
  /** Injected so tests can make this instant; production gets a real setTimeout-based sleep. */
  sleep: (ms: number) => Promise<void>;
  logger: EspnLogger;
}

export interface BackfillOptions {
  from: number;
  to: number;
  /** Refetch per-period data even when a snapshot already exists for that (season, view, period). */
  force?: boolean;
}

export interface BackfillSummary {
  syncRunId: number;
  status: "ok" | "partial" | "auth_failed";
  viewsFetched: number;
  snapshotsNew: number;
  errorText?: string;
}

function authErrorMessage(err: EspnAuthError, season: number, period?: number): string {
  const where = period !== undefined ? `season ${season} period ${period}` : `season ${season}`;
  return (
    `ESPN authentication failed while fetching ${where} (HTTP ${err.status}). This league likely requires ` +
    `cookies. Supply them via the ESPN_S2 and ESPN_SWID environment variables, or set the "espn_s2" and ` +
    `"swid" keys in the app_settings table (e.g. from /admin), then re-run the backfill.`
  );
}

/**
 * Runs the historical backfill for seasons `opts.from`..`opts.to` inclusive.
 * Records exactly one `sync_runs` row (tier `backfill`), moving it from
 * `running` to a terminal status (`ok` / `partial` / `auth_failed`) when
 * done. An `EspnAuthError` anywhere aborts the entire run immediately; any
 * other error on a single fetch is logged, counted, and the run continues
 * (ending `partial`) — one bad week never kills the archive run.
 */
export async function runBackfill(deps: BackfillDeps, opts: BackfillOptions): Promise<BackfillSummary> {
  const { db, client, sleep, logger } = deps;
  const force = opts.force ?? false;

  const runRow = db
    .insert(syncRuns)
    .values({ startedAt: new Date(), tier: "backfill", status: "running" })
    .returning({ id: syncRuns.id })
    .get();

  let viewsFetched = 0;
  let snapshotsNew = 0;
  let failureCount = 0;
  let authFailureMessage: string | undefined;

  // Sleep BEFORE every request after the first — never after the last one,
  // since there's nothing left to be polite about once the run is done.
  // The delay still lands around a failure exactly the same as around a
  // success: whatever request comes next (a later period, a later season)
  // pays the sleep first, regardless of whether the previous attempt threw.
  let requestCount = 0;

  async function fetchWithPoliteness(params: FetchLeagueParams): Promise<FetchLeagueResult> {
    if (requestCount > 0) {
      await sleep(nextSleepDelayMs());
    }
    requestCount++;
    return client.fetchLeague(params);
  }

  seasonLoop: for (let season = opts.from; season <= opts.to; season++) {
    let seasonJson: unknown;
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
        { season, inserted: stored.inserted },
        stored.inserted ? "season-scope: fetched new snapshot" : "season-scope: fetched, unchanged",
      );
    } catch (err) {
      if (err instanceof EspnAuthError) {
        authFailureMessage = authErrorMessage(err, season);
        logger.error({ season, err: String(err) }, "auth failure on season-scope fetch; aborting backfill run");
        break seasonLoop;
      }
      failureCount++;
      logger.error(
        { season, err: String(err) },
        "season-scope fetch failed; skipping this season's per-period fetches and continuing",
      );
      continue;
    }

    if (season < MODERN_SEASON_CUTOFF) {
      // ESPN's leagueHistory endpoint is all that survives for these seasons
      // — no per-period boxscore/roster data to fetch.
      continue;
    }

    const periodCount = determineScoringPeriodCount(seasonJson, season, logger);
    const periodViews = [...PERIOD_VIEWS].sort() as EspnView[];
    const periodViewKey = viewKey(periodViews);

    for (let period = 1; period <= periodCount; period++) {
      if (!force && hasSnapshot(db, { season, view: periodViewKey, scoringPeriod: period })) {
        logger.info({ season, period }, "period: skip, snapshot already exists");
        continue;
      }

      try {
        const result = await fetchWithPoliteness({ season, views: periodViews, scoringPeriodId: period });
        viewsFetched++;
        const stored = storeSnapshot(db, {
          season,
          scoringPeriod: period,
          view: periodViewKey,
          url: result.url,
          httpStatus: result.status,
          payload: result.payload,
        });
        if (stored.inserted) snapshotsNew++;
        logger.info(
          { season, period, inserted: stored.inserted },
          stored.inserted ? "period: fetched new snapshot" : "period: fetched, unchanged",
        );
      } catch (err) {
        if (err instanceof EspnAuthError) {
          authFailureMessage = authErrorMessage(err, season, period);
          logger.error({ season, period, err: String(err) }, "auth failure on period fetch; aborting backfill run");
          break seasonLoop;
        }
        failureCount++;
        logger.error({ season, period, err: String(err) }, "period fetch failed; continuing");
      }
    }

    // Separate loop, same period range, AFTER the roster fetches — its own snapshot lineage
    // (see TRANSACTIONS_VIEWS docstring). Same politeness/skip/error policy as the roster loop.
    const transactionsViews = [...TRANSACTIONS_VIEWS].sort() as EspnView[];
    const transactionsViewKey = viewKey(transactionsViews);

    for (let period = 1; period <= periodCount; period++) {
      if (!force && hasSnapshot(db, { season, view: transactionsViewKey, scoringPeriod: period })) {
        logger.info({ season, period }, "transactions: skip, snapshot already exists");
        continue;
      }

      try {
        const result = await fetchWithPoliteness({ season, views: transactionsViews, scoringPeriodId: period });
        viewsFetched++;
        const stored = storeSnapshot(db, {
          season,
          scoringPeriod: period,
          view: transactionsViewKey,
          url: result.url,
          httpStatus: result.status,
          payload: result.payload,
        });
        if (stored.inserted) snapshotsNew++;
        logger.info(
          { season, period, inserted: stored.inserted },
          stored.inserted ? "transactions: fetched new snapshot" : "transactions: fetched, unchanged",
        );
      } catch (err) {
        if (err instanceof EspnAuthError) {
          authFailureMessage = authErrorMessage(err, season, period);
          logger.error(
            { season, period, err: String(err) },
            "auth failure on transactions fetch; aborting backfill run",
          );
          break seasonLoop;
        }
        failureCount++;
        logger.error({ season, period, err: String(err) }, "transactions fetch failed; continuing");
      }
    }
  }

  const status: BackfillSummary["status"] = authFailureMessage ? "auth_failed" : failureCount > 0 ? "partial" : "ok";
  const errorText =
    authFailureMessage ?? (failureCount > 0 ? `${failureCount} fetch(es) failed during backfill; see logs.` : undefined);

  const updateValues: Partial<NewSyncRun> = { finishedAt: new Date(), status, viewsFetched, snapshotsNew };
  if (errorText !== undefined) updateValues.errorText = errorText;

  db.update(syncRuns).set(updateValues).where(eq(syncRuns.id, runRow.id)).run();

  return { syncRunId: runRow.id, status, viewsFetched, snapshotsNew, errorText };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export interface CliArgs {
  from: number;
  to: number;
  force: boolean;
  /** Overrides the stored/env league id when provided. */
  league?: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  let from: number | undefined;
  let to: number | undefined;
  let force = false;
  let league: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--from":
        from = Number(argv[++i]);
        break;
      case "--to":
        to = Number(argv[++i]);
        break;
      case "--force":
        force = true;
        break;
      case "--league":
        league = Number(argv[++i]);
        break;
      default:
        throw new Error(`backfill: unknown argument "${arg}"`);
    }
  }

  if (from === undefined || Number.isNaN(from)) {
    throw new Error("backfill: --from <season> is required, e.g. --from 2018");
  }
  if (to === undefined || Number.isNaN(to)) {
    throw new Error("backfill: --to <season> is required, e.g. --to 2026");
  }
  if (to < from) {
    throw new Error(`backfill: --to (${to}) must be >= --from (${from})`);
  }
  if (league !== undefined && Number.isNaN(league)) {
    throw new Error("backfill: --league must be a number");
  }

  return { from, to, force, league };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const logger: EspnLogger = pino();

  const db = getDb();
  runMigrations(db);

  const leagueId = args.league ?? getLeagueId(db);
  const cookies = getEspnCredentials(db);

  const client = new EspnClient({ leagueId, cookies: cookies ?? undefined, logger });

  logger.info({ from: args.from, to: args.to, force: args.force, leagueId }, "starting ESPN backfill");

  const summary = await runBackfill(
    { db, client, sleep: realSleep, logger },
    { from: args.from, to: args.to, force: args.force },
  );

  logger.info(summary, "backfill run finished");

  if (summary.status === "auth_failed") {
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
