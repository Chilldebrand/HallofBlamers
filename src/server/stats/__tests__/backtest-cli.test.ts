/**
 * Task 32 backtest reproducibility tests. Deliberately does NOT touch the real `data/league.db` —
 * per subagent-ops-rules the real DB is always read-only, and a test suite that only passes when a
 *330MB production file happens to exist at a specific host path would break `npm test` for anyone
 * else. Instead this seeds a small, fully-owned fixture through the SAME `createDb` +
 * `runMigrations` + `runStatBuild` pipeline `npm run winprob:backtest` itself uses, and exercises
 * `runBacktest` (the DB-facing computation, factored out of the CLI's `main()` for exactly this
 * reason) directly. The real headline numbers against the actual league history are reported
 * separately by running `npm run winprob:backtest` by hand (see this task's report).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, matchups, players, rosterSlots, seasons, teamSeasons, weeks } from "../../db/schema";
import { parseArgs, runBacktest } from "../backtest-cli";
import { runStatBuild } from "../build";

const LINEUP_SLOT_COUNTS = { "0": 1, "2": 1 }; // 1 QB, 1 RB starting — per LINEUP_SLOT_MAP

describe("parseArgs", () => {
  it("defaults to DATABASE_PATH (or ./data/league.db) and bucket width 0.1", () => {
    const original = process.env.DATABASE_PATH;
    delete process.env.DATABASE_PATH;
    try {
      expect(parseArgs([])).toEqual({ source: "./data/league.db", bucketWidth: 0.1 });
    } finally {
      if (original !== undefined) process.env.DATABASE_PATH = original;
    }
  });

  it("--source and --bucket-width override the defaults", () => {
    expect(parseArgs(["--source", "/tmp/foo.db", "--bucket-width", "0.2"])).toEqual({ source: "/tmp/foo.db", bucketWidth: 0.2 });
  });

  it("rejects an out-of-range --bucket-width", () => {
    expect(() => parseArgs(["--bucket-width", "0"])).toThrow(/bucket-width/);
    expect(() => parseArgs(["--bucket-width", "1.5"])).toThrow(/bucket-width/);
    expect(() => parseArgs(["--bucket-width", "not-a-number"])).toThrow(/bucket-width/);
  });

  it("rejects an unknown argument", () => {
    expect(() => parseArgs(["--nonsense"])).toThrow(/unknown argument/);
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseArgs(["--source"])).toThrow(/--source requires a value/);
  });
});

describe("runBacktest", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-backtest-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** 2 franchises, 2 seasons x 3 regular weeks, alternating decisive winners, real roster_slots
   * so slot_scoring_stats has something non-trivial to calibrate from. */
  function seedTwoSeasonFixture(): void {
    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Backtest League", firstSeason: 2020 }).returning().get();

    const franchiseId: Record<"A" | "B", number> = {
      A: db.insert(franchises).values({ canonicalName: "A", managerName: "Ann", joinedSeason: 2020 }).returning().get().id,
      B: db.insert(franchises).values({ canonicalName: "B", managerName: "Ben", joinedSeason: 2020 }).returning().get().id,
    };

    let nextPlayerId = 1;
    let nextMatchupId = 1;

    for (const season of [2020, 2021]) {
      db.insert(seasons)
        .values({
          season,
          leagueId: league.id,
          settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
          scoringJson: {},
          playoffFormatJson: {},
          teamCount: 2,
          regSeasonWeeks: 3,
          status: "complete",
        })
        .run();

      const teamSeasonId: Record<"A" | "B", number> = {
        A: db
          .insert(teamSeasons)
          .values({ season, franchiseId: franchiseId.A, espnTeamId: 1, teamName: "A", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
          .returning()
          .get().id,
        B: db
          .insert(teamSeasons)
          .values({ season, franchiseId: franchiseId.B, espnTeamId: 2, teamName: "B", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
          .returning()
          .get().id,
      };

      for (let week = 1; week <= 3; week++) {
        db.insert(weeks).values({ season, week, scoringPeriodId: week, weekType: "regular", isComplete: true }).run();

        // Alternates who wins, and by how much, so the fixture isn't degenerate (all-one-sided).
        const aWins = (season + week) % 2 === 0;
        const homeScore = aWins ? 30 + week : 20 + week;
        const awayScore = aWins ? 20 + week : 30 + week;

        db.insert(matchups)
          .values({
            season,
            week,
            espnMatchupId: nextMatchupId++,
            homeTeamSeasonId: teamSeasonId.A,
            awayTeamSeasonId: teamSeasonId.B,
            homeScore,
            awayScore,
            isFinal: true,
            winner: aWins ? "home" : "away",
          })
          .run();

        for (const [key, tsId, qbPts, rbPts] of [
          ["A", teamSeasonId.A, aWins ? 15 + week : 10 + week, aWins ? 15 : 10] as const,
          ["B", teamSeasonId.B, aWins ? 10 + week : 15 + week, aWins ? 10 : 15] as const,
        ]) {
          const qbId = nextPlayerId++;
          const rbId = nextPlayerId++;
          db.insert(players).values({ espnPlayerId: qbId, fullName: `${key} QB w${week}`, defaultPosition: "QB" }).onConflictDoNothing().run();
          db.insert(players).values({ espnPlayerId: rbId, fullName: `${key} RB w${week}`, defaultPosition: "RB" }).onConflictDoNothing().run();
          db.insert(rosterSlots)
            .values([
              { season, week, teamSeasonId: tsId, playerId: qbId, lineupSlot: "QB", isStarter: true, points: qbPts, eligibleSlotsJson: ["QB"] },
              { season, week, teamSeasonId: tsId, playerId: rbId, lineupSlot: "RB", isStarter: true, points: rbPts, eligibleSlotsJson: ["RB"] },
            ])
            .run();
        }
      }
    }
  }

  it("covers every final, non-bye matchup in the fixture (2 seasons x 3 weeks = 6)", () => {
    seedTwoSeasonFixture();
    runStatBuild(db, { force: true });
    const report = runBacktest(db, 0.1);
    expect(report.matchupCount).toBe(6);
    expect(report.seasonRange).toEqual({ min: 2020, max: 2021 });
  });

  it("our model and pure Elo produce IDENTICAL Brier scores and calibration tables pre-game — the documented structural fact, not a bug", () => {
    seedTwoSeasonFixture();
    runStatBuild(db, { force: true });
    const report = runBacktest(db, 0.1);

    expect(report.ourModel.brierScore).toBeCloseTo(report.pureElo.brierScore, 10);
    expect(report.ourModel.calibration.map((b) => ({ n: b.n, meanPredicted: b.meanPredicted })).filter((b) => b.n > 0)).toEqual(
      report.pureElo.calibration.map((b) => ({ n: b.n, meanPredicted: b.meanPredicted })).filter((b) => b.n > 0),
    );
  });

  it("Brier scores are all real, finite numbers in the valid [0, 1] range for a non-empty backtest", () => {
    seedTwoSeasonFixture();
    runStatBuild(db, { force: true });
    const report = runBacktest(db, 0.1);

    for (const score of [report.ourModel.brierScore, report.pureElo.brierScore, report.coinFlip.brierScore]) {
      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    expect(report.coinFlip.brierScore).toBeCloseTo(0.25, 10); // no ties in the fixture — see computeBrierScore's own test for why this is exact
  });

  it("reproducibility: two independent runBacktest calls against the SAME already-built database return deep-equal reports", () => {
    seedTwoSeasonFixture();
    runStatBuild(db, { force: true });

    const first = runBacktest(db, 0.1);
    const second = runBacktest(db, 0.1);
    expect(second).toEqual(first);
  });

  it("reproducibility: a full re-seed + re-build + re-backtest from scratch reproduces the same headline numbers", () => {
    seedTwoSeasonFixture();
    runStatBuild(db, { force: true });
    const first = runBacktest(db, 0.1);

    // Fresh database, same fixture, same pipeline end to end.
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-backtest-test-rerun-"));
    const opened2 = createDb(path.join(tmpDir2, "test.db"));
    runMigrations(opened2.db);
    const savedDb = db;
    db = opened2.db;
    try {
      seedTwoSeasonFixture();
      runStatBuild(opened2.db, { force: true });
      const second = runBacktest(opened2.db, 0.1);
      expect(second).toEqual(first);
    } finally {
      db = savedDb;
      opened2.sqlite.close();
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  it("Brier score is NaN and calibration buckets are all empty when there are zero final non-bye matchups", () => {
    // No seed at all — a freshly migrated, empty database.
    runStatBuild(db, { force: true });
    const report = runBacktest(db, 0.1);
    expect(report.matchupCount).toBe(0);
    expect(Number.isNaN(report.ourModel.brierScore)).toBe(true);
    expect(Number.isNaN(report.pureElo.brierScore)).toBe(true);
    expect(Number.isNaN(report.coinFlip.brierScore)).toBe(true);
    expect(report.ourModel.calibration.every((b) => b.n === 0)).toBe(true);
  });
});
