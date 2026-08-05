/**
 * Query-shape test for Task 32's `getWinProbabilitiesForWeek`/`getCurrentWeekWinProbabilities` —
 * proves the real Drizzle reads (matchups, roster_slots, elo_history, slot_scoring_stats) wire up
 * correctly against the migrated schema and produce the shape the future sweat-meter UI expects.
 * The MODEL math itself (blend, monotonicity, edge-case collapses) is already covered directly
 * against the pure engine in `src/engines/__tests__/winProbability.test.ts` — this file is about
 * the DB plumbing: pre-game Elo resolution (including the season-regression boundary), per-slot
 * remaining/played aggregation, and bye exclusion.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ELO_SEASON_REGRESSION_FACTOR, ELO_START } from "@/engines";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { eloHistory, franchises, leagues, matchups, players, rosterSlots, seasons, slotScoringStats, statBuilds, teamSeasons, weeks } from "../../db/schema";
import { resolvePreGameElo, summarizeSlotProgress, getCurrentWeekWinProbabilities, getWinProbabilitiesForWeek, type SlotProgressRow } from "../winProbability";

let db: Db;
let sqlite: Database.Database;

const SEASON = 2026;
const WEEK = 3;

let f1: number;
let f2: number;
let f3: number;
let ts1: number;
let ts2: number;
let ts3: number;
let buildId: number;

beforeAll(() => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-winprob-query-test-")), "test.db");
  // getWinProbabilitiesForWeek/getCurrentWeekWinProbabilities go through getDb()'s lazy singleton
  // (not the scratch `db` handle directly) — must point it at this test's scratch file BEFORE
  // anything calls getDb() for the first time, same pattern as
  // src/server/queries/__tests__/lineup-holes.test.ts.
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: SEASON - 1 }).returning().get();
  for (const s of [SEASON - 1, SEASON]) {
    db.insert(seasons)
      .values({ season: s, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 14, status: "active" })
      .run();
  }

  f1 = db.insert(franchises).values({ canonicalName: "Franchise One", managerName: "Ann", joinedSeason: SEASON - 1, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Franchise Two", managerName: "Ben", joinedSeason: SEASON - 1, active: true }).returning().get().id;
  f3 = db.insert(franchises).values({ canonicalName: "Franchise Three (bye)", managerName: "Cy", joinedSeason: SEASON - 1, active: true }).returning().get().id;

  ts1 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f1, espnTeamId: 1, teamName: "Team One", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
    .returning()
    .get().id;
  ts2 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f2, espnTeamId: 2, teamName: "Team Two", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
    .returning()
    .get().id;
  ts3 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f3, espnTeamId: 3, teamName: "Team Three", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
    .returning()
    .get().id;

  db.insert(weeks).values({ season: SEASON, week: WEEK, scoringPeriodId: WEEK, weekType: "regular", isComplete: false }).run();

  // Real matchup: f1 (home) vs f2 (away), in progress. Plus a bye for f3 — must be excluded.
  db.insert(matchups)
    .values([
      { season: SEASON, week: WEEK, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 40, awayScore: 20, isFinal: false, winner: null },
      { season: SEASON, week: WEEK, espnMatchupId: 2, homeTeamSeasonId: ts3, awayTeamSeasonId: null, homeScore: 0, awayScore: 0, isFinal: false, winner: null },
    ])
    .run();

  // elo_history/slot_scoring_stats both carry a real build_id FK into stat_builds (see schema.ts's
  // "Layer 3 — derived stats" comment) — a real completed build row to tag them with, same as a
  // real `runStatBuild` would.
  const buildRow = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test-hash", status: "ok" }).returning().get();
  buildId = buildRow.id;

  // A prior COMPLETED game for f1 in week 1 (same season) establishes a real elo_history row —
  // resolvePreGameElo for week 3 should read week 1's elo_post, not fall back to ELO_START.
  db.insert(weeks).values({ season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true }).run();
  db.insert(eloHistory).values({ buildId: buildRow.id, season: SEASON, week: 1, franchiseId: f1, eloPre: ELO_START, eloPost: 1550 }).run();
  // f2's most recent history is from the PRIOR season — resolvePreGameElo must apply the season
  // regression, not hand back 1450 verbatim.
  db.insert(eloHistory).values({ buildId: buildRow.id, season: SEASON - 1, week: 14, franchiseId: f2, eloPre: 1500, eloPost: 1450 }).run();

  // Slot calibration — matching src/server/stats/build.ts stage 7's shape.
  db.insert(slotScoringStats)
    .values([
      { buildId: buildRow.id, slot: "QB", mean: 18, variance: 36, sampleSize: 100, seasonMin: 2018, seasonMax: 2025 },
      { buildId: buildRow.id, slot: "RB", mean: 11, variance: 49, sampleSize: 100, seasonMin: 2018, seasonMax: 2025 },
      { buildId: buildRow.id, slot: "ALL", mean: 10, variance: 40, sampleSize: 900, seasonMin: 2018, seasonMax: 2025 },
    ])
    .run();

  // Roster: f1 has 1 QB already played, 1 RB remaining. f2 has 1 RB remaining only (no QB row at
  // all this week — exercises "slot never appears" as distinct from "0 remaining").
  seedPlayers(db, [101, 102, 201]);
  db.insert(rosterSlots)
    .values([
      { season: SEASON, week: WEEK, teamSeasonId: ts1, playerId: 101, lineupSlot: "QB", isStarter: true, points: 22, eligibleSlotsJson: ["QB"] },
      { season: SEASON, week: WEEK, teamSeasonId: ts1, playerId: 102, lineupSlot: "RB", isStarter: true, points: null, eligibleSlotsJson: ["RB"] },
      { season: SEASON, week: WEEK, teamSeasonId: ts2, playerId: 201, lineupSlot: "RB", isStarter: true, points: null, eligibleSlotsJson: ["RB"] },
    ])
    .run();
});

function seedPlayers(database: Db, ids: number[]): void {
  for (const id of ids) {
    database.insert(players).values({ espnPlayerId: id, fullName: `Player ${id}`, defaultPosition: "RB" }).onConflictDoNothing().run();
  }
}

afterAll(() => {
  sqlite.close();
});

describe("resolvePreGameElo", () => {
  it("returns the prior completed game's elo_post for a same-season history", () => {
    expect(resolvePreGameElo(db, f1, SEASON, WEEK)).toBe(1550);
  });

  it("applies the season-rollover regression when the only history is from a prior season", () => {
    const expected = ELO_START + (1450 - ELO_START) * ELO_SEASON_REGRESSION_FACTOR;
    expect(resolvePreGameElo(db, f2, SEASON, WEEK)).toBeCloseTo(expected, 10);
  });

  it("falls back to ELO_START for a franchise with no history at all", () => {
    expect(resolvePreGameElo(db, f3, SEASON, WEEK)).toBe(ELO_START);
  });

  it("never reads a same-week-or-later row (would leak the outcome of a still-undecided or future game)", () => {
    // Insert a row for week WEEK itself (f1's game this very week) — if resolvePreGameElo picked
    // this up it would leak the in-progress/future outcome; it must keep returning week 1's value.
    db.insert(eloHistory).values({ buildId, season: SEASON, week: WEEK, franchiseId: f1, eloPre: 1550, eloPost: 1999 }).run();
    expect(resolvePreGameElo(db, f1, SEASON, WEEK)).toBe(1550);
  });
});

describe("summarizeSlotProgress", () => {
  it("splits STARTER rows into remaining-by-slot vs played, dropping bench/IR rows entirely", () => {
    const rows: SlotProgressRow[] = [
      { teamSeasonId: 1, lineupSlot: "QB", isStarter: true, points: 22 },
      { teamSeasonId: 1, lineupSlot: "RB", isStarter: true, points: null },
      { teamSeasonId: 1, lineupSlot: "RB", isStarter: true, points: null },
      { teamSeasonId: 1, lineupSlot: "BE", isStarter: false, points: null },
      { teamSeasonId: 2, lineupSlot: "WR", isStarter: true, points: 5 },
    ];
    const result = summarizeSlotProgress(rows);
    expect(result.get(1)).toEqual({ remainingBySlot: { RB: 2 }, startersPlayed: 1 });
    expect(result.get(2)).toEqual({ remainingBySlot: {}, startersPlayed: 1 });
  });

  it("a team-season with no rows at all gets no map entry", () => {
    expect(summarizeSlotProgress([]).size).toBe(0);
  });
});

describe("getWinProbabilitiesForWeek", () => {
  it("excludes byes entirely — only the real 2-team matchup is returned", () => {
    const results = getWinProbabilitiesForWeek(SEASON, WEEK);
    expect(results.length).toBe(1);
    expect(results[0]!.home.franchiseId).toBe(f1);
    expect(results[0]!.away.franchiseId).toBe(f2);
  });

  it("home/away win probabilities are exact complements", () => {
    const [row] = getWinProbabilitiesForWeek(SEASON, WEEK);
    expect(row!.home.winProbability + row!.away.winProbability).toBeCloseTo(1, 10);
  });

  it("weekProgress reflects real starter counts: 1 played + 1 remaining (home) and 0 played + 1 remaining (away) = 1/3", () => {
    const [row] = getWinProbabilitiesForWeek(SEASON, WEEK);
    expect(row!.weekProgress).toBeCloseTo(1 / 3, 10);
  });

  it("home is favored: ahead on score (40-20), ahead on Elo (1550 vs a regressed ~1483), with real starters already in", () => {
    const [row] = getWinProbabilitiesForWeek(SEASON, WEEK);
    expect(row!.home.winProbability).toBeGreaterThan(0.5);
  });

  it("returns [] for a week with no matchups at all", () => {
    expect(getWinProbabilitiesForWeek(SEASON, 9)).toEqual([]);
  });

  it("getCurrentWeekWinProbabilities resolves to the same week getLatestMatchupWeek would and matches getWinProbabilitiesForWeek", () => {
    const direct = getWinProbabilitiesForWeek(SEASON, WEEK);
    const viaCurrent = getCurrentWeekWinProbabilities();
    expect(viaCurrent).toEqual(direct);
  });
});
