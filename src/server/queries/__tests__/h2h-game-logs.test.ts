/**
 * DB-backed coverage for `getFranchiseH2HGameLogs` (Task 33 audit catch — the franchise profile
 * page's H2H strip N+1 fix). Asserts the batched, single-query form returns the SAME result the
 * old per-opponent `getFranchiseH2HGameLog` loop would have, for every opponent at once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, matchups, seasons, teamSeasons, type NewMatchup } from "../../db/schema";
import { getFranchiseH2HGameLog, getFranchiseH2HGameLogs } from "../h2h";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
let f1: number;
let f2: number;
let f3: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-h2h-game-logs-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;

  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2020 }).returning().get();
  db.insert(seasons).values({ season: 2020, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 13, status: "complete" }).run();

  f1 = db.insert(franchises).values({ canonicalName: "Franchise One", managerName: "Ann", joinedSeason: 2020, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Franchise Two", managerName: "Ben", joinedSeason: 2020, active: true }).returning().get().id;
  f3 = db.insert(franchises).values({ canonicalName: "Franchise Three", managerName: "Cam", joinedSeason: 2020, active: true }).returning().get().id;

  const ts1 = db.insert(teamSeasons).values({ season: 2020, franchiseId: f1, espnTeamId: 1, teamName: "T1", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false }).returning().get().id;
  const ts2 = db.insert(teamSeasons).values({ season: 2020, franchiseId: f2, espnTeamId: 2, teamName: "T2", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false }).returning().get().id;
  const ts3 = db.insert(teamSeasons).values({ season: 2020, franchiseId: f3, espnTeamId: 3, teamName: "T3", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false }).returning().get().id;

  function m(overrides: Partial<NewMatchup>): NewMatchup {
    return { season: 2020, week: 1, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 100, awayScore: 90, isFinal: true, winner: "home", ...overrides };
  }

  db.insert(matchups)
    .values([
      m({ week: 1, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, winner: "home" }), // f1 beats f2
      m({ week: 2, espnMatchupId: 2, homeTeamSeasonId: ts2, awayTeamSeasonId: ts1, winner: "away" }), // f1 beats f2 again
      m({ week: 3, espnMatchupId: 3, homeTeamSeasonId: ts1, awayTeamSeasonId: ts3, winner: "away" }), // f3 beats f1
    ])
    .run();
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe("getFranchiseH2HGameLogs", () => {
  it("matches the single-opponent form for every real opponent, in one query", () => {
    const batched = getFranchiseH2HGameLogs(f1);
    expect(batched.get(f2)).toEqual(getFranchiseH2HGameLog(f1, f2));
    expect(batched.get(f3)).toEqual(getFranchiseH2HGameLog(f1, f3));
    expect(batched.get(f2)).toEqual(["W", "W"]);
    expect(batched.get(f3)).toEqual(["L"]);
  });

  it("has no entry for a franchise with zero games against the subject", () => {
    const batched = getFranchiseH2HGameLogs(f2);
    // f2 only ever played f1 in this fixture.
    expect(batched.has(f3)).toBe(false);
  });

  it("returns an empty map for a franchise with no final games at all", () => {
    expect(getFranchiseH2HGameLogs(999999).size).toBe(0);
  });
});
