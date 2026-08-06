import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, seasons as seasonsTable, statBuilds, teamSeasons, teamWeek } from "../../db/schema";
import {
  getBestWorstScheduleResult,
  getOptimalLineupSeasonResult,
  getScheduleSwapResult,
  getWhatIfPageData,
  getWhatIfFranchiseOptions,
  resolveWhatIfFranchise,
  resolveWhatIfFranchisePair,
  resolveWhatIfMode,
  resolveWhatIfSeason,
  type WhatIfFranchiseOption,
} from "../whatIf";
import type { SeasonOption } from "../standings";

// ---------------------------------------------------------------------------
// Pure param parsing — no DB needed.
// ---------------------------------------------------------------------------

describe("resolveWhatIfMode", () => {
  it("defaults to swap for a missing/garbage value", () => {
    expect(resolveWhatIfMode(undefined)).toBe("swap");
    expect(resolveWhatIfMode("xyz")).toBe("swap");
  });

  it("recognizes bestworst and lineup", () => {
    expect(resolveWhatIfMode("bestworst")).toBe("bestworst");
    expect(resolveWhatIfMode("lineup")).toBe("lineup");
  });
});

describe("resolveWhatIfSeason", () => {
  const options: SeasonOption[] = [
    { season: 2018, status: "complete" },
    { season: 2019, status: "complete" },
  ];

  it("accepts a recognized season", () => {
    expect(resolveWhatIfSeason("2019", options, 2018)).toBe(2019);
  });

  it("falls back to the default for garbage, missing, or an unknown year", () => {
    expect(resolveWhatIfSeason(undefined, options, 2018)).toBe(2018);
    expect(resolveWhatIfSeason("banana", options, 2018)).toBe(2018);
    expect(resolveWhatIfSeason("2099", options, 2018)).toBe(2018);
  });
});

describe("resolveWhatIfFranchise", () => {
  const options: WhatIfFranchiseOption[] = [
    { id: 1, name: "Alpha" },
    { id: 2, name: "Bravo" },
  ];

  it("accepts a recognized id", () => {
    expect(resolveWhatIfFranchise("2", options, 1)).toBe(2);
  });

  it("falls back for garbage, missing, or an id not in this season", () => {
    expect(resolveWhatIfFranchise(undefined, options, 1)).toBe(1);
    expect(resolveWhatIfFranchise("nope", options, 1)).toBe(1);
    expect(resolveWhatIfFranchise("999", options, 1)).toBe(1);
  });
});

describe("resolveWhatIfFranchisePair", () => {
  const options: WhatIfFranchiseOption[] = [
    { id: 1, name: "Alpha" },
    { id: 2, name: "Bravo" },
    { id: 3, name: "Charlie" },
  ];

  it("resolves two distinct recognized ids as given", () => {
    expect(resolveWhatIfFranchisePair("2", "3", options)).toEqual({ franchiseAId: 2, franchiseBId: 3 });
  });

  it("defaults to the first two options (by name) when both params are missing", () => {
    expect(resolveWhatIfFranchisePair(undefined, undefined, options)).toEqual({ franchiseAId: 1, franchiseBId: 2 });
  });

  it("a collision (?franchiseA=1&franchiseB=1) bumps B to the next option rather than letting a franchise play itself", () => {
    expect(resolveWhatIfFranchisePair("1", "1", options)).toEqual({ franchiseAId: 1, franchiseBId: 2 });
  });

  it("wraps around when A is the last option and collides", () => {
    expect(resolveWhatIfFranchisePair("3", "3", options)).toEqual({ franchiseAId: 3, franchiseBId: 1 });
  });

  it("empty options returns the -1/-1 sentinel rather than crashing", () => {
    expect(resolveWhatIfFranchisePair("1", "2", [])).toEqual({ franchiseAId: -1, franchiseBId: -1 });
  });
});

// ---------------------------------------------------------------------------
// DB-facing — real query functions against a seeded scratch DB (never the real data/league.db;
// see subagent-ops-rules skill). Reproduces the exact real-data shapes this task's brief calls
// out by name: a 2019-style outlier week (187.7, confirmed live against data/league.db before
// writing this fixture) flowing through unclipped, and a pre-2018-style season where
// optimal_score is null on every decided row.
// ---------------------------------------------------------------------------

describe("DB-facing", () => {
  let db: Db;
  let sqlite: Database.Database;
  let dbPath: string;

  let franchiseA: number;
  let franchiseB: number;
  let franchiseC: number;
  let franchiseD: number;

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ffootball-whatif-test-")), "test.db");
    // getScheduleSwapResult/getBestWorstScheduleResult/getOptimalLineupSeasonResult/
    // getWhatIfFranchiseOptions all read through the getDb() lazy singleton, not an injected Db —
    // point it at this temp file before any call (same pattern as standings.test.ts's Career
    // scope suite / facts.playoff.test.ts).
    process.env.DATABASE_PATH = dbPath;

    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2016 }).returning().get();
    db.insert(seasonsTable)
      .values([
        { season: 2016, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 3, status: "complete" }, // pre-2018: no lineup data
        { season: 2019, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 3, status: "complete" }, // has the 187.7 outlier + an in-progress future week
        { season: 2020, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 1, status: "complete" }, // deliberately one-sided schedule coverage
      ])
      .run();

    franchiseA = db.insert(franchises).values({ canonicalName: "Alpha", managerName: "Ann", joinedSeason: 2016, active: true }).returning().get().id;
    franchiseB = db.insert(franchises).values({ canonicalName: "Bravo", managerName: "Bea", joinedSeason: 2016, active: true }).returning().get().id;
    franchiseC = db.insert(franchises).values({ canonicalName: "Charlie", managerName: "Cid", joinedSeason: 2016, active: true }).returning().get().id;
    franchiseD = db.insert(franchises).values({ canonicalName: "Delta", managerName: "Dee", joinedSeason: 2016, active: true }).returning().get().id;

    const ts = (season: number, franchiseId: number, espnTeamId: number) =>
      db
        .insert(teamSeasons)
        .values({ season, franchiseId, espnTeamId, teamName: `Team ${franchiseId}`, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
        .returning()
        .get().id;

    // 2016: all four franchises play (Delta only, to prove getWhatIfFranchiseOptions scopes per season).
    const tsA2016 = ts(2016, franchiseA, 1);
    const tsB2016 = ts(2016, franchiseB, 2);
    const tsC2016 = ts(2016, franchiseC, 3);
    // 2019: only A, B, C played (D never fielded a 2019 team — proves the season scoping).
    const tsA2019 = ts(2019, franchiseA, 1);
    const tsB2019 = ts(2019, franchiseB, 2);
    const tsC2019 = ts(2019, franchiseC, 3);
    const tsA2020 = ts(2020, franchiseA, 1);
    const tsB2020 = ts(2020, franchiseB, 2);

    const build = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get();
    const buildId = build.id;

    // --- 2016 (pre-2018 shape): matchups exist, optimal_score is null on EVERY decided row —
    // exactly the real 2015-2017 shape (0 roster_slots archived), confirmed against data/league.db.
    db.insert(teamWeek)
      .values([
        { buildId, season: 2016, week: 1, weekType: "regular", teamSeasonId: tsA2016, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 100, result: "W", margin: 10, optimalScore: null },
        { buildId, season: 2016, week: 1, weekType: "regular", teamSeasonId: tsB2016, franchiseId: franchiseB, opponentFranchiseId: franchiseA, score: 90, result: "L", margin: -10, optimalScore: null },
        { buildId, season: 2016, week: 2, weekType: "regular", teamSeasonId: tsA2016, franchiseId: franchiseA, opponentFranchiseId: franchiseC, score: 88, result: "L", margin: -5, optimalScore: null },
        { buildId, season: 2016, week: 2, weekType: "regular", teamSeasonId: tsC2016, franchiseId: franchiseC, opponentFranchiseId: franchiseA, score: 93, result: "W", margin: 5, optimalScore: null },
      ])
      .run();

    // 2020: both teams have a row, but only Alpha claims the head-to-head. Bravo is incorrectly
    // shaped as a bye. Query validation must reject the season instead of treating it as complete.
    db.insert(teamWeek)
      .values([
        { buildId, season: 2020, week: 1, weekType: "regular", teamSeasonId: tsA2020, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 100, result: "W", margin: 10, optimalScore: 110 },
        { buildId, season: 2020, week: 1, weekType: "regular", teamSeasonId: tsB2020, franchiseId: franchiseB, opponentFranchiseId: null, score: 90, result: null, margin: null, optimalScore: 95 },
      ])
      .run();

    // --- 2019 (2018+ shape): optimal_score present, includes the real 187.7 outlier score
    // (2019 wk15, confirmed against data/league.db) as franchise A's actual week-3 score, plus a
    // bye for franchise C in week 2, plus an UNDECIDED future week 4 (ESPN's 0.0/no-result
    // sentinel for a not-yet-played matchup — must never leak into a what-if record).
    db.insert(teamWeek)
      .values([
        // week 1: A beats B (h2h week for the A/B swap test); C has no opponent recorded (bye).
        { buildId, season: 2019, week: 1, weekType: "regular", teamSeasonId: tsA2019, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 120, result: "W", margin: 20, optimalScore: 140 },
        { buildId, season: 2019, week: 1, weekType: "regular", teamSeasonId: tsB2019, franchiseId: franchiseB, opponentFranchiseId: franchiseA, score: 100, result: "L", margin: -20, optimalScore: 110 },
        { buildId, season: 2019, week: 1, weekType: "regular", teamSeasonId: tsC2019, franchiseId: franchiseC, opponentFranchiseId: null, score: 95, result: null, margin: null, optimalScore: 101 },
        // week 2: A vs C, B has the bye this time.
        { buildId, season: 2019, week: 2, weekType: "regular", teamSeasonId: tsA2019, franchiseId: franchiseA, opponentFranchiseId: franchiseC, score: 130, result: "W", margin: 30, optimalScore: 150 },
        { buildId, season: 2019, week: 2, weekType: "regular", teamSeasonId: tsC2019, franchiseId: franchiseC, opponentFranchiseId: franchiseA, score: 100, result: "L", margin: -30, optimalScore: 118 },
        { buildId, season: 2019, week: 2, weekType: "regular", teamSeasonId: tsB2019, franchiseId: franchiseB, opponentFranchiseId: null, score: 90, result: null, margin: null, optimalScore: 95 },
        // week 3: A scores the real outlier (187.7) against B. B's optimal (200) beats A's real 187.7.
        { buildId, season: 2019, week: 3, weekType: "regular", teamSeasonId: tsA2019, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 187.7, result: "W", margin: 87.7, optimalScore: 190 },
        { buildId, season: 2019, week: 3, weekType: "regular", teamSeasonId: tsB2019, franchiseId: franchiseB, opponentFranchiseId: franchiseA, score: 100, result: "L", margin: -87.7, optimalScore: 200 },
        { buildId, season: 2019, week: 3, weekType: "regular", teamSeasonId: tsC2019, franchiseId: franchiseC, opponentFranchiseId: null, score: 0, result: null, margin: null, optimalScore: null },
        // week 4: an UNDECIDED future matchup (ESPN sentinel: winner UNDECIDED -> result null,
        // score defaults to 0) — must be excluded entirely, not read as "A lost 0-105."
        { buildId, season: 2019, week: 4, weekType: "regular", teamSeasonId: tsA2019, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 0, result: null, margin: null, optimalScore: null },
        { buildId, season: 2019, week: 4, weekType: "regular", teamSeasonId: tsB2019, franchiseId: franchiseB, opponentFranchiseId: franchiseA, score: 0, result: null, margin: null, optimalScore: null },
      ])
      .run();
  });

  afterAll(() => {
    sqlite.close();
    // The query functions under test opened db/client.ts's lazy singleton — a SECOND connection to
    // the same temp file — has to be closed too, or Windows holds an exclusive lock on the temp
    // directory and rmSync below fails with EPERM (same fix as standings.test.ts's Career suite).
    getSqlite().close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  describe("getWhatIfFranchiseOptions", () => {
    it("scopes to franchises that actually fielded a team that season, sorted by name", () => {
      expect(getWhatIfFranchiseOptions(2016).map((o) => o.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
      // Delta never played 2019 — must not appear as a 2019 option.
      expect(getWhatIfFranchiseOptions(2019).map((o) => o.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    });

    it("an unplayed/future season with no franchise options returns an empty list, not a crash", () => {
      expect(getWhatIfFranchiseOptions(2099)).toEqual([]);
    });
  });

  describe("getScheduleSwapResult — 2019 (real-data shape)", () => {
    it("carries the real 187.7 outlier score through unclipped as A's own score", () => {
      const result = getScheduleSwapResult(2019, franchiseA, franchiseB)!;
      expect(result).not.toBeNull();
      const week3 = result.franchiseA.record.weeks.find((w) => w.week === 3)!;
      expect(week3.ownScore).toBe(187.7);
    });

    it("excludes the undecided future week entirely (ESPN 0.0 sentinel never leaks into the record)", () => {
      const result = getScheduleSwapResult(2019, franchiseA, franchiseB)!;
      expect(result.franchiseA.record.weeks.some((w) => w.week === 4)).toBe(false);
      expect(result.franchiseB.record.weeks.some((w) => w.week === 4)).toBe(false);
    });

    it("a bye inherited from the swap partner (B's real week-2 bye) excludes A's week 2 from the record under the swap", () => {
      const result = getScheduleSwapResult(2019, franchiseA, franchiseB)!;
      const aWeek2 = result.franchiseA.record.weeks.find((w) => w.week === 2)!;
      expect(aWeek2.opponentFranchiseId).toBeNull();
      expect(aWeek2.result).toBeNull();
    });

    it("returns null for a franchise absent from the season (Delta never played 2019)", () => {
      expect(getScheduleSwapResult(2019, franchiseA, franchiseD)).toBeNull();
    });
  });

  it("rejects a query season with one-sided matchup coverage", () => {
    expect(getScheduleSwapResult(2020, franchiseA, franchiseB)).toBeNull();
    const page = getWhatIfPageData({ mode: "swap", season: "2020", franchiseA: String(franchiseA), franchiseB: String(franchiseB) });
    expect(page.available).toBe(false);
    expect(page.unavailableReason).toMatch(/coverage/i);
  });

  describe("getBestWorstScheduleResult — 2019", () => {
    it("computes A's record under every other 2019 franchise's schedule and picks a best/worst", () => {
      const result = getBestWorstScheduleResult(2019, franchiseA)!;
      expect(result).not.toBeNull();
      expect(result.schedules.map((s) => s.scheduleSourceFranchiseId).sort()).toEqual([franchiseB, franchiseC].sort());
      expect(result.best).not.toBeNull();
      expect(result.worst).not.toBeNull();
      // Actual baseline must reproduce A's real 3-0 (weeks 1-3 all wins for A in the fixture).
      expect(result.actual.wins).toBe(3);
      expect(result.actual.losses).toBe(0);
    });
  });

  describe("getOptimalLineupSeasonResult", () => {
    it("HONEST ABSENCE: a pre-2018-shaped season (optimal_score null on every decided row) is refused, not silently zeroed", () => {
      const result = getOptimalLineupSeasonResult(2016, franchiseA)!;
      expect(result).not.toBeNull();
      expect(result.available).toBe(false);
      expect(result.record).toBeNull();
      expect(result.unavailableReason).toMatch(/lineup data/i);
    });

    it("a 2018+-shaped season computes the optimal-lineup record from real opponent scores", () => {
      const result = getOptimalLineupSeasonResult(2019, franchiseA)!;
      expect(result.available).toBe(true);
      // wk1: 140 vs B's real 100 -> W. wk2: 150 vs C's real 100 -> W. wk3: 190 vs B's real 100 -> W.
      expect(result.record!.wins).toBe(3);
      expect(result.record!.losses).toBe(0);
      expect(result.record!.weeks.some((w) => w.week === 4)).toBe(false); // undecided week excluded
    });

    it("returns null for a franchise with no decided rows that season", () => {
      expect(getOptimalLineupSeasonResult(2019, franchiseD)).toBeNull();
    });
  });

  it("builds one validated, read-only page model from URL controls", () => {
    const page = getWhatIfPageData({ mode: "swap", season: "2019", franchiseA: String(franchiseA), franchiseB: String(franchiseB) });

    expect(page.available).toBe(true);
    expect(page.mode).toBe("swap");
    expect(page.season).toBe(2019);
    expect(page.result?.kind).toBe("schedule-swap");
  });
});
