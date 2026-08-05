/**
 * Task 31 — proves `run-tier.ts`'s hourly-tier wiring for "The Algorithm" AI-pick computation end
 * to end: a real hourly tick (mocked ESPN client, real fetch -> normalize -> stat build ->
 * pickem-lock pipeline) actually reaches `computeAndStoreAlgorithmPicks` and stores rows when the
 * AI toggle is on and the week is locked, and does NOT otherwise. Same small-fixture shape as
 * run-tier-lineup-holes.test.ts (deliberately a separate, self-contained fixture — "keeps this
 * file's blast radius to itself").
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { appSettings, pickemPicks } from "../../db/schema";
import type { BackfillEspnClient } from "../../espn/backfill";
import type { EspnLogger, FetchLeagueParams, FetchLeagueResult } from "../../espn/types";
import { PICKEM_AI_ENABLED_KEY } from "../pickem-lock";
import { runSyncTier, type SyncTierOptions } from "../run-tier";

const SEASON = 2026;
const LEAGUE_ID = 8888;
const SWIDS = [1, 2, 3, 4].map((n) => `{SWID-PK-0000-0000-00000000000${n}}`);

const THURSDAY_LOCK = new Date("2026-09-03T20:00:00-04:00");
const PRESEASON_NOW = new Date("2026-08-08T12:00:00-04:00"); // a Saturday — locked per wall clock alone, NOT per isSeasonUnderway

const NORMALIZE_OPTS: SyncTierOptions["normalizeOpts"] = {
  leagueId: LEAGUE_ID,
  franchiseSeed: {
    franchises: [1, 2, 3, 4].map((n) => ({
      id: n,
      canonicalName: `Franchise ${n}`,
      managerName: `Manager ${n}`,
      joinedSeason: SEASON,
      departedSeason: null,
      active: true,
      accentColor: null,
      notes: null,
      managers: [{ managerName: `Manager ${n}`, espnOwnerSwid: SWIDS[n - 1]!, fromSeason: SEASON, toSeason: null }],
      espnTeamIds: [{ season: SEASON, espnTeamId: n }],
    })),
  },
};

function seasonScopePayload(latestScoringPeriod: number): Record<string, unknown> {
  return {
    settings: {
      name: "Pickem Fixture League",
      size: 4,
      rosterSettings: { lineupSlotCounts: {} },
      scheduleSettings: { matchupPeriodCount: 1 },
      scoringSettings: { scoringItems: [] },
    },
    status: { finalScoringPeriod: 1, currentMatchupPeriod: 1, latestScoringPeriod },
    members: [1, 2, 3, 4].map((n) => ({ id: SWIDS[n - 1], displayName: `Manager ${n}`, firstName: `${n}`, lastName: "Manager" })),
    teams: [1, 2, 3, 4].map((n) => ({
      id: n,
      abbrev: `T${n}`,
      name: `Team ${n}`,
      logo: "",
      owners: [SWIDS[n - 1]],
      record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 } },
      playoffSeed: n,
      rankCalculatedFinal: 0,
    })),
    schedule: [
      { id: 601, matchupPeriodId: 1, home: { teamId: 1, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 }, winner: "UNDECIDED" },
      { id: 602, matchupPeriodId: 1, home: { teamId: 3, totalPoints: 0 }, away: { teamId: 4, totalPoints: 0 }, winner: "UNDECIDED" },
    ],
    draftDetail: { picks: [] },
  };
}

function buildMockClient(handler: (params: FetchLeagueParams) => FetchLeagueResult): BackfillEspnClient {
  return { fetchLeague: async (params) => handler(params) };
}

function jsonResult(json: unknown, url: string): FetchLeagueResult {
  return { payload: JSON.stringify(json), json, url, status: 200 };
}

function testLogger(): EspnLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function instantSleep(): (ms: number) => Promise<void> {
  return async () => {};
}

function handlerFor(latestScoringPeriod: number) {
  return (params: FetchLeagueParams): FetchLeagueResult => {
    if (params.scoringPeriodId === undefined) return jsonResult(seasonScopePayload(latestScoringPeriod), "https://example.com/season");
    if (params.views.includes("mRoster")) return jsonResult({ schedule: [] }, "https://example.com/week");
    return jsonResult({ transactions: [] }, "https://example.com/tx");
  };
}

describe("run-tier pick'em AI-pick wiring (Task 31)", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-run-tier-pickem-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function enableAi(): void {
    db.insert(appSettings).values({ key: PICKEM_AI_ENABLED_KEY, valueJson: true, updatedAt: new Date() }).run();
  }

  function algorithmPickRows() {
    return db.select().from(pickemPicks).where(eq(pickemPicks.isAlgorithm, true)).all();
  }

  it("AI disabled (default): the hourly tick runs successfully but stores no algorithm picks", async () => {
    const client = buildMockClient(handlerFor(1));
    const result = await runSyncTier(
      { db, client, sleep: instantSleep(), logger: testLogger() },
      { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS, now: THURSDAY_LOCK },
    );

    expect(result.status).toBe("ok");
    expect(algorithmPickRows()).toHaveLength(0);
  });

  it("real 2026 preseason state (latestScoringPeriod 0): AI enabled but NOT locked -> no algorithm picks stored, even on a wall-clock day that alone would read as locked", async () => {
    enableAi();
    const client = buildMockClient(handlerFor(0));
    const result = await runSyncTier(
      { db, client, sleep: instantSleep(), logger: testLogger() },
      { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS, now: PRESEASON_NOW },
    );

    expect(result.status).toBe("ok");
    expect(algorithmPickRows()).toHaveLength(0);
  });

  it("AI enabled, season underway, at Thursday lock time: the SAME hourly tick computes and stores one algorithm pick per matchup", async () => {
    enableAi();
    const client = buildMockClient(handlerFor(1));
    const result = await runSyncTier(
      { db, client, sleep: instantSleep(), logger: testLogger() },
      { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS, now: THURSDAY_LOCK },
    );

    expect(result.status).toBe("ok");
    const rows = algorithmPickRows();
    expect(rows).toHaveLength(2); // one per matchup (601, 602)
    for (const row of rows) {
      expect(row.managerId).toBeNull();
      expect(row.season).toBe(SEASON);
      expect(row.week).toBe(1);
    }
  });

  it("is idempotent across repeated hourly ticks within the same locked week — no duplicate algorithm rows", async () => {
    enableAi();
    const client = buildMockClient(handlerFor(1));
    const deps = { db, client, sleep: instantSleep(), logger: testLogger() };

    await runSyncTier(deps, { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS, now: THURSDAY_LOCK });
    await runSyncTier(deps, { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS, now: new Date("2026-09-03T21:00:00-04:00") });

    expect(algorithmPickRows()).toHaveLength(2); // still exactly one per matchup, not 4
  });

  it("the daily tier does NOT compute algorithm picks (brief scope: hourly only)", async () => {
    enableAi();
    const client = buildMockClient(handlerFor(1));
    await runSyncTier({ db, client, sleep: instantSleep(), logger: testLogger() }, { tier: "daily", season: SEASON, normalizeOpts: NORMALIZE_OPTS, now: THURSDAY_LOCK });

    expect(algorithmPickRows()).toHaveLength(0);
  });
});
