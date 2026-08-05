import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { snapshots, syncRuns } from "../../db/schema";
import { EspnAuthError, EspnHttpError } from "../../espn/client";
import type { EspnLogger, FetchLeagueParams, FetchLeagueResult } from "../../espn/types";
import {
  type BackfillEspnClient,
  determineScoringPeriodCount,
  parseArgs,
  runBackfill,
} from "../../espn/backfill";
import { storeSnapshot } from "../snapshots";

const SEASON_VIEW_KEY = "mDraftDetail,mMatchup,mSettings,mStandings,mTeam,mTransactions2";
const PERIOD_VIEW_KEY = "mBoxscore,mMatchupScore,mRoster";
const TX_VIEW_KEY = "mTransactions2";

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

function seasonScopeResult(json: unknown, url = "https://example.com/season"): FetchLeagueResult {
  return { payload: JSON.stringify(json), json, url, status: 200 };
}

function periodResult(period: number, url = "https://example.com/period"): FetchLeagueResult {
  const json = { period, ok: true };
  return { payload: JSON.stringify(json), json, url: `${url}/${period}`, status: 200 };
}

/** Every period-scoped call is either the roster/boxscore fetch or the (Task 7) transactions fetch — distinguished by `views`, not call order, so assertions don't depend on which loop runs first. */
function isRosterCall(c: FetchLeagueParams): boolean {
  return c.scoringPeriodId !== undefined && c.views.includes("mRoster");
}
function isTxCall(c: FetchLeagueParams): boolean {
  return c.scoringPeriodId !== undefined && c.views.includes("mTransactions2") && c.views.length === 1;
}

describe("runBackfill", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-backfill-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe(">=2018 season fetch plan", () => {
    it("fetches season-scope once, then N per-period roster snapshots AND N per-period transactions snapshots, where N = status.finalScoringPeriod", async () => {
      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 3 } });
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep, delays } = instantSleep();
      const logger = testLogger();

      const summary = await runBackfill({ db, client, sleep, logger }, { from: 2024, to: 2024 });

      // 1 season-scope + 3 roster periods + 3 transactions periods.
      expect(calls).toHaveLength(7);
      expect(calls[0]!.scoringPeriodId).toBeUndefined();
      const rosterCalls = calls.filter(isRosterCall);
      const txCalls = calls.filter(isTxCall);
      expect(rosterCalls.map((c) => c.scoringPeriodId)).toEqual([1, 2, 3]);
      expect(txCalls.map((c) => c.scoringPeriodId)).toEqual([1, 2, 3]);
      // The transactions loop runs entirely AFTER the roster loop for a season (brief's spec).
      expect(calls.indexOf(rosterCalls[2]!)).toBeLessThan(calls.indexOf(txCalls[0]!));

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(7);
      const seasonScopeRow = rows.find((r) => r.scoringPeriod === null);
      expect(seasonScopeRow?.view).toBe(SEASON_VIEW_KEY);
      const rosterRows = rows.filter((r) => r.view === PERIOD_VIEW_KEY);
      expect(rosterRows.map((r) => r.scoringPeriod).sort()).toEqual([1, 2, 3]);
      const txRows = rows.filter((r) => r.view === TX_VIEW_KEY);
      expect(txRows.map((r) => r.scoringPeriod).sort()).toEqual([1, 2, 3]);

      expect(summary.status).toBe("ok");
      expect(summary.viewsFetched).toBe(7);
      expect(summary.snapshotsNew).toBe(7);

      const runRows = db.select().from(syncRuns).all();
      expect(runRows).toHaveLength(1);
      expect(runRows[0]!.status).toBe("ok");
      expect(runRows[0]!.tier).toBe("backfill");
      expect(runRows[0]!.viewsFetched).toBe(7);
      expect(runRows[0]!.snapshotsNew).toBe(7);
      expect(runRows[0]!.finishedAt).not.toBeNull();

      // Politeness sleep happens BETWEEN requests only — 7 requests means 6
      // gaps, never a trailing sleep after the last request of the run.
      expect(delays).toHaveLength(6);
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(2000);
        expect(d).toBeLessThan(3000);
      }
    });

    it("caps at 25 scoring periods even if finalScoringPeriod reports higher — for both the roster AND transactions loops", async () => {
      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 40 } });
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep } = instantSleep();

      await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2024, to: 2024 });

      expect(calls).toHaveLength(1 + 25 + 25);
      expect(calls.filter(isRosterCall)).toHaveLength(25);
      expect(calls.filter(isTxCall)).toHaveLength(25);
    });
  });

  describe("pre-2018 season", () => {
    it("fetches season-scope only — no per-period roster OR transactions fetches at all", async () => {
      const { client, calls } = buildMockClient(() => seasonScopeResult({ status: { finalScoringPeriod: 16 } }));
      const { sleep, delays } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2015, to: 2015 });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.scoringPeriodId).toBeUndefined();

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scoringPeriod).toBeNull();

      expect(summary.viewsFetched).toBe(1);
      expect(summary.snapshotsNew).toBe(1);
      expect(summary.status).toBe("ok");

      // A single request in the whole run: no "between requests" gap exists, so sleep never fires.
      expect(delays).toHaveLength(0);
    });

    it("season-scope fetch is NOT hasSnapshot-gated — it's always issued over the network even when a snapshot already exists, but hash-skip still prevents a duplicate row when the payload is unchanged", async () => {
      const seasonScopeJson = { status: { finalScoringPeriod: 16 } };
      const prior = storeSnapshot(db, {
        season: 2015,
        scoringPeriod: null,
        view: SEASON_VIEW_KEY,
        url: "https://example.com/prior-season",
        httpStatus: 200,
        payload: JSON.stringify(seasonScopeJson),
      });

      const { client, calls } = buildMockClient(() => seasonScopeResult(seasonScopeJson));
      const { sleep } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2015, to: 2015 });

      // The network call happens regardless of the pre-existing snapshot — season-scope has no hasSnapshot gate.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.scoringPeriodId).toBeUndefined();

      // But storeSnapshot's hash-skip still applies: identical payload -> no duplicate row.
      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(prior.id);

      expect(summary.viewsFetched).toBe(1); // the fetch happened...
      expect(summary.snapshotsNew).toBe(0); // ...but nothing new was inserted (hash-skip)
    });
  });

  describe("hasSnapshot skip behavior and --force override", () => {
    it("skips a roster period fetch when a snapshot already exists for it, unless --force — independently of the transactions lineage", async () => {
      // Pre-seed a ROSTER snapshot for season 2024, period 1 — no transactions snapshot exists yet.
      storeSnapshot(db, {
        season: 2024,
        scoringPeriod: 1,
        view: PERIOD_VIEW_KEY,
        url: "https://example.com/prior",
        httpStatus: 200,
        payload: '{"prior":true}',
      });

      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 2 } });
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2024, to: 2024 });

      // season-scope + roster period2 (period1 skipped) + BOTH transactions periods (neither pre-seeded).
      expect(calls).toHaveLength(4);
      expect(calls.filter(isRosterCall).map((c) => c.scoringPeriodId)).toEqual([2]);
      expect(calls.filter(isTxCall).map((c) => c.scoringPeriodId)).toEqual([1, 2]);
      expect(summary.viewsFetched).toBe(4);
      expect(summary.snapshotsNew).toBe(4);
    });

    it("skips a transactions period fetch when a snapshot already exists for it, unless --force — independently of the roster lineage", async () => {
      // Pre-seed a TRANSACTIONS snapshot for period 1 only — roster lineage untouched.
      storeSnapshot(db, {
        season: 2024,
        scoringPeriod: 1,
        view: TX_VIEW_KEY,
        url: "https://example.com/prior",
        httpStatus: 200,
        payload: "{}",
      });

      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 2 } });
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep } = instantSleep();

      await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2024, to: 2024 });

      expect(calls.filter(isRosterCall).map((c) => c.scoringPeriodId)).toEqual([1, 2]);
      expect(calls.filter(isTxCall).map((c) => c.scoringPeriodId)).toEqual([2]); // period 1 skipped
    });

    it("--force refetches every roster AND transactions period even when snapshots already exist for both", async () => {
      storeSnapshot(db, {
        season: 2024,
        scoringPeriod: 1,
        view: PERIOD_VIEW_KEY,
        url: "https://example.com/prior",
        httpStatus: 200,
        payload: '{"prior":true}',
      });
      storeSnapshot(db, {
        season: 2024,
        scoringPeriod: 2,
        view: PERIOD_VIEW_KEY,
        url: "https://example.com/prior",
        httpStatus: 200,
        payload: '{"prior":true}',
      });
      storeSnapshot(db, {
        season: 2024,
        scoringPeriod: 1,
        view: TX_VIEW_KEY,
        url: "https://example.com/prior",
        httpStatus: 200,
        payload: "{}",
      });
      storeSnapshot(db, {
        season: 2024,
        scoringPeriod: 2,
        view: TX_VIEW_KEY,
        url: "https://example.com/prior",
        httpStatus: 200,
        payload: "{}",
      });

      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 2 } });
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep } = instantSleep();

      const summary = await runBackfill(
        { db, client, sleep, logger: testLogger() },
        { from: 2024, to: 2024, force: true },
      );

      // season-scope + roster(1,2) + transactions(1,2), despite all four already existing.
      expect(calls).toHaveLength(5);
      expect(calls.filter(isRosterCall).map((c) => c.scoringPeriodId)).toEqual([1, 2]);
      expect(calls.filter(isTxCall).map((c) => c.scoringPeriodId)).toEqual([1, 2]);
      expect(summary.viewsFetched).toBe(5);
    });
  });

  describe("auth error aborts the run", () => {
    it("aborts immediately when the season-scope fetch throws EspnAuthError, marking sync_runs auth_failed", async () => {
      const { client, calls } = buildMockClient(() => {
        throw new EspnAuthError(401, "https://example.com/season");
      });
      const { sleep } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2024, to: 2024 });

      expect(calls).toHaveLength(1);
      expect(summary.status).toBe("auth_failed");
      expect(summary.errorText).toMatch(/ESPN_S2/);
      expect(summary.errorText).toMatch(/ESPN_SWID/);

      const runRows = db.select().from(syncRuns).all();
      expect(runRows).toHaveLength(1);
      expect(runRows[0]!.status).toBe("auth_failed");
    });

    it("aborts mid-season on a ROSTER period fetch auth error before the transactions loop ever runs, and never attempts subsequent periods or seasons", async () => {
      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 3 } });
        }
        if (params.scoringPeriodId === 2) {
          throw new EspnAuthError(401, "https://example.com/period/2");
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2023, to: 2025 });

      // season-scope(2023) + roster period1(2023) + roster period2(2023, throws) — the roster
      // loop's own period=2 request hits the throw before the transactions loop is ever reached,
      // and nothing from 2024/2025 either.
      expect(calls).toHaveLength(3);
      expect(calls.map((c) => c.season)).toEqual([2023, 2023, 2023]);
      expect(summary.status).toBe("auth_failed");

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(2); // season-scope + roster period 1 only
    });

    it("aborts on a TRANSACTIONS period fetch auth error after the roster loop already completed for that season", async () => {
      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 2 } });
        }
        if (isTxCall(params) && params.scoringPeriodId === 1) {
          throw new EspnAuthError(401, "https://example.com/tx/1");
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2023, to: 2025 });

      // season-scope + roster(1,2) both succeed, then the transactions loop's very first
      // request (period 1) throws — aborting before period 2 or any later season.
      expect(calls).toHaveLength(4);
      expect(calls.map((c) => c.season)).toEqual([2023, 2023, 2023, 2023]);
      expect(summary.status).toBe("auth_failed");

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(3); // season-scope + roster period1 + roster period2
    });
  });

  describe("partial run on a single fetch failure", () => {
    it("logs, counts, and continues past a non-auth error on scoringPeriodId=2 in BOTH loops, ending status=partial", async () => {
      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          return seasonScopeResult({ status: { finalScoringPeriod: 3 } });
        }
        if (params.scoringPeriodId === 2) {
          throw new EspnHttpError(500, `https://example.com/period/2`);
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep, delays } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2024, to: 2024 });

      // All 7 requests are attempted (season-scope + 3 roster + 3 tx) even though period 2 fails
      // in BOTH the roster and the transactions loop (same scoringPeriodId condition, two loops).
      expect(calls).toHaveLength(7);
      expect(summary.status).toBe("partial");
      // season-scope + roster(1,3) + tx(1,3) succeeded; roster(2) and tx(2) did not.
      expect(summary.viewsFetched).toBe(5);
      expect(summary.snapshotsNew).toBe(5);

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(5);
      const rosterPeriods = rows.filter((r) => r.view === PERIOD_VIEW_KEY).map((r) => r.scoringPeriod);
      expect(rosterPeriods.sort()).toEqual([1, 3]);
      const txPeriods = rows.filter((r) => r.view === TX_VIEW_KEY).map((r) => r.scoringPeriod);
      expect(txPeriods.sort()).toEqual([1, 3]);

      // Politeness sleep still lands around each failed request — paid by whatever request comes
      // next, never appended after a failure itself. 7 requests total -> 6 between-request gaps.
      expect(delays).toHaveLength(6);

      const runRows = db.select().from(syncRuns).all();
      expect(runRows[0]!.status).toBe("partial");
    });

    it("continues to the next season after a season-scope failure, skipping that season's roster AND transactions periods entirely", async () => {
      const { client, calls } = buildMockClient((params) => {
        if (params.scoringPeriodId === undefined) {
          if (params.season === 2023) {
            throw new EspnHttpError(500, "https://example.com/season/2023");
          }
          return seasonScopeResult({ status: { finalScoringPeriod: 1 } });
        }
        return periodResult(params.scoringPeriodId);
      });
      const { sleep } = instantSleep();

      const summary = await runBackfill({ db, client, sleep, logger: testLogger() }, { from: 2023, to: 2024 });

      expect(summary.status).toBe("partial");
      // 2023: only the failed season-scope attempt (no periods, since we never learned finalScoringPeriod).
      // 2024: season-scope + roster period1 + transactions period1 all succeed.
      expect(calls.map((c) => [c.season, c.scoringPeriodId])).toEqual([
        [2023, undefined],
        [2024, undefined],
        [2024, 1],
        [2024, 1],
      ]);

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.season === 2024)).toBe(true);
    });
  });

  describe("determineScoringPeriodCount", () => {
    it("uses status.finalScoringPeriod when present and positive", () => {
      const count = determineScoringPeriodCount({ status: { finalScoringPeriod: 14 } }, 2024, testLogger());
      expect(count).toBe(14);
    });

    it("caps status.finalScoringPeriod at 25", () => {
      const count = determineScoringPeriodCount({ status: { finalScoringPeriod: 99 } }, 2024, testLogger());
      expect(count).toBe(25);
    });

    it("falls back to settings.scheduleSettings.matchupPeriodCount when finalScoringPeriod is absent", () => {
      const count = determineScoringPeriodCount(
        { settings: { scheduleSettings: { matchupPeriodCount: 13 } } },
        2024,
        testLogger(),
      );
      expect(count).toBe(13);
    });

    it("falls back to 17 and logs a warning when neither hint is present", () => {
      const logger = testLogger();
      const count = determineScoringPeriodCount({}, 2024, logger);
      expect(count).toBe(17);
      expect(logger.warn).toHaveBeenCalled();
    });

    it("falls back to 17 when json is not an object shape at all", () => {
      const count = determineScoringPeriodCount(null, 2024, testLogger());
      expect(count).toBe(17);
    });
  });

  describe("parseArgs", () => {
    it("parses --from, --to, and defaults --force to false", () => {
      expect(parseArgs(["--from", "2018", "--to", "2026"])).toEqual({
        from: 2018,
        to: 2026,
        force: false,
        league: undefined,
      });
    });

    it("parses --force and --league", () => {
      expect(parseArgs(["--from", "2018", "--to", "2018", "--force", "--league", "555"])).toEqual({
        from: 2018,
        to: 2018,
        force: true,
        league: 555,
      });
    });

    it("throws when --from is missing", () => {
      expect(() => parseArgs(["--to", "2026"])).toThrow(/--from/);
    });

    it("throws when --to is missing", () => {
      expect(() => parseArgs(["--from", "2018"])).toThrow(/--to/);
    });

    it("throws when --to is less than --from", () => {
      expect(() => parseArgs(["--from", "2026", "--to", "2018"])).toThrow(/--to/);
    });
  });
});
