import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, playoffOdds, seasons, statBuilds } from "../../db/schema";
import { getPlayoffOdds, getPlayoffOddsForSeason, getPlayoffRaceLine } from "../playoffOdds";

describe("playoff odds query layer (DB-facing)", () => {
  let db: Db;
  let sqlite: Database.Database;
  let dbPath: string;
  let franchiseA: number;
  let franchiseB: number;
  let franchiseC: number;

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-playoffodds-query-test-")), "test.db");
    // getPlayoffOddsForSeason/getPlayoffRaceLine read through the getDb() lazy singleton — point it
    // at this temp file BEFORE their first call (same pattern standings.test.ts's Career-scope suite
    // uses). Vitest isolates process.env per test file, so this can't leak into other test files.
    process.env.DATABASE_PATH = dbPath;

    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2024 }).returning().get();
    db.insert(seasons)
      .values([
        { season: 2024, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 2, status: "complete" },
        { season: 2025, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 14, status: "active" },
      ])
      .run();

    franchiseA = db.insert(franchises).values({ canonicalName: "Alpha", managerName: "Ann", joinedSeason: 2024 }).returning().get().id;
    franchiseB = db.insert(franchises).values({ canonicalName: "Bravo", managerName: "Bea", joinedSeason: 2024 }).returning().get().id;
    franchiseC = db.insert(franchises).values({ canonicalName: "Charlie", managerName: "Cam", joinedSeason: 2024 }).returning().get().id;

    const build = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test-hash", status: "ok" }).returning().get();
    db.insert(playoffOdds)
      .values([
        // Alpha: a near-lock, out of the "bubble" range.
        { buildId: build.id, season: 2025, franchiseId: franchiseA, playoffProbability: 0.95, topSeedProbability: 0.4, seedDistributionJson: [0.4, 0.3, 0.25, 0.05], runs: 10_000 },
        // Bravo: genuinely on the bubble.
        { buildId: build.id, season: 2025, franchiseId: franchiseB, playoffProbability: 0.5, topSeedProbability: 0.05, seedDistributionJson: [0.05, 0.15, 0.3, 0.5], runs: 10_000 },
        // Charlie: a near-lock-out, out of the bubble range on the other side.
        { buildId: build.id, season: 2025, franchiseId: franchiseC, playoffProbability: 0.05, topSeedProbability: 0, seedDistributionJson: [0, 0.05, 0.15, 0.8], runs: 10_000 },
      ])
      .run();
  });

  afterAll(() => {
    sqlite.close();
    // The query functions under test open getDb()'s lazy singleton — a SECOND connection to the
    // same temp file — has to be closed too, or Windows holds an exclusive lock on the temp
    // directory and rmSync below fails with EPERM (same fix standings.test.ts's Career-scope suite
    // and db-integration.test.ts use).
    getSqlite().close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  describe("getPlayoffOddsForSeason", () => {
    it("returns every franchise's row for the given season", () => {
      const rows = getPlayoffOddsForSeason(2025);
      expect(rows).toHaveLength(3);
      const byFranchise = new Map(rows.map((r) => [r.franchiseId, r]));
      expect(byFranchise.get(franchiseA)!.playoffProbability).toBeCloseTo(0.95, 9);
      expect(getPlayoffOdds(2025)).toEqual(rows);
    });

    it("returns an EMPTY array for a season with no odds rows (complete season — honest empty, not an error)", () => {
      expect(getPlayoffOddsForSeason(2024)).toEqual([]);
    });

    it("returns an EMPTY array for a season that doesn't exist at all", () => {
      expect(getPlayoffOddsForSeason(1999)).toEqual([]);
    });
  });

  describe("getPlayoffRaceLine", () => {
    it("reports the viewer's own probability and the bubble count for the active season", () => {
      const line = getPlayoffRaceLine(franchiseB);
      expect(line).not.toBeNull();
      expect(line!.season).toBe(2025);
      expect(line!.viewerProbability).toBeCloseTo(0.5, 9);
      expect(line!.bubbleTeamCount).toBe(1); // only Bravo (0.5) is strictly between 10%/90%
    });

    it("viewerProbability is null when there's no signed-in franchise", () => {
      const line = getPlayoffRaceLine(null);
      expect(line).not.toBeNull();
      expect(line!.viewerProbability).toBeNull();
      expect(line!.bubbleTeamCount).toBe(1);
    });

    it("viewerProbability is null when the viewer's franchise has no odds row this build", () => {
      const line = getPlayoffRaceLine(999_999);
      expect(line).not.toBeNull();
      expect(line!.viewerProbability).toBeNull();
    });
  });
});
