import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { snapshots, syncRuns } from "../../db/schema";
import { EspnAuthError } from "../../espn/client";
import type { BackfillEspnClient } from "../../espn/backfill";
import type { EspnLogger, FetchLeagueParams, FetchLeagueResult } from "../../espn/types";
import {
  buildFranchiseSeed,
  buildSeasonScopePayload,
  buildTransactionsPeriodPayload,
  buildWeekScopePayload,
  FIXTURE_LEAGUE_ID,
  FIXTURE_SEASON,
} from "../__fixtures__/season-2024";
import { isSeasonUnderway, runSyncTier, type SyncTierOptions } from "../run-tier";

/** Points normalizeSeason at the fixture's franchise seed + league id instead of the real
 * seed/franchises.json + ESPN_LEAGUE_ID env/app_settings (unset in a fresh scratch DB). */
const NORMALIZE_OPTS: SyncTierOptions["normalizeOpts"] = { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID };

function buildMockClient(
  handler: (params: FetchLeagueParams) => FetchLeagueResult | Promise<FetchLeagueResult>,
): { client: BackfillEspnClient; calls: FetchLeagueParams[] } {
  const calls: FetchLeagueParams[] = [];
  const client: BackfillEspnClient = {
    fetchLeague: async (params: FetchLeagueParams) => {
      calls.push(params);
      return handler(params);
    },
  };
  return { client, calls };
}

function instantSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

function testLogger(): EspnLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function jsonResult(json: unknown, url: string): FetchLeagueResult {
  return { payload: JSON.stringify(json), json, url, status: 200 };
}

/** A season-scope response whose status fields drive both tiers' period-selection logic. */
function seasonScopeResult(): FetchLeagueResult {
  return jsonResult(buildSeasonScopePayload(), "https://example.com/season");
}

function isPeriodCall(c: FetchLeagueParams): boolean {
  return c.scoringPeriodId !== undefined && c.views.includes("mRoster");
}
function isTxCall(c: FetchLeagueParams): boolean {
  return c.scoringPeriodId !== undefined && c.views.includes("mTransactions2") && c.views.length === 1;
}

/** Standard mock: season-scope (finalScoringPeriod=2, latestScoringPeriod=2, per the fixture),
 * week-scope payloads for periods 1 and 2, and empty transactions for any period. */
function standardHandler(params: FetchLeagueParams): FetchLeagueResult {
  if (params.scoringPeriodId === undefined) return seasonScopeResult();
  if (params.views.includes("mRoster")) {
    const period = params.scoringPeriodId as 1 | 2;
    return jsonResult(buildWeekScopePayload(period), `https://example.com/week${period}`);
  }
  return jsonResult(buildTransactionsPeriodPayload(params.scoringPeriodId!, []), `https://example.com/tx${params.scoringPeriodId}`);
}

describe("runSyncTier", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-run-tier-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hourly tier", () => {
    it("fetches season-scope plus ONLY the in-progress period (roster+tx), not earlier periods", async () => {
      const { client, calls } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier(
        { db, client, sleep, logger },
        { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS },
      );

      // 1 season-scope + period-2 roster + period-2 transactions. Period 1 never fetched.
      expect(calls).toHaveLength(3);
      expect(calls[0]!.scoringPeriodId).toBeUndefined();
      const periodCalls = calls.filter(isPeriodCall);
      const txCalls = calls.filter(isTxCall);
      expect(periodCalls.map((c) => c.scoringPeriodId)).toEqual([2]);
      expect(txCalls.map((c) => c.scoringPeriodId)).toEqual([2]);

      expect(result.status).toBe("ok");
      expect(result.viewsFetched).toBe(3);
      expect(result.normalize).not.toBeNull();
      expect(result.statBuild).not.toBeNull();
      expect(result.statBuild!.status).toBe("ok");
    });

    it("fetches season-scope only when the season hasn't kicked off yet (latestScoringPeriod 0)", async () => {
      const preseasonPayload = { ...buildSeasonScopePayload(), status: { finalScoringPeriod: 17, latestScoringPeriod: 0 } };
      const { client, calls } = buildMockClient((params) =>
        params.scoringPeriodId === undefined ? jsonResult(preseasonPayload, "https://example.com/season") : standardHandler(params),
      );
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier(
        { db, client, sleep, logger },
        { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS },
      );

      expect(calls).toHaveLength(1);
      expect(result.status).toBe("ok");
    });

    it("records a sync_runs row with tier 'hourly' and a terminal status", async () => {
      const { client } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier(
        { db, client, sleep, logger },
        { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS },
      );

      const row = db.select().from(syncRuns).where(eq(syncRuns.id, result.syncRunId)).get();
      expect(row?.tier).toBe("hourly");
      expect(row?.status).toBe("ok");
      expect(row?.finishedAt).not.toBeNull();
    });
  });

  describe("daily tier", () => {
    it("fetches season-scope plus EVERY period's roster+tx", async () => {
      const { client, calls } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier(
        { db, client, sleep, logger },
        { tier: "daily", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS },
      );

      // 1 season-scope + 2 roster periods + 2 transaction periods.
      expect(calls).toHaveLength(5);
      const periodCalls = calls.filter(isPeriodCall).map((c) => c.scoringPeriodId);
      const txCalls = calls.filter(isTxCall).map((c) => c.scoringPeriodId);
      expect(periodCalls).toEqual([1, 2]);
      expect(txCalls).toEqual([1, 2]);
      expect(result.status).toBe("ok");
    });

    it("refetches a period even when it was already snapshotted earlier the same day", async () => {
      const { client, calls } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();
      const deps = { db, client, sleep, logger };

      await runSyncTier(deps, { tier: "daily", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });
      calls.length = 0;
      await runSyncTier(deps, { tier: "daily", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });

      // Second run still issues every request — no hasSnapshot-based skip for this tier.
      expect(calls).toHaveLength(5);
    });
  });

  describe("live tier", () => {
    it("skips the fetch entirely (warns) when no season-scope snapshot is archived yet, but still runs normalize/build/emission", async () => {
      const { client, calls } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier(
        { db, client, sleep, logger },
        { tier: "live", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS },
      );

      expect(calls).toHaveLength(0); // no season-scope, no period fetch — nothing archived to read a period from
      expect(result.viewsFetched).toBe(0);
      expect(result.status).not.toBe("auth_failed");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tier: "live", season: FIXTURE_SEASON }),
        expect.stringContaining("no archived season-scope snapshot"),
      );
      // Fixture season (2024) is before EMISSION_MIN_SEASON (2026) — emission is a deliberate no-op.
      expect(result.eventsEmitted).toBe(0);
    });

    it("fetches ONLY the current period's weekly view (no season-scope, no transactions) once a season-scope snapshot already exists", async () => {
      const { client: hourlyClient } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();
      // Prime the archive the way a real hourly tick would, before any live window opens.
      await runSyncTier({ db, client: hourlyClient, sleep, logger }, { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });

      const { client: liveClient, calls } = buildMockClient(standardHandler);
      const result = await runSyncTier(
        { db, client: liveClient, sleep, logger },
        { tier: "live", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS },
      );

      // The fixture's season-scope snapshot has latestScoringPeriod=2 — exactly ONE request, the
      // period-2 roster/boxscore view. No season-scope re-fetch, no transactions fetch.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.scoringPeriodId).toBe(2);
      expect(calls[0]!.views).toEqual([...calls[0]!.views].sort());
      expect(calls[0]!.views.includes("mTransactions2")).toBe(false);
      expect(result.viewsFetched).toBe(1);
      expect(result.status).toBe("ok");
    });

    it("records a sync_runs row with tier 'live'", async () => {
      const { client } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier({ db, client, sleep, logger }, { tier: "live", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });

      const row = db.select().from(syncRuns).where(eq(syncRuns.id, result.syncRunId)).get();
      expect(row?.tier).toBe("live");
      expect(row?.finishedAt).not.toBeNull();
    });

    it("an auth failure on the live period fetch is recorded auth_failed, normalize/build/emission skipped", async () => {
      const { client: hourlyClient } = buildMockClient(standardHandler);
      const { sleep } = instantSleep();
      const logger = testLogger();
      await runSyncTier({ db, client: hourlyClient, sleep, logger }, { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });

      const { client: liveClient } = buildMockClient(() => {
        throw new EspnAuthError(401, "https://example.com/live-period");
      });
      const result = await runSyncTier({ db, client: liveClient, sleep, logger }, { tier: "live", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });

      expect(result.status).toBe("auth_failed");
      expect(result.normalize).toBeNull();
      expect(result.statBuild).toBeNull();
      expect(result.eventsEmitted).toBe(0);
    });
  });

  describe("isSeasonUnderway", () => {
    // FIX ROUND 1 (reviewer finding 1) — direct coverage of the new gate function itself,
    // independent of runLiveTick's own worker-level tests (worker/__tests__/index.test.ts).

    it("is false when no season-scope snapshot has been archived yet", () => {
      expect(isSeasonUnderway(db, FIXTURE_SEASON)).toBe(false);
    });

    it("is false when the archived snapshot's latestScoringPeriod is 0 — preseason, schedule generated but not started (the real 2026 bug scenario)", async () => {
      const preseasonPayload = { ...buildSeasonScopePayload(), status: { finalScoringPeriod: 17, latestScoringPeriod: 0 } };
      const { client } = buildMockClient((params) =>
        params.scoringPeriodId === undefined ? jsonResult(preseasonPayload, "https://example.com/season") : standardHandler(params),
      );
      const { sleep } = instantSleep();
      const logger = testLogger();
      await runSyncTier({ db, client, sleep, logger }, { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });

      expect(isSeasonUnderway(db, FIXTURE_SEASON)).toBe(false);
    });

    it("is true once the archived snapshot shows a real latestScoringPeriod >= 1", async () => {
      const { client } = buildMockClient(standardHandler); // fixture's status.latestScoringPeriod is 2
      const { sleep } = instantSleep();
      const logger = testLogger();
      await runSyncTier({ db, client, sleep, logger }, { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS });

      expect(isSeasonUnderway(db, FIXTURE_SEASON)).toBe(true);
    });

    it("is false when the archived snapshot's payload fails to parse as JSON (never crashes, never assumes underway)", () => {
      // Archive a corrupt snapshot directly (bypassing storeSnapshot's normal JSON-producing callers).
      db.insert(snapshots)
        .values({
          season: FIXTURE_SEASON,
          scoringPeriod: null,
          view: "mDraftDetail,mMatchup,mSettings,mStandings,mTeam,mTransactions2",
          url: "https://example.com/corrupt",
          fetchedAt: new Date(),
          httpStatus: 200,
          payload: "{not valid json",
          payloadHash: "deadbeef",
        })
        .run();

      expect(isSeasonUnderway(db, FIXTURE_SEASON)).toBe(false);
    });
  });

  describe("politeness", () => {
    it("sleeps before every request after the first, never after the last", async () => {
      const { client } = buildMockClient(standardHandler);
      const { sleep, delays } = instantSleep();
      const logger = testLogger();

      await runSyncTier({ db, client, sleep, logger }, { tier: "hourly", season: FIXTURE_SEASON });

      // 3 total requests (season-scope, period, tx) -> 2 sleeps (before request 2 and 3).
      expect(sleep).toHaveBeenCalledTimes(2);
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(2000);
        expect(d).toBeLessThan(3000);
      }
    });
  });

  describe("error handling", () => {
    it("aborts the whole tick on an auth failure and skips normalize/stat build entirely", async () => {
      const { client, calls } = buildMockClient(() => {
        throw new EspnAuthError(401, "https://example.com/season");
      });
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier({ db, client, sleep, logger }, { tier: "hourly", season: FIXTURE_SEASON });

      expect(calls).toHaveLength(1);
      expect(result.status).toBe("auth_failed");
      expect(result.normalize).toBeNull();
      expect(result.statBuild).toBeNull();
      expect(result.errorText).toMatch(/authentication failed/i);
      // The worker builds ONE EspnClient at startup and reuses it for every scheduled tick (see
      // worker/index.ts's buildRealDeps()) — a later tick reuses the same stale cookies and would
      // fail identically, so the message must point at restarting (./ops/deploy.sh), never imply
      // that simply waiting for the next tick helps.
      expect(result.errorText).toMatch(/ops\/deploy\.sh/);
      expect(result.errorText).not.toMatch(/next scheduled tick/i);
    });

    it("marks the run 'partial' but still runs normalize/build when a non-auth fetch fails", async () => {
      let call = 0;
      const { client, calls } = buildMockClient((params) => {
        call++;
        if (params.scoringPeriodId === 2 && params.views.includes("mRoster")) {
          throw new Error("ECONNRESET (simulated)");
        }
        return standardHandler(params);
      });
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier(
        { db, client, sleep, logger },
        { tier: "hourly", season: FIXTURE_SEASON, normalizeOpts: NORMALIZE_OPTS },
      );

      expect(call).toBeGreaterThan(0);
      expect(calls.some((c) => c.scoringPeriodId === 2 && c.views.includes("mTransactions2") && c.views.length === 1)).toBe(true);
      expect(result.status).toBe("partial");
      expect(result.normalize).not.toBeNull();
      expect(result.statBuild).not.toBeNull();
    });

    it("an auth failure mid-period still records the sync_runs row as auth_failed", async () => {
      const { client } = buildMockClient((params) => {
        if (params.scoringPeriodId === 2 && params.views.includes("mRoster")) {
          throw new EspnAuthError(403, "https://example.com/week2");
        }
        return standardHandler(params);
      });
      const { sleep } = instantSleep();
      const logger = testLogger();

      const result = await runSyncTier({ db, client, sleep, logger }, { tier: "hourly", season: FIXTURE_SEASON });

      const row = db.select().from(syncRuns).where(eq(syncRuns.id, result.syncRunId)).get();
      expect(row?.status).toBe("auth_failed");
      expect(result.normalize).toBeNull();
    });
  });
});
