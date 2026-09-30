import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { leagues, seasons } from "../../db/schema";
import { getPlayoffOddsForSeason, getPlayoffRaceLine } from "../playoffOdds";

/**
 * Separate test FILE (not just a separate `describe`) — `getDb()`'s lazy singleton
 * (`src/server/db/client.ts`) only reads `process.env.DATABASE_PATH` on its FIRST call, so a second
 * `describe` block in the same file/process can't rebind it to a fresh temp DB. Vitest gives each
 * test file its own fork/worker (same isolation `playoffOdds.test.ts` and `standings.test.ts`'s
 * Career-scope suite already rely on), which is what actually earns this file a clean singleton.
 */
describe("getPlayoffRaceLine — no active season / no stats:build has run yet", () => {
  let db: Db;
  let sqlite: Database.Database;
  let dbPath: string;

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-playoffodds-empty-test-")), "test.db");
    process.env.DATABASE_PATH = dbPath;
    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2024 }).returning().get();
    // A complete season only — no 'active' season, no playoff_odds rows at all (no stats:build with
    // stage 9 has ever run against this fresh DB).
    db.insert(seasons)
      .values([{ season: 2024, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 2, status: "complete" }])
      .run();
  });

  afterAll(() => {
    sqlite.close();
    getSqlite().close(); // see playoffOdds.test.ts's identical afterAll comment for why
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it("getPlayoffOddsForSeason returns an empty array", () => {
    expect(getPlayoffOddsForSeason(2024)).toEqual([]);
  });

  it("getPlayoffRaceLine returns null — no active season to summarize", () => {
    expect(getPlayoffRaceLine(null)).toBeNull();
  });
});
