/**
 * Task 31 — DB-wiring tests for src/server/queries/pickem.ts. The current-week RESOLUTION rule
 * itself is unit-tested directly against src/engines/pickem.ts's computeCurrentPickemWeek; this
 * file proves the DB queries feed it correctly and covers the byes-exclusion / picks-round-trip
 * wiring those pure functions can't see.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, managers, matchups, pickemPicks, seasons, teamSeasons } from "../../db/schema";
import { getCurrentPickemWeek, getManagerPicksForWeek, getPickemMatchupRows, getPickemMatchupRowsForSeason, getPicksForSeason, getPicksForWeek } from "../pickem";

const SEASON = 2026;

describe("src/server/queries/pickem.ts", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-queries-pickem-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const leagueId = db.insert(leagues).values({ espnLeagueId: 1690915927, name: "Test League", firstSeason: SEASON }).returning().get().id;
    db.insert(seasons)
      .values({ season: SEASON, leagueId, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 14, status: "upcoming" })
      .run();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedFranchise(name: string): number {
    return db.insert(franchises).values({ canonicalName: name, managerName: `${name} Manager`, joinedSeason: SEASON }).returning().get().id;
  }

  function seedTeamSeason(franchiseId: number, espnTeamId: number, name: string): number {
    return db
      .insert(teamSeasons)
      .values({ season: SEASON, franchiseId, espnTeamId, teamName: name, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
  }

  it("getCurrentPickemWeek: preseason (all matchups non-final) resolves to week 1", () => {
    const fA = seedFranchise("Alpha");
    const fB = seedFranchise("Bravo");
    const tA = seedTeamSeason(fA, 1, "Alpha");
    const tB = seedTeamSeason(fB, 2, "Bravo");
    db.insert(matchups).values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: tA, awayTeamSeasonId: tB, homeScore: 0, awayScore: 0, isFinal: false, winner: null }).run();

    expect(getCurrentPickemWeek(db)).toEqual({ season: SEASON, week: 1 });
  });

  it("getPickemMatchupRows: excludes byes (no away team_season) entirely — nothing to pick a winner against", () => {
    const fA = seedFranchise("Alpha");
    const fB = seedFranchise("Bravo");
    const fC = seedFranchise("Charlie");
    const tA = seedTeamSeason(fA, 1, "Alpha");
    const tB = seedTeamSeason(fB, 2, "Bravo");
    const tC = seedTeamSeason(fC, 3, "Charlie");

    db.insert(matchups).values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: tA, awayTeamSeasonId: tB, homeScore: 0, awayScore: 0, isFinal: false, winner: null }).run();
    // Charlie's bye — no away team_season, isFinal true by construction (normalize.ts convention).
    db.insert(matchups).values({ season: SEASON, week: 1, espnMatchupId: 2, homeTeamSeasonId: tC, awayTeamSeasonId: null, homeScore: 0, awayScore: 0, isFinal: true, winner: null }).run();

    const rows = getPickemMatchupRows(db, SEASON, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.homeFranchiseId).toBe(fA);
    expect(rows[0]!.awayFranchiseId).toBe(fB);
  });

  it("getPickemMatchupRows: winningFranchiseId resolves from matchups.winner, null for a not-final or tied game", () => {
    const fA = seedFranchise("Alpha");
    const fB = seedFranchise("Bravo");
    const tA = seedTeamSeason(fA, 1, "Alpha");
    const tB = seedTeamSeason(fB, 2, "Bravo");

    db.insert(matchups).values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: tA, awayTeamSeasonId: tB, homeScore: 100, awayScore: 90, isFinal: true, winner: "home" }).run();
    db.insert(matchups).values({ season: SEASON, week: 2, espnMatchupId: 2, homeTeamSeasonId: tA, awayTeamSeasonId: tB, homeScore: 80, awayScore: 95, isFinal: true, winner: "away" }).run();
    db.insert(matchups).values({ season: SEASON, week: 3, espnMatchupId: 3, homeTeamSeasonId: tA, awayTeamSeasonId: tB, homeScore: 70, awayScore: 70, isFinal: true, winner: "tie" }).run();
    db.insert(matchups).values({ season: SEASON, week: 4, espnMatchupId: 4, homeTeamSeasonId: tA, awayTeamSeasonId: tB, homeScore: 0, awayScore: 0, isFinal: false, winner: null }).run();

    const bySeason = getPickemMatchupRowsForSeason(db, SEASON);
    const byWeek = new Map(bySeason.map((r) => [r.matchupId, r]));
    expect(byWeek.get(1)!.winningFranchiseId).toBe(fA);
    expect(byWeek.get(2)!.winningFranchiseId).toBe(fB);
    expect(byWeek.get(3)!.winningFranchiseId).toBeNull(); // tie
    expect(byWeek.get(4)!.winningFranchiseId).toBeNull(); // not final
  });

  it("getManagerPicksForWeek / getPicksForWeek / getPicksForSeason round-trip real pickem_picks rows", () => {
    const fA = seedFranchise("Alpha");
    const fB = seedFranchise("Bravo");
    const tA = seedTeamSeason(fA, 1, "Alpha");
    const tB = seedTeamSeason(fB, 2, "Bravo");
    const matchupId = db
      .insert(matchups)
      .values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: tA, awayTeamSeasonId: tB, homeScore: 0, awayScore: 0, isFinal: false, winner: null })
      .returning()
      .get().id;

    const managerId = db.insert(managers).values({ name: "Manager Five", role: "manager", inviteToken: "tok-5" }).returning().get().id;
    db.insert(pickemPicks).values({ managerId, isAlgorithm: false, season: SEASON, week: 1, matchupId, pickedFranchiseId: fA, createdAt: new Date(), updatedAt: new Date() }).run();
    db.insert(pickemPicks).values({ managerId: null, isAlgorithm: true, season: SEASON, week: 1, matchupId, pickedFranchiseId: fB, createdAt: new Date(), updatedAt: new Date() }).run();

    expect(getManagerPicksForWeek(db, SEASON, 1, managerId)).toEqual(new Map([[matchupId, fA]]));

    const weekRows = getPicksForWeek(db, SEASON, 1);
    expect(weekRows).toHaveLength(2);
    expect(weekRows.some((r) => r.isAlgorithm && r.pickedFranchiseId === fB)).toBe(true);
    expect(weekRows.some((r) => r.managerId === managerId && r.pickedFranchiseId === fA)).toBe(true);

    expect(getPicksForSeason(db, SEASON)).toHaveLength(2);
  });
});
