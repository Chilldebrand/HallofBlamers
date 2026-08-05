import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALIBRATION_POOLED_SLOT } from "@/engines";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import {
  achievements,
  allplayWeek,
  appSettings,
  beltMatches,
  beltReigns,
  careerStats,
  contextNotes,
  eloHistory,
  franchiseElo,
  franchises,
  h2hPairs,
  leagues,
  matchups,
  players,
  recordEntries,
  rosterSlots,
  seasonStats,
  seasons,
  slotScoringStats,
  statBuilds,
  teamSeasons,
  teamWeek,
  weeks,
  type NewMatchup,
  type NewRosterSlot,
} from "../../db/schema";
import { runStatBuild } from "../build";

const SEASON = 2024;

/** id=0(QB), 2(RB), 23(FLEX) starting; 20(BE)x3, 21(IR)x1 — per LINEUP_SLOT_MAP. */
const LINEUP_SLOT_COUNTS = { "0": 1, "2": 1, "23": 1, "20": 3, "21": 1 };

interface FixtureIds {
  franchiseId: Record<"T1" | "T2" | "T3" | "T4", number>;
  teamSeasonId: Record<"T1" | "T2" | "T3" | "T4", number>;
}

function seedPlayers(db: Db, ids: number[]): void {
  for (const id of ids) {
    db.insert(players)
      .values({ espnPlayerId: id, fullName: `Player ${id}`, defaultPosition: "RB" })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * Builds a 4-franchise, 3-week fixture (2 regular + 1 playoff):
 *  - week 1 (regular): T1 vs T2 (T1's lineup is deliberately SUBOPTIMAL — see below),
 *    T3 vs T4 (both "simple"/already-optimal rosters).
 *  - week 2 (regular): T1 vs T3, T2 vs T4 (all "simple"/already-optimal rosters).
 *  - week 3 (playoff): T1 vs T2, no roster_slots at all this week (like 2015-2017) — proves
 *    optimal_score/efficiency stay NULL even though the matchup is final.
 *
 * T1's week-1 roster is the FLEX-trap shape from src/engines/__fixtures__/optimalLineup.ts:
 * RB_A(20, RB+FLEX) started at FLEX, RB_C(15, RB+FLEX) started at RB, WR_B(18, FLEX-only)
 * benched — actual score 10(QB)+20(RB_A@FLEX)+15(RB_C@RB)=45; exact optimal is
 * 10+20(RB_A@RB)+18(WR_B@FLEX)=48, so efficiency should read 45/48, bench_points_left 3.
 */
function seedFixture(db: Db): FixtureIds {
  const league = db.insert(leagues).values({ espnLeagueId: 999, name: "Test League", firstSeason: SEASON }).returning().get();

  db.insert(seasons)
    .values({
      season: SEASON,
      leagueId: league.id,
      settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
      scoringJson: {},
      playoffFormatJson: {},
      teamCount: 4,
      regSeasonWeeks: 2,
      status: "complete",
    })
    .run();

  const franchiseId: Partial<FixtureIds["franchiseId"]> = {};
  const teamSeasonId: Partial<FixtureIds["teamSeasonId"]> = {};

  // T1 wins the week-3 playoff matchup and is given final_standing=1 (season champion) — feeds
  // stage 3-4's championship detection (belt reign 1, season_stats.champion, records'
  // highest_championship_score). wins/losses/ties/points deliberately do NOT match the fixture's
  // actual 2 regular-season games (real records are typically ESPN-reported, not derived from
  // team_week) — this proves season_stats copies team_seasons VERBATIM rather than recomputing
  // it, while still satisfying the "at least one game played" guard (see C1 fix round: an
  // "upcoming" season reports 0-0-0, which must never fabricate sacko/season-total records).
  const standings: Record<"T1" | "T2" | "T3" | "T4", { finalStanding: number; madePlayoffs: boolean; wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number }> = {
    T1: { finalStanding: 1, madePlayoffs: true, wins: 8, losses: 3, ties: 1, pointsFor: 1200, pointsAgainst: 1100 },
    T2: { finalStanding: 2, madePlayoffs: true, wins: 5, losses: 6, ties: 0, pointsFor: 1000, pointsAgainst: 1050 },
    T3: { finalStanding: 3, madePlayoffs: false, wins: 3, losses: 8, ties: 0, pointsFor: 900, pointsAgainst: 1200 },
    T4: { finalStanding: 4, madePlayoffs: false, wins: 6, losses: 5, ties: 1, pointsFor: 1100, pointsAgainst: 1000 },
  };

  for (const key of ["T1", "T2", "T3", "T4"] as const) {
    const f = db
      .insert(franchises)
      .values({ canonicalName: key, managerName: `${key} Manager`, joinedSeason: SEASON })
      .returning()
      .get();
    franchiseId[key] = f.id;

    const ts = db
      .insert(teamSeasons)
      .values({
        season: SEASON,
        franchiseId: f.id,
        espnTeamId: Number(key.slice(1)),
        teamName: key,
        wins: standings[key].wins,
        losses: standings[key].losses,
        ties: standings[key].ties,
        pointsFor: standings[key].pointsFor,
        pointsAgainst: standings[key].pointsAgainst,
        finalStanding: standings[key].finalStanding,
        madePlayoffs: standings[key].madePlayoffs,
      })
      .returning()
      .get();
    teamSeasonId[key] = ts.id;
  }

  db.insert(weeks)
    .values([
      { season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true },
      { season: SEASON, week: 2, scoringPeriodId: 2, weekType: "regular", isComplete: true },
      { season: SEASON, week: 3, scoringPeriodId: 3, weekType: "playoff", isComplete: true },
    ])
    .run();

  const ids = teamSeasonId as FixtureIds["teamSeasonId"];

  const matchupRows: NewMatchup[] = [
    // week 1
    { season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: ids.T1, awayTeamSeasonId: ids.T2, homeScore: 45, awayScore: 30, isFinal: true, winner: "home" },
    { season: SEASON, week: 1, espnMatchupId: 2, homeTeamSeasonId: ids.T3, awayTeamSeasonId: ids.T4, homeScore: 25, awayScore: 50, isFinal: true, winner: "away" },
    // week 2
    { season: SEASON, week: 2, espnMatchupId: 3, homeTeamSeasonId: ids.T1, awayTeamSeasonId: ids.T3, homeScore: 20, awayScore: 35, isFinal: true, winner: "away" },
    { season: SEASON, week: 2, espnMatchupId: 4, homeTeamSeasonId: ids.T2, awayTeamSeasonId: ids.T4, homeScore: 60, awayScore: 10, isFinal: true, winner: "home" },
    // week 3 (playoff, no roster data)
    { season: SEASON, week: 3, espnMatchupId: 5, homeTeamSeasonId: ids.T1, awayTeamSeasonId: ids.T2, homeScore: 55, awayScore: 44, isFinal: true, winner: "home" },
  ];
  db.insert(matchups).values(matchupRows).run();

  seedPlayers(db, [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31, 32, 33, 41, 42, 43]);

  const rosterRows: NewRosterSlot[] = [
    // T1 week 1 — the suboptimal lineup
    { season: SEASON, week: 1, teamSeasonId: ids.T1, playerId: 1, lineupSlot: "QB", isStarter: true, points: 10, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 1, teamSeasonId: ids.T1, playerId: 2, lineupSlot: "FLEX", isStarter: true, points: 20, eligibleSlotsJson: ["RB", "FLEX"] }, // RB_A, misplaced
    { season: SEASON, week: 1, teamSeasonId: ids.T1, playerId: 3, lineupSlot: "RB", isStarter: true, points: 15, eligibleSlotsJson: ["RB", "FLEX"] }, // RB_C
    { season: SEASON, week: 1, teamSeasonId: ids.T1, playerId: 4, lineupSlot: "BE", isStarter: false, points: 18, eligibleSlotsJson: ["FLEX"] }, // WR_B, benched

    // T2 week 1 — simple/forced (unique eligibility per slot => optimal == actual)
    { season: SEASON, week: 1, teamSeasonId: ids.T2, playerId: 11, lineupSlot: "QB", isStarter: true, points: 5, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 1, teamSeasonId: ids.T2, playerId: 12, lineupSlot: "RB", isStarter: true, points: 10, eligibleSlotsJson: ["RB"] },
    { season: SEASON, week: 1, teamSeasonId: ids.T2, playerId: 13, lineupSlot: "FLEX", isStarter: true, points: 15, eligibleSlotsJson: ["FLEX"] },

    // T3 week 1 — simple/forced
    { season: SEASON, week: 1, teamSeasonId: ids.T3, playerId: 21, lineupSlot: "QB", isStarter: true, points: 5, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 1, teamSeasonId: ids.T3, playerId: 22, lineupSlot: "RB", isStarter: true, points: 8, eligibleSlotsJson: ["RB"] },
    { season: SEASON, week: 1, teamSeasonId: ids.T3, playerId: 23, lineupSlot: "FLEX", isStarter: true, points: 12, eligibleSlotsJson: ["FLEX"] },

    // T4 week 1 — simple/forced
    { season: SEASON, week: 1, teamSeasonId: ids.T4, playerId: 31, lineupSlot: "QB", isStarter: true, points: 15, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 1, teamSeasonId: ids.T4, playerId: 32, lineupSlot: "RB", isStarter: true, points: 20, eligibleSlotsJson: ["RB"] },
    { season: SEASON, week: 1, teamSeasonId: ids.T4, playerId: 33, lineupSlot: "FLEX", isStarter: true, points: 15, eligibleSlotsJson: ["FLEX"] },

    // week 2 — every team "simple"/forced
    { season: SEASON, week: 2, teamSeasonId: ids.T1, playerId: 1, lineupSlot: "QB", isStarter: true, points: 5, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T1, playerId: 2, lineupSlot: "RB", isStarter: true, points: 7, eligibleSlotsJson: ["RB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T1, playerId: 3, lineupSlot: "FLEX", isStarter: true, points: 8, eligibleSlotsJson: ["FLEX"] },

    { season: SEASON, week: 2, teamSeasonId: ids.T3, playerId: 21, lineupSlot: "QB", isStarter: true, points: 10, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T3, playerId: 22, lineupSlot: "RB", isStarter: true, points: 10, eligibleSlotsJson: ["RB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T3, playerId: 23, lineupSlot: "FLEX", isStarter: true, points: 15, eligibleSlotsJson: ["FLEX"] },

    { season: SEASON, week: 2, teamSeasonId: ids.T2, playerId: 11, lineupSlot: "QB", isStarter: true, points: 20, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T2, playerId: 12, lineupSlot: "RB", isStarter: true, points: 20, eligibleSlotsJson: ["RB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T2, playerId: 13, lineupSlot: "FLEX", isStarter: true, points: 20, eligibleSlotsJson: ["FLEX"] },

    { season: SEASON, week: 2, teamSeasonId: ids.T4, playerId: 41, lineupSlot: "QB", isStarter: true, points: 2, eligibleSlotsJson: ["QB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T4, playerId: 42, lineupSlot: "RB", isStarter: true, points: 3, eligibleSlotsJson: ["RB"] },
    { season: SEASON, week: 2, teamSeasonId: ids.T4, playerId: 43, lineupSlot: "FLEX", isStarter: true, points: 5, eligibleSlotsJson: ["FLEX"] },
    // week 3 (playoff): deliberately NO roster_slots rows at all — proves the "no bench data"
    // NULL rule applies per-week, independent of the matchup being final.
  ];
  db.insert(rosterSlots).values(rosterRows).run();

  return { franchiseId: franchiseId as FixtureIds["franchiseId"], teamSeasonId: ids };
}

interface MinimalFixtureIds {
  franchiseId: Record<"T1" | "T2", number>;
  teamSeasonId: Record<"T1" | "T2", number>;
}

interface MinimalFixtureOptions {
  settingsJson?: unknown;
  isFinal?: boolean;
  winner?: "home" | "away" | "tie" | null;
  homeScore?: number;
  awayScore?: number;
  includeRoster?: boolean;
}

/** A 2-franchise, 1-matchup fixture for targeted stage-1 gating tests (completeness, settings parsing). */
function seedMinimalFixture(db: Db, opts: MinimalFixtureOptions = {}): MinimalFixtureIds {
  const league = db.insert(leagues).values({ espnLeagueId: 888, name: "Minimal League", firstSeason: SEASON }).returning().get();

  db.insert(seasons)
    .values({
      season: SEASON,
      leagueId: league.id,
      settingsJson: opts.settingsJson ?? { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
      scoringJson: {},
      playoffFormatJson: {},
      teamCount: 2,
      regSeasonWeeks: 1,
      status: "active",
    })
    .run();

  const franchiseId: Partial<MinimalFixtureIds["franchiseId"]> = {};
  const teamSeasonId: Partial<MinimalFixtureIds["teamSeasonId"]> = {};

  for (const key of ["T1", "T2"] as const) {
    const f = db.insert(franchises).values({ canonicalName: key, managerName: `${key} Manager`, joinedSeason: SEASON }).returning().get();
    franchiseId[key] = f.id;
    const ts = db
      .insert(teamSeasons)
      .values({
        season: SEASON,
        franchiseId: f.id,
        espnTeamId: Number(key.slice(1)),
        teamName: key,
        wins: 0,
        losses: 0,
        ties: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        madePlayoffs: false,
      })
      .returning()
      .get();
    teamSeasonId[key] = ts.id;
  }

  db.insert(weeks).values([{ season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: opts.isFinal ?? true }]).run();

  const ids = teamSeasonId as MinimalFixtureIds["teamSeasonId"];

  db.insert(matchups)
    .values({
      season: SEASON,
      week: 1,
      espnMatchupId: 1,
      homeTeamSeasonId: ids.T1,
      awayTeamSeasonId: ids.T2,
      homeScore: opts.homeScore ?? 33.5,
      awayScore: opts.awayScore ?? 28,
      isFinal: opts.isFinal ?? true,
      winner: opts.winner === undefined ? "home" : opts.winner,
    })
    .run();

  if (opts.includeRoster !== false) {
    seedPlayers(db, [101, 102]);
    db.insert(rosterSlots)
      .values([
        { season: SEASON, week: 1, teamSeasonId: ids.T1, playerId: 101, lineupSlot: "QB", isStarter: true, points: 20, eligibleSlotsJson: ["QB"] },
        { season: SEASON, week: 1, teamSeasonId: ids.T1, playerId: 102, lineupSlot: "RB", isStarter: true, points: 13.5, eligibleSlotsJson: ["RB"] },
      ])
      .run();
  }

  return { franchiseId: franchiseId as MinimalFixtureIds["franchiseId"], teamSeasonId: ids };
}

/**
 * The exact real-shaped boundary state (fix round 3): 14 regular weeks, ALL final with real
 * scores, but zero playoff-type weeks/matchups recorded at all — matching real 2026's CURRENT
 * actual state exactly (ESPN doesn't create playoff-week schedule rows until bracket seeding is
 * set). `playoff_format_json.matchupPeriods` extends to 17 (well past reg_season_weeks=14),
 * shaped exactly like every real archived season, proving a playoff round IS configured even
 * though no playoff-type row exists yet. `status` is caller-controlled so both the "correctly
 * derived" and "stale from before the normalize.ts fix" cases can be exercised.
 */
function seedBoundarySeasonFixture(db: Db, ids: FixtureIds, status: "active" | "complete"): number {
  const BOUNDARY_SEASON = SEASON + 2; // distinct from the mid-season (SEASON+1) fixture
  const league = db.select().from(leagues).all()[0]!;

  const matchupPeriods: Record<string, number[]> = {};
  for (let w = 1; w <= 17; w++) matchupPeriods[String(w)] = [w];

  db.insert(seasons)
    .values({
      season: BOUNDARY_SEASON,
      leagueId: league.id,
      settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
      scoringJson: {},
      playoffFormatJson: { matchupPeriods, matchupPeriodCount: 14, playoffTeamCount: 6 },
      teamCount: 4,
      regSeasonWeeks: 14,
      status,
    })
    .run();

  const boundaryTeamSeasonId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
  for (const key of ["T1", "T2", "T3", "T4"] as const) {
    const ts = db
      .insert(teamSeasons)
      .values({
        season: BOUNDARY_SEASON,
        franchiseId: ids.franchiseId[key],
        espnTeamId: Number(key.slice(1)) + 300,
        teamName: key,
        wins: 7,
        losses: 7,
        ties: 0,
        pointsFor: 1000,
        pointsAgainst: 1000,
        finalStanding: 0, // not yet determined — playoffs haven't happened
        madePlayoffs: false,
      })
      .returning()
      .get();
    boundaryTeamSeasonId[key] = ts.id;
  }

  const weekRows: (typeof weeks.$inferInsert)[] = [];
  const matchupRows: NewMatchup[] = [];
  for (let week = 1; week <= 14; week++) {
    weekRows.push({ season: BOUNDARY_SEASON, week, scoringPeriodId: week, weekType: "regular", isComplete: true });
    matchupRows.push({
      season: BOUNDARY_SEASON,
      week,
      espnMatchupId: week * 2 - 1,
      homeTeamSeasonId: boundaryTeamSeasonId.T1!,
      awayTeamSeasonId: boundaryTeamSeasonId.T2!,
      homeScore: 100 + week,
      awayScore: 90 + week,
      isFinal: true,
      winner: "home",
    });
    matchupRows.push({
      season: BOUNDARY_SEASON,
      week,
      espnMatchupId: week * 2,
      homeTeamSeasonId: boundaryTeamSeasonId.T3!,
      awayTeamSeasonId: boundaryTeamSeasonId.T4!,
      homeScore: 80 + week,
      awayScore: 95 + week,
      isFinal: true,
      winner: "away",
    });
  }
  db.insert(weeks).values(weekRows).run();
  db.insert(matchups).values(matchupRows).run();
  // Deliberately NO playoff-type week/matchup rows at all.

  return BOUNDARY_SEASON;
}

describe("runStatBuild", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-build-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("happy path", () => {
    let ids: FixtureIds;

    beforeEach(() => {
      ids = seedFixture(db);
    });

    it("computes team_week score/result/margin from the matchup and efficiency from the optimal lineup", () => {
      const result = runStatBuild(db);
      expect(result.status).toBe("ok");
      expect(result.buildId).not.toBeNull();

      const t1Week1 = db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, SEASON), eq(teamWeek.week, 1), eq(teamWeek.franchiseId, ids.franchiseId.T1)))
        .get()!;

      expect(t1Week1.score).toBe(45);
      expect(t1Week1.result).toBe("W");
      expect(t1Week1.margin).toBe(15); // 45 - 30
      expect(t1Week1.opponentFranchiseId).toBe(ids.franchiseId.T2);
      expect(t1Week1.optimalScore).toBe(48); // exact FLEX-trap optimum: 10 + 20(RB@RB) + 18(WR@FLEX)
      expect(t1Week1.benchPointsLeft).toBeCloseTo(3, 9);
      expect(t1Week1.efficiency).toBeCloseTo(45 / 48, 9);
      expect(t1Week1.eligibilityFallback).toBe(false);

      const t2Week1 = db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, SEASON), eq(teamWeek.week, 1), eq(teamWeek.franchiseId, ids.franchiseId.T2)))
        .get()!;
      expect(t2Week1.score).toBe(30);
      expect(t2Week1.result).toBe("L");
      expect(t2Week1.margin).toBe(-15);
      expect(t2Week1.optimalScore).toBe(30); // forced/unique assignment — already optimal
      expect(t2Week1.efficiency).toBeCloseTo(1, 9);
      expect(t2Week1.benchPointsLeft).toBeCloseTo(0, 9);
    });

    it("leaves optimal_score/bench_points_left/efficiency NULL for a final week with no roster_slots data", () => {
      runStatBuild(db);

      const t1Week3 = db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, SEASON), eq(teamWeek.week, 3), eq(teamWeek.franchiseId, ids.franchiseId.T1)))
        .get()!;

      expect(t1Week3.weekType).toBe("playoff");
      expect(t1Week3.result).toBe("W"); // still a real result — only efficiency is withheld
      expect(t1Week3.score).toBe(55);
      expect(t1Week3.optimalScore).toBeNull();
      expect(t1Week3.benchPointsLeft).toBeNull();
      expect(t1Week3.efficiency).toBeNull();
    });

    it("computes allplay_week wins/losses/ties for regular weeks only — playoff weeks get no allplay rows", () => {
      runStatBuild(db);

      const week1Rows = db.select().from(allplayWeek).where(and(eq(allplayWeek.season, SEASON), eq(allplayWeek.week, 1))).all();
      const byFranchise = new Map(week1Rows.map((r) => [r.franchiseId, r]));

      // scores week 1: T1=45, T2=30, T3=25, T4=50
      expect(byFranchise.get(ids.franchiseId.T1)).toMatchObject({ wins: 2, losses: 1, ties: 0 });
      expect(byFranchise.get(ids.franchiseId.T2)).toMatchObject({ wins: 1, losses: 2, ties: 0 });
      expect(byFranchise.get(ids.franchiseId.T3)).toMatchObject({ wins: 0, losses: 3, ties: 0 });
      expect(byFranchise.get(ids.franchiseId.T4)).toMatchObject({ wins: 3, losses: 0, ties: 0 });

      // T1 week 1: result=W, allPlayWins=2, opponents=3, margin=15 (not close) -> luck = 1 - 2/3
      expect(byFranchise.get(ids.franchiseId.T1)!.luckScore).toBeCloseTo(1 - 2 / 3, 9);

      const week3Rows = db.select().from(allplayWeek).where(and(eq(allplayWeek.season, SEASON), eq(allplayWeek.week, 3))).all();
      expect(week3Rows).toEqual([]);
    });

    it("tags every derived row with the build_id and returns matching row counts", () => {
      const result = runStatBuild(db);

      const allTeamWeekRows = db.select().from(teamWeek).all();
      const allAllplayRows = db.select().from(allplayWeek).all();

      expect(allTeamWeekRows.length).toBe(result.rowCounts.teamWeek);
      expect(allAllplayRows.length).toBe(result.rowCounts.allplayWeek);
      expect(allTeamWeekRows.every((r) => r.buildId === result.buildId)).toBe(true);
      expect(allAllplayRows.every((r) => r.buildId === result.buildId)).toBe(true);

      // week1: 2 matchups x 2 sides = 4; week2: 2 matchups x 2 sides = 4; week3 (playoff): 1
      // matchup x 2 sides = 2 -> 10 team_week rows total. allplay: weeks 1+2 (regular) only,
      // 4 franchises each = 8 rows; week 3 (playoff) contributes none.
      expect(allTeamWeekRows.length).toBe(10);
      expect(allAllplayRows.length).toBe(8);
    });

    it("running again with unchanged data is skipped and writes no new stat_builds row", () => {
      const first = runStatBuild(db);
      expect(first.status).toBe("ok");

      const buildCountBefore = db.select().from(statBuilds).all().length;
      const second = runStatBuild(db);

      expect(second.status).toBe("skipped");
      expect(second.buildId).toBe(first.buildId);
      const buildCountAfter = db.select().from(statBuilds).all().length;
      expect(buildCountAfter).toBe(buildCountBefore);
    });

    it("--force (or changed data) creates a new build and the old build_id's rows are entirely gone", () => {
      const first = runStatBuild(db);
      const firstRowsBefore = db.select().from(teamWeek).all();
      expect(firstRowsBefore.length).toBeGreaterThan(0);

      const forced = runStatBuild(db, { force: true });
      expect(forced.status).toBe("ok");
      expect(forced.buildId).not.toBe(first.buildId);

      const rowsWithOldBuildId = db.select().from(teamWeek).where(eq(teamWeek.buildId, first.buildId!)).all();
      expect(rowsWithOldBuildId).toEqual([]);

      const rowsWithNewBuildId = db.select().from(teamWeek).where(eq(teamWeek.buildId, forced.buildId!)).all();
      expect(rowsWithNewBuildId.length).toBe(firstRowsBefore.length);
    });

    it("a real data change (not just --force) also triggers a rebuild", () => {
      const first = runStatBuild(db);

      db.update(matchups)
        .set({ homeScore: 999 })
        .where(and(eq(matchups.season, SEASON), eq(matchups.week, 1), eq(matchups.espnMatchupId, 1)))
        .run();

      const second = runStatBuild(db);
      expect(second.status).toBe("ok");
      expect(second.buildId).not.toBe(first.buildId);
    });

    it("regression (C1): correcting ONLY settings_json triggers a fresh rebuild (not skipped) and efficiency reflects the new slot counts", () => {
      // seasons.season IS the primary key (rowid = season), so a settings_json-only correction
      // bumps neither row count nor max(rowid) the way every other digested table's autoincrement
      // surrogate does — the digest must read the JSON content itself or this change is invisible.
      const first = runStatBuild(db);
      expect(first.status).toBe("ok");

      const t1Week1Before = db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, SEASON), eq(teamWeek.week, 1), eq(teamWeek.franchiseId, ids.franchiseId.T1)))
        .get()!;
      expect(t1Week1Before.efficiency).toBeCloseTo(45 / 48, 9);

      // Touch ONLY settings_json — drop FLEX, add a second RB slot. Deliberately a same-width
      // digit swap (RB 1->2, FLEX 1->0, everything else unchanged) so `length(settings_json)`
      // stays IDENTICAL — this is the exact shape of correction that escaped a length-based digest
      // (verified against real 2024 data before landing the full-content-hash fix). matchups,
      // roster_slots, team_seasons, and corrections are all left untouched.
      const NEW_LINEUP_SLOT_COUNTS = { "0": 1, "2": 2, "23": 0, "20": 3, "21": 1 };
      db.update(seasons)
        .set({ settingsJson: { rosterSettings: { lineupSlotCounts: NEW_LINEUP_SLOT_COUNTS } } })
        .where(eq(seasons.season, SEASON))
        .run();

      const second = runStatBuild(db); // deliberately no { force: true }
      expect(second.status).toBe("ok"); // must NOT be 'skipped'
      expect(second.buildId).not.toBe(first.buildId);

      const t1Week1After = db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, SEASON), eq(teamWeek.week, 1), eq(teamWeek.franchiseId, ids.franchiseId.T1)))
        .get()!;
      // With {QB:1, RB:2} instead of {QB:1, RB:1, FLEX:1}: WR_B (FLEX-only-eligible) is no longer
      // usable at all; RB_A and RB_C (both RB-eligible) fill the two RB slots: 10+20+15=45,
      // exactly matching the actual score — efficiency should now read 1.0, not 45/48.
      expect(t1Week1After.optimalScore).toBe(45);
      expect(t1Week1After.efficiency).toBeCloseTo(1, 9);
      expect(t1Week1After.benchPointsLeft).toBeCloseTo(0, 9);
    });

    it("regression (C2): correcting ONLY a matchup's playoff_tier triggers a fresh rebuild (not skipped)", () => {
      // matchups DO get fresh autoincrement ids on a full re-normalize, so max(rowid) alone would
      // catch that — but a narrower, direct playoff_tier-only correction (e.g. a future
      // corrections-only fix that never touches scores) is the same class of gap Task 6's C1 fix
      // round found for `seasons`. Stage 3-4 reads playoff_tier for Elo K-factor/belt-at-stake/
      // streak-and-h2h classification and the championship-detection fallback — a real new
      // dependency Stage 0-2's original matchups digest (scores + is_final) never covered.
      const first = runStatBuild(db);
      expect(first.status).toBe("ok");

      db.update(matchups)
        .set({ playoffTier: "WINNERS_CONSOLATION_LADDER" })
        .where(and(eq(matchups.season, SEASON), eq(matchups.week, 3), eq(matchups.espnMatchupId, 5)))
        .run();

      const second = runStatBuild(db); // deliberately no { force: true }
      expect(second.status).toBe("ok"); // must NOT be 'skipped'
      expect(second.buildId).not.toBe(first.buildId);
    });

    it("regression (fix round 1, I2): renaming ONLY a franchise's canonical_name triggers a fresh rebuild (not skipped)", () => {
      // franchises.id is an autoincrement surrogate, but a RENAME (UPDATE, same row) changes
      // neither the row count nor max(rowid) — same blind spot seasons/app_settings/
      // matchups.playoff_tier already had before their own digest fixes. Stage 5 (Task 12) is the
      // FIRST stage to ever need franchise names (baked verbatim into context_notes.rendered_text
      // for h2h/belt/career-milestone notes) — a real production case: the controller's own
      // "AB Kills  Billy" -> "AB Kills Billy" canonicalName correction is exactly this shape.
      const first = runStatBuild(db);
      expect(first.status).toBe("ok");

      db.update(franchises).set({ canonicalName: "T1 Renamed" }).where(eq(franchises.id, ids.franchiseId.T1)).run();

      const second = runStatBuild(db); // deliberately no { force: true }
      expect(second.status).toBe("ok"); // must NOT be 'skipped'
      expect(second.buildId).not.toBe(first.buildId);
    });
  });

  describe("stage 1 gating (completeness, settings parsing)", () => {
    it("an unfinished matchup gets a team_week row with score-so-far, but result/optimal_score/bench_points_left/efficiency all NULL", () => {
      // includeRoster: true on purpose — proves it's specifically the isFinal gate withholding
      // efficiency, not an absence of roster_slots data (that's covered by a separate test).
      const ids = seedMinimalFixture(db, { isFinal: false, winner: null, homeScore: 33.5, awayScore: 28, includeRoster: true });

      const result = runStatBuild(db);
      expect(result.status).toBe("ok");

      const t1 = db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, SEASON), eq(teamWeek.week, 1), eq(teamWeek.franchiseId, ids.franchiseId.T1)))
        .get()!;

      expect(t1.score).toBe(33.5); // score-so-far, populated regardless of finality
      expect(t1.result).toBeNull();
      expect(t1.optimalScore).toBeNull();
      expect(t1.benchPointsLeft).toBeNull();
      expect(t1.efficiency).toBeNull();
      expect(t1.eligibilityFallback).toBe(false);
    });

    it("a season with unparseable settings_json warns and leaves efficiency NULL for that season, despite roster data existing", () => {
      // settingsJson has no `rosterSettings` at all — includeRoster: true proves it's specifically
      // the settings-parsing failure withholding efficiency, not missing roster_slots data.
      const ids = seedMinimalFixture(db, { settingsJson: {}, includeRoster: true });

      const result = runStatBuild(db);
      expect(result.status).toBe("ok");
      expect(result.warnings.some((w) => w.includes(String(SEASON)) && w.includes("lineupSlotCounts"))).toBe(true);

      const t1 = db
        .select()
        .from(teamWeek)
        .where(and(eq(teamWeek.season, SEASON), eq(teamWeek.week, 1), eq(teamWeek.franchiseId, ids.franchiseId.T1)))
        .get()!;

      expect(t1.result).toBe("W"); // the matchup IS final — only efficiency is withheld
      expect(t1.optimalScore).toBeNull();
      expect(t1.benchPointsLeft).toBeNull();
      expect(t1.efficiency).toBeNull();
    });
  });

  describe("stage 3-4 (chronological replay + rollups)", () => {
    let ids: FixtureIds;

    beforeEach(() => {
      ids = seedFixture(db);
    });

    it("belt: T1 (final_standing=1 at the week-3 championship) is crowned reign 1 — no belt_matches exist since this fixture's only season ends at the coronation", () => {
      runStatBuild(db);

      const reigns = db.select().from(beltReigns).all();
      expect(reigns).toHaveLength(1);
      expect(reigns[0]).toMatchObject({
        reignNo: 1,
        franchiseId: ids.franchiseId.T1,
        wonFromFranchiseId: null,
        startSeason: SEASON,
        startWeek: 3,
        isCurrent: true,
        endSeason: null,
        defenses: 0,
      });

      // No games happen AFTER the week-3 coronation in this fixture, so nothing was ever at stake.
      expect(db.select().from(beltMatches).all()).toEqual([]);
    });

    it("elo_history: one pre/post row per franchise per completed matchup, all finite, no NaN", () => {
      runStatBuild(db);
      const rows = db.select().from(eloHistory).all();
      // 5 matchups (2 in week1, 2 in week2, 1 in week3), none are byes -> 10 rows (2 sides each).
      expect(rows).toHaveLength(10);
      for (const r of rows) {
        expect(Number.isFinite(r.eloPre)).toBe(true);
        expect(Number.isFinite(r.eloPost)).toBe(true);
      }

      const franchiseRows = db.select().from(franchiseElo).all();
      expect(franchiseRows).toHaveLength(4); // T1-T4 all played
      for (const f of franchiseRows) {
        expect(Number.isFinite(f.current)).toBe(true);
        expect(f.peak).toBeGreaterThanOrEqual(f.trough);
      }
    });

    it("season_stats: champion/sacko flags derive from final_standing, wins/losses/points_for come straight from team_seasons", () => {
      runStatBuild(db);
      const rows = db.select().from(seasonStats).where(eq(seasonStats.season, SEASON)).all();
      expect(rows).toHaveLength(4);

      const t1 = rows.find((r) => r.franchiseId === ids.franchiseId.T1)!;
      expect(t1.champion).toBe(true);
      expect(t1.sacko).toBe(false);
      expect(t1.finalStanding).toBe(1);
      expect(t1.madePlayoffs).toBe(true);
      // seedFixture's team_seasons wins/pointsFor (8, 1200) deliberately don't match the fixture's
      // actual 2 regular-season games — season_stats must copy them verbatim, not recompute from
      // team_week results.
      expect(t1.wins).toBe(8);
      expect(t1.pointsFor).toBe(1200);

      const t4 = rows.find((r) => r.franchiseId === ids.franchiseId.T4)!;
      expect(t4.champion).toBe(false);
      expect(t4.sacko).toBe(true); // final_standing=4, the max (worst) this season
    });

    it("career_stats: aggregates season_stats 1:1 for a single-season franchise, and carries elo/streak summaries", () => {
      runStatBuild(db);
      const seasonRow = db
        .select()
        .from(seasonStats)
        .where(and(eq(seasonStats.season, SEASON), eq(seasonStats.franchiseId, ids.franchiseId.T1)))
        .get()!;
      const careerRow = db.select().from(careerStats).where(eq(careerStats.franchiseId, ids.franchiseId.T1)).get()!;

      expect(careerRow.seasons).toBe(1);
      expect(careerRow.wins).toBe(seasonRow.wins); // career wins = Sum(season wins), trivially 1:1 here
      expect(careerRow.pointsFor).toBe(seasonRow.pointsFor);
      expect(careerRow.championships).toBe(1);
      expect(careerRow.playoffAppearances).toBe(1);
      expect(careerRow.bestFinish).toBe(1);
      expect(careerRow.worstFinish).toBe(1);
      expect(Number.isFinite(careerRow.currentElo)).toBe(true);
      expect(careerRow.currentElo).not.toBe(1500); // T1 played games and won some
    });

    it("record_entries: highest_week_score rank 1 is the actual highest team_week score in the fixture (T2, week 2, 60)", () => {
      runStatBuild(db);
      const top = db
        .select()
        .from(recordEntries)
        .where(and(eq(recordEntries.recordKey, "highest_week_score"), eq(recordEntries.rank, 1)))
        .all();
      expect(top).toHaveLength(1);
      expect(top[0]).toMatchObject({ franchiseId: ids.franchiseId.T2, season: SEASON, week: 2, value: 60 });
    });

    it("h2h_pairs: T1 vs T2 met twice (regular week 1, playoff week 3), T1 won both", () => {
      runStatBuild(db);
      const pair = db
        .select()
        .from(h2hPairs)
        .where(and(eq(h2hPairs.franchiseA, Math.min(ids.franchiseId.T1, ids.franchiseId.T2)), eq(h2hPairs.franchiseB, Math.max(ids.franchiseId.T1, ids.franchiseId.T2))))
        .get()!;

      // franchiseA is whichever of T1/T2 has the lower id — orient the expected W/L to match.
      const aIsT1 = pair.franchiseA === ids.franchiseId.T1;
      expect(pair.regW).toBe(aIsT1 ? 1 : 0);
      expect(pair.regL).toBe(aIsT1 ? 0 : 1);
      expect(pair.playoffW).toBe(aIsT1 ? 1 : 0);
      expect(pair.playoffL).toBe(aIsT1 ? 0 : 1);
    });

    it("cross-consistency: every belt_match references a real matchup, and every reign's defenses match its belt_matches", () => {
      runStatBuild(db);
      const matchupIds = new Set(db.select().from(matchups).all().map((m) => m.id));
      const bmRows = db.select().from(beltMatches).all();
      expect(bmRows.every((bm) => matchupIds.has(bm.matchupId))).toBe(true);

      const ordinal = (season: number, week: number) => season * 100 + week;
      for (const reign of db.select().from(beltReigns).all()) {
        const startOrd = ordinal(reign.startSeason, reign.startWeek);
        const endOrd = reign.endSeason !== null ? ordinal(reign.endSeason, reign.endWeek!) : Infinity;
        const inSpan = bmRows.filter((bm) => bm.holderFranchiseId === reign.franchiseId && ordinal(bm.season, bm.week) >= startOrd && ordinal(bm.season, bm.week) <= endOrd);
        expect(reign.defenses).toBe(inSpan.filter((bm) => bm.result === "defense").length);
      }
    });

    it("app_settings belt_overrides: an override at week 1 (before the natural week-3 coronation) preempts it and is really read from app_settings, not just layered on top", () => {
      // Placed BEFORE T1's natural week-3 coronation on purpose. T3 (the override holder) then
      // plays T4 that SAME week and loses (25-50) — a genuine transfer, not a coronation game —
      // and the belt keeps cascading through the rest of the fixture's results: T4 loses to T2 in
      // week 2 (10-60), then T2 loses to T1 in the week-3 "coronation" matchup (44-55), which is
      // therefore itself a real transfer TO T1, not T1's natural (preempted) coronation.
      const overrides = [{ season: SEASON, week: 1, franchiseId: ids.franchiseId.T3, reason: "test override" }];
      db.insert(appSettings).values({ key: "belt_overrides", valueJson: overrides, updatedAt: new Date() }).run();

      const result = runStatBuild(db); // no --force — app_settings content itself changed the hash
      expect(result.status).toBe("ok");

      const reigns = db.select().from(beltReigns).orderBy(beltReigns.reignNo).all();
      expect(reigns).toHaveLength(4);
      expect(reigns[0]).toMatchObject({ franchiseId: ids.franchiseId.T3, wonFromFranchiseId: null, startWeek: 1, endReason: "lost" });
      expect(reigns[1]).toMatchObject({ franchiseId: ids.franchiseId.T4, wonFromFranchiseId: ids.franchiseId.T3, startWeek: 1, endReason: "lost" });
      expect(reigns[2]).toMatchObject({ franchiseId: ids.franchiseId.T2, wonFromFranchiseId: ids.franchiseId.T4, startWeek: 2, endReason: "lost" });
      expect(reigns[3]).toMatchObject({ franchiseId: ids.franchiseId.T1, wonFromFranchiseId: ids.franchiseId.T2, startWeek: 3, isCurrent: true });

      const bm = db.select().from(beltMatches).all();
      expect(bm).toHaveLength(3);
      expect(bm.every((r) => r.result === "transfer")).toBe(true);
    });

    it("regression (I1): record_entries stores the REFINED week_type ('consolation'), even though eligibility uses the coarse 'playoff' split", () => {
      // Reclassify the week-3 matchup as a real consolation-bracket game — its raw week_type (per
      // the `weeks` table) stays 'playoff', only playoff_tier changes. Mirrors the real 187.7
      // Pat's Moms All-Stars game: coarse-eligible (still ranked), refined-labeled (honest UI caption).
      db.update(matchups)
        .set({ playoffTier: "LOSERS_CONSOLATION_LADDER" })
        .where(and(eq(matchups.season, SEASON), eq(matchups.week, 3), eq(matchups.espnMatchupId, 5)))
        .run();

      runStatBuild(db);

      const t1Week3Entry = db
        .select()
        .from(recordEntries)
        .where(
          and(
            eq(recordEntries.recordKey, "highest_week_score"),
            eq(recordEntries.franchiseId, ids.franchiseId.T1),
            eq(recordEntries.season, SEASON),
            eq(recordEntries.week, 3),
          ),
        )
        .get()!;

      expect(t1Week3Entry).toBeTruthy(); // still eligible/ranked
      expect(t1Week3Entry.value).toBe(55);
      expect(t1Week3Entry.weekType).toBe("consolation"); // but honestly labeled
    });

    it("regression (C1): an 'upcoming' season (0-0-0 records, final_standing=0 placeholders, an unplayed matchup) fabricates NO sacko, NO record entries, and leaves career_stats unchanged", () => {
      runStatBuild(db);
      const careerBefore = db.select().from(careerStats).where(eq(careerStats.franchiseId, ids.franchiseId.T1)).get()!;

      // Mirrors the real 2026 season shape exactly: scheduled-but-unplayed matchup, 0-0-0 record,
      // final_standing=0 ESPN placeholder (not null) for every team.
      const UPCOMING_SEASON = SEASON + 1;
      const league = db.select().from(leagues).all()[0]!;
      db.insert(seasons)
        .values({
          season: UPCOMING_SEASON,
          leagueId: league.id,
          settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
          scoringJson: {},
          playoffFormatJson: {},
          teamCount: 4,
          regSeasonWeeks: 14,
          status: "upcoming",
        })
        .run();

      const upcomingTeamSeasonId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
      for (const key of ["T1", "T2", "T3", "T4"] as const) {
        const ts = db
          .insert(teamSeasons)
          .values({
            season: UPCOMING_SEASON,
            franchiseId: ids.franchiseId[key],
            espnTeamId: Number(key.slice(1)) + 100,
            teamName: key,
            wins: 0,
            losses: 0,
            ties: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            finalStanding: 0, // ESPN's real placeholder — NOT null
            madePlayoffs: false,
          })
          .returning()
          .get();
        upcomingTeamSeasonId[key] = ts.id;
      }

      db.insert(weeks).values([{ season: UPCOMING_SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: false }]).run();
      db.insert(matchups)
        .values({
          season: UPCOMING_SEASON,
          week: 1,
          espnMatchupId: 1,
          homeTeamSeasonId: upcomingTeamSeasonId.T1!,
          awayTeamSeasonId: upcomingTeamSeasonId.T2!,
          homeScore: 0,
          awayScore: 0,
          isFinal: false,
          winner: null,
        })
        .run();

      const result = runStatBuild(db, { force: true });
      expect(result.status).toBe("ok");

      const upcomingSeasonStats = db.select().from(seasonStats).where(eq(seasonStats.season, UPCOMING_SEASON)).all();
      expect(upcomingSeasonStats.length).toBeGreaterThan(0); // honest 0-0-0 rows exist...
      expect(upcomingSeasonStats.every((r) => r.sacko === false)).toBe(true); // ...but never fabricate sacko
      expect(upcomingSeasonStats.every((r) => r.champion === false)).toBe(true);

      const recordsFromUpcoming = db.select().from(recordEntries).where(eq(recordEntries.season, UPCOMING_SEASON)).all();
      expect(recordsFromUpcoming).toEqual([]);

      const careerAfter = db.select().from(careerStats).where(eq(careerStats.franchiseId, ids.franchiseId.T1)).get()!;
      expect(careerAfter.seasons).toBe(careerBefore.seasons); // still 1, NOT 2
      expect(careerAfter.wins).toBe(careerBefore.wins);
      expect(careerAfter.pointsFor).toBe(careerBefore.pointsFor);
      expect(careerAfter.bestFinish).toBe(careerBefore.bestFinish);
      expect(careerAfter.worstFinish).toBe(careerBefore.worstFinish); // not corrupted to 0 by the placeholder
      expect(careerAfter.lowestWeek).toBe(careerBefore.lowestWeek); // not overwritten to the unplayed week's 0
      expect(careerAfter.highestWeek).toBe(careerBefore.highestWeek);
    });

    it("regression (fix round 2): an ACTIVE mid-season (real games played, final_standing=0 for the WHOLE season, some weeks still unplayed) fabricates no sacko/champion/season-totals, but DOES let its completed weeks enter the live record book, and DOES count toward career seasons", () => {
      runStatBuild(db);
      const careerBefore = db.select().from(careerStats).where(eq(careerStats.franchiseId, ids.franchiseId.T1)).get()!;

      // Mirrors the re-reviewer's exact repro: 2026-shaped, but ACTIVE with week 1 already played
      // — final_standing stays the ESPN placeholder (0) for the WHOLE season, not just before it
      // starts, so a "has this team played anything" proxy (wins+losses+ties>0) is NOT enough.
      const MID_SEASON = SEASON + 1;
      const league = db.select().from(leagues).all()[0]!;
      db.insert(seasons)
        .values({
          season: MID_SEASON,
          leagueId: league.id,
          settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
          scoringJson: {},
          playoffFormatJson: {},
          teamCount: 4,
          regSeasonWeeks: 14,
          status: "active",
        })
        .run();

      // Week 1 scores (120/90/110/95) are deliberately higher than anything in the 2024 fixture
      // (max 60) — proves week-scope records genuinely pick up a live, in-progress season's
      // completed games, not just historical complete ones.
      const midSeasonRecord: Record<"T1" | "T2" | "T3" | "T4", { wins: number; losses: number; pointsFor: number; pointsAgainst: number }> = {
        T1: { wins: 1, losses: 0, pointsFor: 120, pointsAgainst: 90 },
        T2: { wins: 0, losses: 1, pointsFor: 90, pointsAgainst: 120 },
        T3: { wins: 1, losses: 0, pointsFor: 110, pointsAgainst: 95 },
        T4: { wins: 0, losses: 1, pointsFor: 95, pointsAgainst: 110 },
      };
      const midTeamSeasonId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
      for (const key of ["T1", "T2", "T3", "T4"] as const) {
        const ts = db
          .insert(teamSeasons)
          .values({
            season: MID_SEASON,
            franchiseId: ids.franchiseId[key],
            espnTeamId: Number(key.slice(1)) + 200,
            teamName: key,
            wins: midSeasonRecord[key].wins,
            losses: midSeasonRecord[key].losses,
            ties: 0,
            pointsFor: midSeasonRecord[key].pointsFor,
            pointsAgainst: midSeasonRecord[key].pointsAgainst,
            finalStanding: 0, // ESPN's real placeholder — stays 0 for the WHOLE active season
            madePlayoffs: false,
          })
          .returning()
          .get();
        midTeamSeasonId[key] = ts.id;
      }

      db.insert(weeks)
        .values([
          { season: MID_SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true },
          { season: MID_SEASON, week: 2, scoringPeriodId: 2, weekType: "regular", isComplete: false },
        ])
        .run();

      db.insert(matchups)
        .values([
          { season: MID_SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: midTeamSeasonId.T1!, awayTeamSeasonId: midTeamSeasonId.T2!, homeScore: 120, awayScore: 90, isFinal: true, winner: "home" },
          { season: MID_SEASON, week: 1, espnMatchupId: 2, homeTeamSeasonId: midTeamSeasonId.T3!, awayTeamSeasonId: midTeamSeasonId.T4!, homeScore: 110, awayScore: 95, isFinal: true, winner: "home" },
          { season: MID_SEASON, week: 2, espnMatchupId: 3, homeTeamSeasonId: midTeamSeasonId.T1!, awayTeamSeasonId: midTeamSeasonId.T3!, homeScore: 0, awayScore: 0, isFinal: false, winner: null },
          { season: MID_SEASON, week: 2, espnMatchupId: 4, homeTeamSeasonId: midTeamSeasonId.T2!, awayTeamSeasonId: midTeamSeasonId.T4!, homeScore: 0, awayScore: 0, isFinal: false, winner: null },
        ])
        .run();

      const result = runStatBuild(db, { force: true });
      expect(result.status).toBe("ok");

      // Zero sacko/champion — final_standing=0 is never real, even mid-season with real records.
      const midSeasonStats = db.select().from(seasonStats).where(eq(seasonStats.season, MID_SEASON)).all();
      expect(midSeasonStats).toHaveLength(4);
      expect(midSeasonStats.every((r) => r.sacko === false)).toBe(true);
      expect(midSeasonStats.every((r) => r.champion === false)).toBe(true);

      // Zero SEASON-scope record entries for this season (partial totals must never rank).
      const seasonScopeKeys = ["highest_season_total", "lowest_season_total", "best_season_record", "worst_season_record", "most_season_points_against"] as const;
      for (const key of seasonScopeKeys) {
        const rows = db.select().from(recordEntries).where(and(eq(recordEntries.recordKey, key), eq(recordEntries.season, MID_SEASON))).all();
        expect(rows).toEqual([]);
      }

      // WEEK-scope records DO include the season's completed week 1 games — live record-watch.
      const highestWeekScore = db
        .select()
        .from(recordEntries)
        .where(and(eq(recordEntries.recordKey, "highest_week_score"), eq(recordEntries.rank, 1)))
        .get()!;
      expect(highestWeekScore).toMatchObject({ franchiseId: ids.franchiseId.T1, season: MID_SEASON, week: 1, value: 120 });

      // career_stats.bestFinish unaffected by the 0 placeholder; seasons count DOES include the
      // active season (ruling 5 — wins/points already accumulate live, this is correct).
      const careerAfter = db.select().from(careerStats).where(eq(careerStats.franchiseId, ids.franchiseId.T1)).get()!;
      expect(careerAfter.bestFinish).toBe(careerBefore.bestFinish); // still 1, not corrupted to 0
      expect(careerAfter.worstFinish).toBe(careerBefore.worstFinish);
      expect(careerAfter.seasons).toBe(careerBefore.seasons + 1); // 2024 + the active 2025
      expect(careerAfter.wins).toBe(careerBefore.wins + 1); // T1's live mid-season win counts
    });

    it("regression (fix round 3, boundary state a): 14 regular weeks all final, zero playoff-type rows recorded, status correctly 'active' — zero season-scope records, zero sacko/champion, week-scope still populates", () => {
      const BOUNDARY_SEASON = seedBoundarySeasonFixture(db, ids, "active");
      const result = runStatBuild(db, { force: true });
      expect(result.status).toBe("ok");

      const boundarySeasonStats = db.select().from(seasonStats).where(eq(seasonStats.season, BOUNDARY_SEASON)).all();
      expect(boundarySeasonStats).toHaveLength(4);
      expect(boundarySeasonStats.every((r) => r.sacko === false)).toBe(true);
      expect(boundarySeasonStats.every((r) => r.champion === false)).toBe(true);

      const seasonScopeKeys = ["highest_season_total", "lowest_season_total", "best_season_record", "worst_season_record", "most_season_points_against"] as const;
      for (const key of seasonScopeKeys) {
        const rows = db.select().from(recordEntries).where(and(eq(recordEntries.recordKey, key), eq(recordEntries.season, BOUNDARY_SEASON))).all();
        expect(rows).toEqual([]);
      }

      // Week-scope records still pick up the 14 completed weeks' games — live record-watch unaffected.
      const weekScopeRows = db.select().from(recordEntries).where(and(eq(recordEntries.recordKey, "highest_week_score"), eq(recordEntries.season, BOUNDARY_SEASON))).all();
      expect(weekScopeRows.length).toBeGreaterThan(0);
    });

    it("regression (fix round 3, boundary state b): the SAME boundary state but with a STALE status='complete' (simulating pre-normalize.ts-fix data) — build.ts's OWN structural check independently withholds season-scope records", () => {
      const BOUNDARY_SEASON = seedBoundarySeasonFixture(db, ids, "complete"); // deliberately stale/wrong
      const result = runStatBuild(db, { force: true });
      expect(result.status).toBe("ok");

      const boundarySeasonStats = db.select().from(seasonStats).where(eq(seasonStats.season, BOUNDARY_SEASON)).all();
      expect(boundarySeasonStats.every((r) => r.sacko === false)).toBe(true);
      expect(boundarySeasonStats.every((r) => r.champion === false)).toBe(true);

      const seasonScopeKeys = ["highest_season_total", "lowest_season_total", "best_season_record", "worst_season_record", "most_season_points_against"] as const;
      for (const key of seasonScopeKeys) {
        const rows = db.select().from(recordEntries).where(and(eq(recordEntries.recordKey, key), eq(recordEntries.season, BOUNDARY_SEASON))).all();
        expect(rows).toEqual([]);
      }

      expect(
        result.warnings.some((w) => w.includes(String(BOUNDARY_SEASON)) && w.includes("playoff") && w.toLowerCase().includes("not complete")),
      ).toBe(true);
    });

    it("sunny path unaffected: a genuinely complete historical season (real playoff week, all its matchups final) still populates season-scope records normally", () => {
      runStatBuild(db);
      const seasonScopeKeys = ["highest_season_total", "lowest_season_total", "best_season_record", "worst_season_record", "most_season_points_against"] as const;
      for (const key of seasonScopeKeys) {
        const rows = db.select().from(recordEntries).where(and(eq(recordEntries.recordKey, key), eq(recordEntries.season, SEASON))).all();
        expect(rows.length).toBeGreaterThan(0);
      }
    });

    it("Task 17 — 'Beatdown of the Week': season_stats/career_stats counts + career worst-beatdown columns, from the fixture's real per-week worst losses", () => {
      // Fixture losses/margins (real, from the same 10 team-weeks the record_entries tests above
      // already validate): week1 T2(-15)/T3(-25) -> T3 worst; week2 T1(-15)/T4(-50) -> T4 worst;
      // week3(playoff) T2(-11) only -> T2 worst (playoff losses ARE eligible). T1 never takes the
      // weekly award at all (0-0-0 in this fixture — every one of its 2 losses lost the tiebreak
      // to a worse loss that same week).
      runStatBuild(db);

      const seasonRows = db.select().from(seasonStats).where(eq(seasonStats.season, SEASON)).all();
      const beatdownsByFranchise = new Map(seasonRows.map((r) => [r.franchiseId, r.beatdowns]));
      expect(beatdownsByFranchise.get(ids.franchiseId.T1)).toBe(0);
      expect(beatdownsByFranchise.get(ids.franchiseId.T2)).toBe(1);
      expect(beatdownsByFranchise.get(ids.franchiseId.T3)).toBe(1);
      expect(beatdownsByFranchise.get(ids.franchiseId.T4)).toBe(1);

      const careerT4 = db.select().from(careerStats).where(eq(careerStats.franchiseId, ids.franchiseId.T4)).get()!;
      expect(careerT4.beatdowns).toBe(1);
      expect(careerT4.worstBeatdownMargin).toBeCloseTo(-50, 9);
      expect(careerT4.worstBeatdownSeason).toBe(SEASON);
      expect(careerT4.worstBeatdownWeek).toBe(2);

      const careerT1 = db.select().from(careerStats).where(eq(careerStats.franchiseId, ids.franchiseId.T1)).get()!;
      expect(careerT1.beatdowns).toBe(0);
      expect(careerT1.worstBeatdownMargin).toBeNull();
      expect(careerT1.worstBeatdownSeason).toBeNull();
      expect(careerT1.worstBeatdownWeek).toBeNull();
    });

    it("Task 17 — record_entries 'worst_beatdown': ranked by margin ascending (worst/most-negative first), attributed to the LOSER", () => {
      runStatBuild(db);
      const rows = db.select().from(recordEntries).where(eq(recordEntries.recordKey, "worst_beatdown")).orderBy(recordEntries.rank).all();
      // T4's week-2 loss (60-10, margin -50) is the single worst beatdown across the whole fixture.
      expect(rows[0]).toMatchObject({ franchiseId: ids.franchiseId.T4, season: SEASON, week: 2, value: -50, rank: 1 });
      expect(rows[0]!.detailJson).toMatchObject({ winnerFranchiseId: ids.franchiseId.T2, winnerScore: 60, loserScore: 10 });
    });
  });

  describe("stage 5 (context notes)", () => {
    let ids: FixtureIds;

    beforeEach(() => {
      ids = seedFixture(db);
    });

    it("produces context_notes rows tagged with the build_id, matching the returned row count", () => {
      const result = runStatBuild(db);
      const rows = db.select().from(contextNotes).all();
      expect(rows.length).toBe(result.rowCounts.contextNotes);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.buildId === result.buildId)).toBe(true);
    });

    it("Task 17 — beatdown_of_week's 3 weekly awards are correctly computed (proven via season_stats.beatdowns above) but get crowded out of context_notes by this SAME tiny fixture's higher-salience all-time-rank noise — a real cap interaction, not a bug", () => {
      // With only 10 total team-weeks in this fixture, EVERY score trivially lands within the
      // all-time top-10 AND bottom-10 simultaneously (there aren't 10 entries to push any one of
      // them out of range) — so `all_time_score_rank` (salience 70+) unavoidably fires for every
      // subject, and `beatdown_of_week` (salience 45, the lowest-priority rule that can apply to a
      // loss) never wins one of the 3 cap slots here. This is the SAME cap mechanism the dedicated
      // "3-note-per-subject cap holds under a real multi-record collision" test below already
      // proves correct for a different rule — confirmed independently for beatdown_of_week here,
      // rather than re-asserted as if it were a fresh finding. The FEATURE's actual wiring
      // end-to-end (computeWeeklyBeatdowns -> season_stats/career_stats/record_entries) is already
      // proven by the two tests immediately above, on real per-week margin arithmetic.
      runStatBuild(db);

      const beatdownNotes = db.select().from(contextNotes).where(eq(contextNotes.ruleId, "beatdown_of_week")).all();
      expect(beatdownNotes).toEqual([]);

      // Confirm WHY, precisely: each of the 3 real weekly-award winners already has its 3 cap
      // slots filled by salience>=70 rules (never anything as low as beatdown_of_week's 45).
      const targets = [
        { franchiseId: ids.franchiseId.T3, week: 1 },
        { franchiseId: ids.franchiseId.T4, week: 2 },
        { franchiseId: ids.franchiseId.T2, week: 3 },
      ];
      for (const t of targets) {
        const notesForSubject = db
          .select()
          .from(contextNotes)
          .where(and(eq(contextNotes.franchiseId, t.franchiseId), eq(contextNotes.season, SEASON), eq(contextNotes.week, t.week)))
          .all();
        expect(notesForSubject).toHaveLength(3);
        expect(notesForSubject.every((n) => n.salience >= 70)).toBe(true);
      }
    });

    it("row count is sane for a tiny fixture — not thousands of rows for a handful of games", () => {
      runStatBuild(db);
      const rows = db.select().from(contextNotes).all();
      expect(rows.length).toBeLessThan(100);
    });

    it("the 3-note-per-subject cap holds under a real multi-record collision: T2's week-2 win (60 pts) simultaneously sets 3 different league records, and only the top 3 by salience survive", () => {
      // Real fixture arithmetic: T2's week-2 60 is simultaneously the fixture's #1 all-time score,
      // #1 largest blowout (margin 50), AND ties the (degenerate, tiny-fixture) #1 longest win
      // streak (every franchise's longest win streak is 1 game in this 3-week fixture) — three
      // separate record_entries keys, each rank 1, ALL salience 100 (RECORD_BROKEN). That crowds
      // out the (lower-salience) all_time_score_rank note entirely — proves the cap really does
      // drop notes, not just theoretically in the engine's own isolated unit tests.
      runStatBuild(db);
      const rows = db
        .select()
        .from(contextNotes)
        .where(and(eq(contextNotes.franchiseId, ids.franchiseId.T2), eq(contextNotes.season, SEASON), eq(contextNotes.week, 2)))
        .all();
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.ruleId === "record_broken" && r.salience === 100)).toBe(true);
      const recordKeys = rows.map((r) => (r.factsJson as { recordKey: string }).recordKey).sort();
      expect(recordKeys).toEqual(["highest_week_score", "largest_blowout", "longest_win_streak"]);
      // Crowded out entirely — never persisted, not merely deprioritized.
      expect(rows.some((r) => r.ruleId === "all_time_score_rank")).toBe(false);
    });

    it("T2's week-3 loss (44 pts, an all-time top-10 score AND the league's worst loss) gets both an all_time_score_rank note and a record_broken note", () => {
      // Chosen deliberately over T2's week-2 win (60, the fixture's single highest score): in this
      // tiny fixture, week 2 collides with THREE simultaneous rank-1 records at once (highest
      // score, largest blowout, longest win streak — see the cap test below), which crowds
      // all_time_score_rank out of the top-3 cap entirely. Week 3's loss is a cleaner, uncontested
      // subject: rank 1 for most_points_in_loss only, rank 5 (top-10, not top-3) for the all-time
      // score itself — real fixture arithmetic, not invented: T2's 10 team-weeks in this fixture
      // rank 44 as the 5th-highest score overall and the single worst loss (previously 30.0, T2's
      // own week-1 loss).
      runStatBuild(db);
      const rows = db
        .select()
        .from(contextNotes)
        .where(and(eq(contextNotes.franchiseId, ids.franchiseId.T2), eq(contextNotes.season, SEASON), eq(contextNotes.week, 3)))
        .all();
      const ruleIds = rows.map((r) => r.ruleId);
      expect(ruleIds).toContain("all_time_score_rank");
      expect(ruleIds).toContain("record_broken");
      expect(ruleIds).toContain("futility_valor");

      const allTime = rows.find((r) => r.ruleId === "all_time_score_rank")!;
      expect(allTime).toMatchObject({ salience: 70, renderedText: "5th-highest score in league history" });
      expect(allTime.matchupId).not.toBeNull(); // team_week-subject notes carry the resolved matchup id

      const broken = rows.find((r) => r.ruleId === "record_broken")!;
      expect(broken).toMatchObject({ salience: 100, renderedText: "Breaks the league record for most points in a loss (previously 30.0, 2024)" });
    });

    it("belt_stakes fires no notes when the fixture's only belt event is a vacancy-award coronation (no real belt_matches row)", () => {
      // Mirrors the "belt" test in stage 3-4 above: T1's week-3 coronation is a vacancy award, not
      // a transfer — belt_matches is empty for this base fixture, so belt_stakes has nothing to
      // attach a note to.
      runStatBuild(db);
      const rows = db.select().from(contextNotes).where(eq(contextNotes.ruleId, "belt_stakes")).all();
      expect(rows).toEqual([]);
    });

    it("belt_stakes fires a transfer note for every real belt_matches row, matchup-scoped with franchise_id null", () => {
      const overrides = [{ season: SEASON, week: 1, franchiseId: ids.franchiseId.T3, reason: "test override" }];
      db.insert(appSettings).values({ key: "belt_overrides", valueJson: overrides, updatedAt: new Date() }).run();

      runStatBuild(db);
      const rows = db.select().from(contextNotes).where(eq(contextNotes.ruleId, "belt_stakes")).all();
      // Same 3-transfer chronology as the stage 3-4 belt_overrides test above.
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.subjectType === "matchup" && r.franchiseId === null && r.matchupId !== null)).toBe(true);
      expect(rows.every((r) => r.renderedText.includes("The belt changes hands"))).toBe(true);
    });

    it("--force fully replaces the old build_id's context_notes rows with a fresh set tagged to the new build_id", () => {
      const first = runStatBuild(db);
      const firstRows = db.select().from(contextNotes).all();
      expect(firstRows.length).toBeGreaterThan(0);

      const forced = runStatBuild(db, { force: true });
      expect(forced.buildId).not.toBe(first.buildId);

      const oldRows = db.select().from(contextNotes).where(eq(contextNotes.buildId, first.buildId!)).all();
      expect(oldRows).toEqual([]);
      const newRows = db.select().from(contextNotes).where(eq(contextNotes.buildId, forced.buildId!)).all();
      expect(newRows.length).toBe(firstRows.length);
    });

    it("an 'upcoming' unplayed season contributes no context_notes at all (no fabricated notes from placeholder rows)", () => {
      const UPCOMING_SEASON = SEASON + 1;
      const league = db.select().from(leagues).all()[0]!;
      db.insert(seasons)
        .values({
          season: UPCOMING_SEASON,
          leagueId: league.id,
          settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
          scoringJson: {},
          playoffFormatJson: {},
          teamCount: 4,
          regSeasonWeeks: 14,
          status: "upcoming",
        })
        .run();

      const upcomingTeamSeasonId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
      for (const key of ["T1", "T2", "T3", "T4"] as const) {
        const ts = db
          .insert(teamSeasons)
          .values({
            season: UPCOMING_SEASON,
            franchiseId: ids.franchiseId[key],
            espnTeamId: Number(key.slice(1)) + 100,
            teamName: key,
            wins: 0,
            losses: 0,
            ties: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            finalStanding: 0,
            madePlayoffs: false,
          })
          .returning()
          .get();
        upcomingTeamSeasonId[key] = ts.id;
      }
      db.insert(weeks).values([{ season: UPCOMING_SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: false }]).run();
      db.insert(matchups)
        .values({
          season: UPCOMING_SEASON,
          week: 1,
          espnMatchupId: 1,
          homeTeamSeasonId: upcomingTeamSeasonId.T1!,
          awayTeamSeasonId: upcomingTeamSeasonId.T2!,
          homeScore: 0,
          awayScore: 0,
          isFinal: false,
          winner: null,
        })
        .run();

      runStatBuild(db, { force: true });
      const upcomingNotes = db.select().from(contextNotes).where(eq(contextNotes.season, UPCOMING_SEASON)).all();
      expect(upcomingNotes).toEqual([]);
    });
  });

  describe("stage 6 (achievements)", () => {
    let ids: FixtureIds;

    beforeEach(() => {
      ids = seedFixture(db);
    });

    it("produces achievements rows tagged with the build_id, matching the returned row count", () => {
      const result = runStatBuild(db);
      const rows = db.select().from(achievements).all();
      expect(rows.length).toBe(result.rowCounts.achievements);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.buildId === result.buildId)).toBe(true);
    });

    it("perfect_lineup: fires for every team-week whose forced/unique-eligibility roster makes optimal == actual (T2/T3/T4 in week 1, all four in week 2), never for T1's week-1 FLEX-trap lineup nor week 3's no-roster-data playoff week", () => {
      runStatBuild(db);
      const rows = db.select().from(achievements).where(eq(achievements.achievementKey, "perfect_lineup")).all();
      const byWeek = new Map<number, number[]>();
      for (const r of rows) {
        const list = byWeek.get(r.week) ?? [];
        list.push(r.franchiseId);
        byWeek.set(r.week, list);
      }
      const sortAsc = (a: number, b: number) => a - b;
      expect((byWeek.get(1) ?? []).sort(sortAsc)).toEqual([ids.franchiseId.T2, ids.franchiseId.T3, ids.franchiseId.T4].sort(sortAsc));
      expect((byWeek.get(2) ?? []).sort(sortAsc)).toEqual(
        [ids.franchiseId.T1, ids.franchiseId.T2, ids.franchiseId.T3, ids.franchiseId.T4].sort(sortAsc),
      );
      expect(byWeek.get(3) ?? []).toEqual([]); // week 3 has no roster_slots data at all — never fabricated
      expect(rows.some((r) => r.franchiseId === ids.franchiseId.T1 && r.week === 1)).toBe(false); // T1's suboptimal week-1 lineup
    });

    it("giant_killer / narrow_escape / heartbreaker / lucky_winner / bench_disaster: all wired through the REAL build pipeline (elo_history + roster_slots -> optimalLineup -> achievements), not just hand-built engine inputs", () => {
      // A dedicated 2-week, 4-franchise scenario (reuses the base fixture's franchises, a fresh
      // season) engineered to exercise every achievement type the OTHER stage-6 tests above don't
      // touch — in particular `giant_killer`'s eloHistoryRows wiring, the only integration path
      // achievements.ts's own unit tests can't prove end-to-end (they hand-build AchievementsEloInput
      // directly). The exact Elo gap is cross-checked against elo_history's OWN computed values
      // below, rather than hand-predicted, so this test stays robust to any future tuning of the
      // Elo formula's constants.
      const NEW_SEASON = SEASON + 3;
      const league = db.select().from(leagues).all()[0]!;
      db.insert(seasons)
        .values({
          season: NEW_SEASON,
          leagueId: league.id,
          settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
          scoringJson: {},
          playoffFormatJson: {},
          teamCount: 4,
          regSeasonWeeks: 2,
          status: "complete",
        })
        .run();

      const tsId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
      for (const key of ["T1", "T2", "T3", "T4"] as const) {
        const ts = db
          .insert(teamSeasons)
          .values({
            season: NEW_SEASON,
            franchiseId: ids.franchiseId[key],
            espnTeamId: Number(key.slice(1)) + 600,
            teamName: key,
            wins: 0,
            losses: 0,
            ties: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            finalStanding: null,
            madePlayoffs: false,
          })
          .returning()
          .get();
        tsId[key] = ts.id;
      }
      const t = tsId as Record<"T1" | "T2" | "T3" | "T4", number>;

      db.insert(weeks)
        .values([
          { season: NEW_SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true },
          { season: NEW_SEASON, week: 2, scoringPeriodId: 2, weekType: "regular", isComplete: true },
        ])
        .run();

      db.insert(matchups)
        .values([
          // Week 1: T1 crushes T2 (margin 200, both start at Elo 1500) — establishes a large
          // pre-game Elo gap for week 2. T3 narrowly beats T4 (margin 0.5) — narrow_escape/
          // heartbreaker, and also feeds lucky_winner's week-1 median (see below).
          { season: NEW_SEASON, week: 1, espnMatchupId: 601, homeTeamSeasonId: t.T1, awayTeamSeasonId: t.T2, homeScore: 250, awayScore: 50, isFinal: true, winner: "home" },
          { season: NEW_SEASON, week: 1, espnMatchupId: 602, homeTeamSeasonId: t.T3, awayTeamSeasonId: t.T4, homeScore: 100.5, awayScore: 100, isFinal: true, winner: "home" },
          // Week 2: T2 (now low Elo) upsets T1 (now high Elo) — giant_killer for T2, and T2's
          // low winning score (40) is also comfortably below this week's median once T3/T4's
          // high-scoring blowout (below) is factored in — lucky_winner for T2 too. T4 beats T3
          // with a suboptimal roster whose bench held enough points to have beaten T3's actual
          // score outright — bench_disaster for T3.
          { season: NEW_SEASON, week: 2, espnMatchupId: 603, homeTeamSeasonId: t.T2, awayTeamSeasonId: t.T1, homeScore: 40, awayScore: 30, isFinal: true, winner: "home" },
          { season: NEW_SEASON, week: 2, espnMatchupId: 604, homeTeamSeasonId: t.T4, awayTeamSeasonId: t.T3, homeScore: 95, awayScore: 90, isFinal: true, winner: "home" },
        ])
        .run();

      // Week-2 T3 roster: the FLEX-trap shape (see src/engines/__fixtures__/optimalLineup.ts) —
      // actual lineup scores 90 (35 QB + 20 RB_A@FLEX + 35... simplified below to keep the exact
      // arithmetic obvious), optimal lineup scores well above T4's actual 95, flipping the result.
      seedPlayers(db, [701, 702, 703, 704]);
      db.insert(rosterSlots)
        .values([
          // Actual: 10(QB) + 20(RB_A@FLEX) + 60(RB_C@RB) = 90 (T3's actual reported score).
          { season: NEW_SEASON, week: 2, teamSeasonId: t.T3, playerId: 701, lineupSlot: "QB", isStarter: true, points: 10, eligibleSlotsJson: ["QB"] },
          { season: NEW_SEASON, week: 2, teamSeasonId: t.T3, playerId: 702, lineupSlot: "FLEX", isStarter: true, points: 20, eligibleSlotsJson: ["RB", "FLEX"] },
          { season: NEW_SEASON, week: 2, teamSeasonId: t.T3, playerId: 703, lineupSlot: "RB", isStarter: true, points: 60, eligibleSlotsJson: ["RB", "FLEX"] },
          // Benched WR, FLEX-eligible only, worth more than the RB started at FLEX — the optimal
          // lineup swaps it in (10 + 60(RB_C@RB) + 100(WR_D@FLEX) = 170 > T4's actual 95).
          { season: NEW_SEASON, week: 2, teamSeasonId: t.T3, playerId: 704, lineupSlot: "BE", isStarter: false, points: 100, eligibleSlotsJson: ["FLEX"] },
        ])
        .run();

      const result = runStatBuild(db, { force: true });
      expect(result.status).toBe("ok");

      // --- giant_killer: cross-validate against elo_history's OWN computed pre-game values ---
      const eloRows = db.select().from(eloHistory).where(and(eq(eloHistory.season, NEW_SEASON), eq(eloHistory.week, 2))).all();
      const t1Pre = eloRows.find((r) => r.franchiseId === ids.franchiseId.T1)!.eloPre;
      const t2Pre = eloRows.find((r) => r.franchiseId === ids.franchiseId.T2)!.eloPre;
      expect(t1Pre - t2Pre).toBeGreaterThanOrEqual(150); // the scenario is deliberately overbuilt (margin 200) to clear this comfortably

      const giantKiller = db
        .select()
        .from(achievements)
        .where(and(eq(achievements.achievementKey, "giant_killer"), eq(achievements.season, NEW_SEASON), eq(achievements.week, 2)))
        .all();
      expect(giantKiller).toHaveLength(1);
      expect(giantKiller[0]).toMatchObject({ franchiseId: ids.franchiseId.T2 });
      expect(giantKiller[0]!.payloadJson).toMatchObject({ opponentFranchiseId: ids.franchiseId.T1 });

      // --- narrow_escape / heartbreaker (week 1, margin 0.5) ---
      const narrow = db.select().from(achievements).where(and(eq(achievements.achievementKey, "narrow_escape"), eq(achievements.season, NEW_SEASON))).all();
      expect(narrow.map((r) => r.franchiseId)).toEqual([ids.franchiseId.T3]);
      const heartbreak = db.select().from(achievements).where(and(eq(achievements.achievementKey, "heartbreaker"), eq(achievements.season, NEW_SEASON))).all();
      expect(heartbreak.map((r) => r.franchiseId)).toEqual([ids.franchiseId.T4]);

      // --- lucky_winner (week 2: scores [40, 30, 95, 90], median 65 — T2 won at 40, well below) ---
      const lucky = db.select().from(achievements).where(and(eq(achievements.achievementKey, "lucky_winner"), eq(achievements.season, NEW_SEASON), eq(achievements.week, 2))).all();
      expect(lucky.map((r) => r.franchiseId)).toEqual([ids.franchiseId.T2]);

      // --- bench_disaster (week 2: T3's optimal 170 > T4's actual 95, flipping a loss to a would-be win) ---
      const disaster = db.select().from(achievements).where(and(eq(achievements.achievementKey, "bench_disaster"), eq(achievements.season, NEW_SEASON))).all();
      expect(disaster.map((r) => r.franchiseId)).toEqual([ids.franchiseId.T3]);
      expect(disaster[0]!.payloadJson).toMatchObject({ score: 90, optimalScore: 170, opponentScore: 95 });
    });

    it("weekly_high: exactly one winner per week, matching the fixture's known top scorer", () => {
      runStatBuild(db);
      const rows = db.select().from(achievements).where(eq(achievements.achievementKey, "weekly_high")).all();
      const byWeek = new Map(rows.map((r) => [r.week, r.franchiseId]));
      expect(rows).toHaveLength(3); // no ties in this fixture
      expect(byWeek.get(1)).toBe(ids.franchiseId.T4); // 50, the week's top score
      expect(byWeek.get(2)).toBe(ids.franchiseId.T2); // 60
      expect(byWeek.get(3)).toBe(ids.franchiseId.T1); // 55
    });

    it("record_breaker: T2's week-2 60-point win simultaneously sets 3 real rank-1 records (highest_week_score, largest_blowout, longest_win_streak) — 3 distinctly-keyed achievement rows, not 1 collapsed row", () => {
      // Same real fixture arithmetic the stage 5 context_notes cap test already establishes.
      runStatBuild(db);
      const rows = db
        .select()
        .from(achievements)
        .where(and(eq(achievements.achievementKey, "record_breaker"), eq(achievements.franchiseId, ids.franchiseId.T2), eq(achievements.week, 2)))
        .all();
      expect(rows).toHaveLength(3);
      const recordKeys = rows.map((r) => (r.payloadJson as { recordKey: string }).recordKey).sort();
      expect(recordKeys).toEqual(["highest_week_score", "largest_blowout", "longest_win_streak"]);
      expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(3); // recordKey disambiguates the dedupeKey
    });

    it("belt_thief/belt_defender: wired straight from belt_matches, matching the same 3-transfer chronology stage 3-4's belt_overrides test already proves", () => {
      const overrides = [{ season: SEASON, week: 1, franchiseId: ids.franchiseId.T3, reason: "test override" }];
      db.insert(appSettings).values({ key: "belt_overrides", valueJson: overrides, updatedAt: new Date() }).run();
      runStatBuild(db);

      const thief = db.select().from(achievements).where(eq(achievements.achievementKey, "belt_thief")).all();
      const defender = db.select().from(achievements).where(eq(achievements.achievementKey, "belt_defender")).all();
      // T3's OWN acquisition is via the override itself (a commissioner correction, not a game) —
      // replay() never emits a belt_matches row for that step (see stage 3-4's belt_overrides
      // test: exactly 3 belt_matches rows, all "transfer"). The 3 REAL games that follow are all
      // transfers too (T3->T4 week 1, T4->T2 week 2, T2->T1 week 3) — no successful defense occurs
      // anywhere in this chronology, so belt_defender is empty.
      expect(defender).toEqual([]);
      expect(thief).toHaveLength(3);
      expect(thief.map((r) => r.franchiseId).sort((a, b) => a - b)).toEqual(
        [ids.franchiseId.T4, ids.franchiseId.T2, ids.franchiseId.T1].sort((a, b) => a - b),
      );
    });

    it("settlement gate: an unplayed/in-progress week contributes zero achievements, even alongside an otherwise fully-settled season", () => {
      const UPCOMING_SEASON = SEASON + 1;
      const league = db.select().from(leagues).all()[0]!;
      db.insert(seasons)
        .values({
          season: UPCOMING_SEASON,
          leagueId: league.id,
          settingsJson: { rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS } },
          scoringJson: {},
          playoffFormatJson: {},
          teamCount: 4,
          regSeasonWeeks: 14,
          status: "upcoming",
        })
        .run();

      const upcomingTeamSeasonId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
      for (const key of ["T1", "T2", "T3", "T4"] as const) {
        const ts = db
          .insert(teamSeasons)
          .values({
            season: UPCOMING_SEASON,
            franchiseId: ids.franchiseId[key],
            espnTeamId: Number(key.slice(1)) + 100,
            teamName: key,
            wins: 0,
            losses: 0,
            ties: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            finalStanding: 0,
            madePlayoffs: false,
          })
          .returning()
          .get();
        upcomingTeamSeasonId[key] = ts.id;
      }
      db.insert(weeks).values([{ season: UPCOMING_SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: false }]).run();
      db.insert(matchups)
        .values({
          season: UPCOMING_SEASON,
          week: 1,
          espnMatchupId: 1,
          homeTeamSeasonId: upcomingTeamSeasonId.T1!,
          awayTeamSeasonId: upcomingTeamSeasonId.T2!,
          homeScore: 0,
          awayScore: 0,
          isFinal: false,
          winner: null,
        })
        .run();

      runStatBuild(db, { force: true });
      const upcomingAchievements = db.select().from(achievements).where(eq(achievements.season, UPCOMING_SEASON)).all();
      expect(upcomingAchievements).toEqual([]);

      // The pre-existing, fully-settled SEASON is unaffected by the new upcoming season existing.
      const settledAchievements = db.select().from(achievements).where(eq(achievements.season, SEASON)).all();
      expect(settledAchievements.length).toBeGreaterThan(0);
    });

    it("idempotence: two consecutive (forced) builds produce byte-identical achievements rows — same achievementKey/franchiseId/season/week/dedupeKey/payload set, only build_id/id differ", () => {
      const first = runStatBuild(db);
      const firstRows = db.select().from(achievements).orderBy(achievements.dedupeKey).all();
      expect(firstRows.length).toBeGreaterThan(0);

      const second = runStatBuild(db, { force: true });
      expect(second.buildId).not.toBe(first.buildId);
      const secondRows = db.select().from(achievements).orderBy(achievements.dedupeKey).all();

      // Only id/build_id are expected to differ across builds — every other column (including
      // the earned season/week) must reproduce byte-identical.
      const strip = (r: (typeof firstRows)[number]) => ({
        achievementKey: r.achievementKey,
        franchiseId: r.franchiseId,
        season: r.season,
        week: r.week,
        dedupeKey: r.dedupeKey,
        payloadJson: r.payloadJson,
      });
      expect(secondRows.map(strip)).toEqual(firstRows.map(strip));
    });

    it("--force fully replaces the old build_id's achievements rows with a fresh set tagged to the new build_id", () => {
      const first = runStatBuild(db);
      const firstRows = db.select().from(achievements).all();
      expect(firstRows.length).toBeGreaterThan(0);

      const forced = runStatBuild(db, { force: true });
      const oldRows = db.select().from(achievements).where(eq(achievements.buildId, first.buildId!)).all();
      expect(oldRows).toEqual([]);
      const newRows = db.select().from(achievements).where(eq(achievements.buildId, forced.buildId!)).all();
      expect(newRows.length).toBe(firstRows.length);
    });
  });

  describe("stage 7 (slot scoring calibration — Task 32)", () => {
    beforeEach(() => {
      seedFixture(db);
    });

    it("produces one row per real starter slot label seen in roster_slots plus a pooled ALL row, tagged with the build_id", () => {
      const result = runStatBuild(db);
      const rows = db.select().from(slotScoringStats).all();
      expect(rows.length).toBe(result.rowCounts.slotScoringStats);
      expect(rows.every((r) => r.buildId === result.buildId)).toBe(true);

      // Fixture's starter roster_slots only ever use QB/RB/FLEX (see seedFixture) — BE is never a
      // starter, and week 3 (playoff) has no roster_slots at all.
      const slots = rows.map((r) => r.slot).sort();
      expect(slots).toEqual(["ALL", "FLEX", "QB", "RB"].sort());
    });

    it("a slot's mean/variance/sample_size match a direct hand-aggregate over roster_slots (isStarter=true, points recorded)", () => {
      runStatBuild(db);

      const rawPoints = db
        .select({ points: rosterSlots.points })
        .from(rosterSlots)
        .where(and(eq(rosterSlots.lineupSlot, "QB"), eq(rosterSlots.isStarter, true)))
        .all()
        .map((r) => r.points!);
      const n = rawPoints.length;
      const mean = rawPoints.reduce((a, b) => a + b, 0) / n;
      const variance = rawPoints.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (n - 1);

      const qbRow = db.select().from(slotScoringStats).where(eq(slotScoringStats.slot, "QB")).get()!;
      expect(qbRow.sampleSize).toBe(n);
      expect(qbRow.mean).toBeCloseTo(mean, 10);
      expect(qbRow.variance).toBeCloseTo(variance, 10);
      expect(qbRow.seasonMin).toBe(SEASON);
      expect(qbRow.seasonMax).toBe(SEASON);
    });

    it("the pooled ALL row aggregates every starter's raw points together — NOT an average of the per-slot means", () => {
      runStatBuild(db);

      const rawPoints = db
        .select({ points: rosterSlots.points })
        .from(rosterSlots)
        .where(eq(rosterSlots.isStarter, true))
        .all()
        .map((r) => r.points!);
      const n = rawPoints.length;
      const mean = rawPoints.reduce((a, b) => a + b, 0) / n;

      const allRow = db.select().from(slotScoringStats).where(eq(slotScoringStats.slot, CALIBRATION_POOLED_SLOT)).get()!;
      expect(allRow.sampleSize).toBe(n);
      expect(allRow.mean).toBeCloseTo(mean, 10);

      // Sanity: the pooled sample size is the SUM of every per-slot sample size, not e.g. a count
      // of distinct slots — proves ALL is a genuine pool of raw observations, not a summary-of-
      // summaries. (This fixture's per-slot sample sizes happen to tie, so a naive "average of the
      // per-slot means" would coincidentally match too — sample-size summing is the assertion that
      // still discriminates a broken implementation regardless of that coincidence.)
      const perSlotRows = db.select().from(slotScoringStats).where(eq(slotScoringStats.buildId, allRow.buildId)).all();
      const perSlotSampleSizeSum = perSlotRows.filter((r) => r.slot !== CALIBRATION_POOLED_SLOT).reduce((sum, r) => sum + r.sampleSize, 0);
      expect(allRow.sampleSize).toBe(perSlotSampleSizeSum);
    });

    it("a single-sample slot gets variance 0, not a divide-by-zero NaN (n=1 boundary)", () => {
      // BE never starts in the base fixture — insert a franchise-independent extra week with a
      // K slot that only ever appears once, isolated from the shared fixture's other K-less rows.
      const ts = db.select().from(teamSeasons).all()[0]!;
      db.insert(weeks).values({ season: SEASON, week: 4, scoringPeriodId: 4, weekType: "regular", isComplete: true }).run();
      db.insert(matchups)
        .values({ season: SEASON, week: 4, espnMatchupId: 99, homeTeamSeasonId: ts.id, awayTeamSeasonId: null, homeScore: 9, awayScore: 0, isFinal: true, winner: null })
        .run();
      db.insert(players).values({ espnPlayerId: 999, fullName: "Lone Kicker", defaultPosition: "K" }).onConflictDoNothing().run();
      db.insert(rosterSlots)
        .values({ season: SEASON, week: 4, teamSeasonId: ts.id, playerId: 999, lineupSlot: "K", isStarter: true, points: 9, eligibleSlotsJson: ["K"] })
        .run();

      runStatBuild(db, { force: true });
      const kRow = db.select().from(slotScoringStats).where(eq(slotScoringStats.slot, "K")).get()!;
      expect(kRow.sampleSize).toBe(1);
      expect(kRow.mean).toBe(9);
      expect(kRow.variance).toBe(0);
      expect(Number.isNaN(kRow.variance)).toBe(false);
    });

    it("idempotence: two consecutive (forced) builds produce byte-identical slot_scoring_stats rows — only build_id/id differ", () => {
      const first = runStatBuild(db);
      const firstRows = db.select().from(slotScoringStats).orderBy(slotScoringStats.slot).all();
      expect(firstRows.length).toBeGreaterThan(0);

      const second = runStatBuild(db, { force: true });
      expect(second.buildId).not.toBe(first.buildId);
      const secondRows = db.select().from(slotScoringStats).orderBy(slotScoringStats.slot).all();

      const strip = (r: (typeof firstRows)[number]) => ({
        slot: r.slot,
        mean: r.mean,
        variance: r.variance,
        sampleSize: r.sampleSize,
        seasonMin: r.seasonMin,
        seasonMax: r.seasonMax,
      });
      expect(secondRows.map(strip)).toEqual(firstRows.map(strip));
    });

    it("--force fully replaces the old build_id's slot_scoring_stats rows with a fresh set tagged to the new build_id", () => {
      const first = runStatBuild(db);
      const firstRows = db.select().from(slotScoringStats).all();
      expect(firstRows.length).toBeGreaterThan(0);

      const forced = runStatBuild(db, { force: true });
      const oldRows = db.select().from(slotScoringStats).where(eq(slotScoringStats.buildId, first.buildId!)).all();
      expect(oldRows).toEqual([]);
      const newRows = db.select().from(slotScoringStats).where(eq(slotScoringStats.buildId, forced.buildId!)).all();
      expect(newRows.length).toBe(firstRows.length);
    });
  });

  describe("stage 7 (slot scoring calibration) — empty database", () => {
    it("a build against a database with zero roster_slots rows produces zero slot_scoring_stats rows, not a crash", () => {
      const result = runStatBuild(db);
      expect(result.status).toBe("ok");
      const rows = db.select().from(slotScoringStats).all();
      expect(rows).toEqual([]);
      expect(result.rowCounts.slotScoringStats).toBe(0);
    });
  });

  describe("failure handling", () => {
    it("a failed build marks stat_builds 'failed' with error text and leaves prior derived rows intact", () => {
      const ids = seedFixture(db);
      const first = runStatBuild(db);
      expect(first.status).toBe("ok");

      const teamWeekRowsBefore = db.select().from(teamWeek).all();
      const allplayRowsBefore = db.select().from(allplayWeek).all();
      expect(teamWeekRowsBefore.length).toBeGreaterThan(0);

      // Corrupt the data: add a second week-1 matchup that ALSO has T1 as its home team, so two
      // team_week candidates collide on UNIQUE (season, week, franchise_id) inside the write
      // transaction — a genuine SQLite failure, not a mock.
      db.insert(matchups)
        .values({
          season: SEASON,
          week: 1,
          espnMatchupId: 9999,
          homeTeamSeasonId: ids.teamSeasonId.T1,
          awayTeamSeasonId: null,
          homeScore: 12,
          awayScore: 0,
          isFinal: true,
          winner: null,
        })
        .run();

      const failed = runStatBuild(db, { force: true });
      expect(failed.status).toBe("failed");
      expect(failed.errorText).toBeTruthy();

      const buildRow = db.select().from(statBuilds).where(eq(statBuilds.id, failed.buildId!)).get()!;
      expect(buildRow.status).toBe("failed");
      expect(buildRow.errorText).toBeTruthy();

      const teamWeekRowsAfter = db.select().from(teamWeek).all();
      const allplayRowsAfter = db.select().from(allplayWeek).all();
      expect(teamWeekRowsAfter).toEqual(teamWeekRowsBefore);
      expect(allplayRowsAfter).toEqual(allplayRowsBefore);
    });
  });
});
