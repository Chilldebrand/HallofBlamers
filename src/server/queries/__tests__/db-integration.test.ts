/**
 * Seeded-temp-DB smoke test for every DB-facing (non-pure) query function
 * across franchises/records/h2h/seasons/belt/home. The pure aggregation
 * logic (sorting, grouping, perspective-flipping, superlatives, etc.) is
 * unit-tested directly in the sibling *.test.ts files against plain
 * objects — this file's only job is to prove the Drizzle joins/where
 * clauses actually run against the REAL migrated schema and come back in
 * the shape callers expect. Hand-inserts directly into the derived tables
 * (skips running the full stats pipeline) — those tables' correctness is
 * build.ts's job, already covered by src/server/stats/__tests__/build.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import {
  appSettings,
  beltMatches,
  beltReigns,
  careerStats,
  contextNotes,
  draftPicks,
  eloHistory,
  franchiseManagers,
  franchises,
  h2hPairs,
  leagues,
  matchups,
  players,
  recordEntries,
  seasonStats,
  seasons,
  statBuilds,
  teamSeasons,
  teamWeek,
  weeks,
} from "../../db/schema";
import { getBeltLineage, getBeltRecords, getCurrentBeltHolder, getCurrentReignDetail } from "../belt";
import { getFranchiseBeltHistory, getFranchiseEloSeries, getFranchiseH2H, getFranchiseHeader, getFranchiseIndex, getFranchiseRecords, getFranchiseSeasons } from "../franchises";
import { getActiveH2HMatrix, getH2HPairDetail, getHistoricalH2H } from "../h2h";
import { getChampion, getDraftCountdown, getEloTop, getLastTimeOut, getTopRecord } from "../home";
import { getMatchupDetail, getWeekMatchupRows } from "../matchups";
import { getRecordBook } from "../records";
import { getSeasonBeltActivity, getSeasonDraftBoard, getSeasonIndex, getSeasonStandings, getSeasonSuperlatives, getSeasonWeeks } from "../seasons";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

let f1: number; // active, 2015+2016 champion once
let f2: number; // active, 2016 champion, current belt holder's "won from"
let f3: number; // active, current belt holder
let f4: number; // departed after 2015
let ts2015F1: number;
let ts2015F2: number;
let ts2015F3: number;
let ts2015F4: number;
let matchup2015Wk1: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-query-test-")), "test.db");
  // Every query function under test reads through db/client.ts's lazy `getDb()` singleton (the
  // same pattern every Task 9 query file uses) rather than accepting an injected `Db` — so the
  // singleton has to be pointed at this temp file BEFORE any query function's first call. Vitest's
  // default pool isolates process.env per test file (separate fork/worker), so this can't leak
  // into other test files.
  process.env.DATABASE_PATH = dbPath;

  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2015 }).returning().get();

  db.insert(seasons)
    .values([
      { season: 2015, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 2, status: "complete" },
      { season: 2016, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 2, status: "complete" },
    ])
    .run();

  f1 = db.insert(franchises).values({ canonicalName: "Gridiron Gladiators", managerName: "Zoe", joinedSeason: 2015, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Blue Thunder", managerName: "Bob", joinedSeason: 2015, active: true }).returning().get().id;
  f3 = db.insert(franchises).values({ canonicalName: "Red Rockets", managerName: "Cara", joinedSeason: 2015, active: true }).returning().get().id;
  f4 = db
    .insert(franchises)
    .values({ canonicalName: "Departed Dynasty", managerName: "Dave", joinedSeason: 2015, departedSeason: 2015, active: false })
    .returning()
    .get().id;

  db.insert(franchiseManagers)
    .values([
      { franchiseId: f1, managerName: "Alice", fromSeason: 2015, toSeason: 2015 },
      { franchiseId: f1, managerName: "Zoe", fromSeason: 2016, toSeason: null },
      { franchiseId: f2, managerName: "Bob", fromSeason: 2015, toSeason: null },
      { franchiseId: f3, managerName: "Cara", fromSeason: 2015, toSeason: null },
      { franchiseId: f4, managerName: "Dave", fromSeason: 2015, toSeason: 2015 },
    ])
    .run();

  const ts = (season: number, franchiseId: number, espnTeamId: number, teamName: string, w: number, l: number, pf: number, pa: number, standing: number, playoffs: boolean) =>
    db
      .insert(teamSeasons)
      .values({ season, franchiseId, espnTeamId, teamName, wins: w, losses: l, ties: 0, pointsFor: pf, pointsAgainst: pa, finalStanding: standing, madePlayoffs: playoffs })
      .returning()
      .get().id;

  ts2015F1 = ts(2015, f1, 1, "F1 2015 Name", 2, 0, 220, 180, 1, true);
  ts2015F2 = ts(2015, f2, 2, "F2 2015 Name", 1, 1, 210, 205, 2, true);
  ts2015F3 = ts(2015, f3, 3, "F3 2015 Name", 1, 1, 190, 195, 3, false);
  ts2015F4 = ts(2015, f4, 4, "F4 2015 Name", 0, 2, 150, 230, 4, false);
  ts(2016, f1, 1, "F1 2016 Name", 1, 1, 200, 195, 2, true);
  ts(2016, f2, 2, "F2 2016 Name", 2, 0, 230, 190, 1, true);
  ts(2016, f3, 3, "F3 2016 Name", 0, 2, 160, 210, 3, false);

  db.insert(weeks)
    .values([
      { season: 2015, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true },
      { season: 2015, week: 2, scoringPeriodId: 2, weekType: "regular", isComplete: true },
      { season: 2016, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true },
    ])
    .run();

  matchup2015Wk1 = db
    .insert(matchups)
    .values({ season: 2015, week: 1, espnMatchupId: 1, homeTeamSeasonId: ts2015F1, awayTeamSeasonId: ts2015F2, homeScore: 130, awayScore: 100, isFinal: true, winner: "home" })
    .returning()
    .get().id;

  const build = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get();
  const buildId = build.id;

  db.insert(teamWeek)
    .values([
      { buildId, season: 2015, week: 1, weekType: "regular", teamSeasonId: ts2015F1, franchiseId: f1, opponentFranchiseId: f2, score: 130, result: "W", margin: 30 },
      { buildId, season: 2015, week: 1, weekType: "regular", teamSeasonId: ts2015F2, franchiseId: f2, opponentFranchiseId: f1, score: 100, result: "L", margin: -30 },
      { buildId, season: 2015, week: 2, weekType: "regular", teamSeasonId: ts2015F1, franchiseId: f1, opponentFranchiseId: f3, score: 90, result: "L", margin: -5 },
      { buildId, season: 2015, week: 2, weekType: "regular", teamSeasonId: ts2015F3, franchiseId: f3, opponentFranchiseId: f1, score: 95, result: "W", margin: 5 },
      { buildId, season: 2015, week: 2, weekType: "regular", teamSeasonId: ts2015F2, franchiseId: f2, opponentFranchiseId: f4, score: 140, result: "W", margin: 80 },
      { buildId, season: 2015, week: 2, weekType: "regular", teamSeasonId: ts2015F4, franchiseId: f4, opponentFranchiseId: f2, score: 60, result: "L", margin: -80 },
    ])
    .run();

  db.insert(seasonStats)
    .values([
      { buildId, season: 2015, franchiseId: f1, wins: 2, losses: 0, ties: 0, pointsFor: 220, pointsAgainst: 180, allplayW: 4, allplayL: 2, allplayT: 0, finalStanding: 1, madePlayoffs: true, champion: true, sacko: false, efficiencyAvg: null },
      { buildId, season: 2015, franchiseId: f2, wins: 1, losses: 1, ties: 0, pointsFor: 210, pointsAgainst: 205, allplayW: 3, allplayL: 3, allplayT: 0, finalStanding: 2, madePlayoffs: true, champion: false, sacko: false, efficiencyAvg: null },
      { buildId, season: 2015, franchiseId: f3, wins: 1, losses: 1, ties: 0, pointsFor: 190, pointsAgainst: 195, allplayW: 3, allplayL: 3, allplayT: 0, finalStanding: 3, madePlayoffs: false, champion: false, sacko: false, efficiencyAvg: null },
      { buildId, season: 2015, franchiseId: f4, wins: 0, losses: 2, ties: 0, pointsFor: 150, pointsAgainst: 230, allplayW: 1, allplayL: 5, allplayT: 0, finalStanding: 4, madePlayoffs: false, champion: false, sacko: true, efficiencyAvg: null },
      { buildId, season: 2016, franchiseId: f1, wins: 1, losses: 1, ties: 0, pointsFor: 200, pointsAgainst: 195, allplayW: 2, allplayL: 2, allplayT: 0, finalStanding: 2, madePlayoffs: true, champion: false, sacko: false, efficiencyAvg: 0.87 },
      { buildId, season: 2016, franchiseId: f2, wins: 2, losses: 0, ties: 0, pointsFor: 230, pointsAgainst: 190, allplayW: 4, allplayL: 0, allplayT: 0, finalStanding: 1, madePlayoffs: true, champion: true, sacko: false, efficiencyAvg: 0.91 },
      { buildId, season: 2016, franchiseId: f3, wins: 0, losses: 2, ties: 0, pointsFor: 160, pointsAgainst: 210, allplayW: 0, allplayL: 4, allplayT: 0, finalStanding: 3, madePlayoffs: false, champion: false, sacko: true, efficiencyAvg: 0.7 },
    ])
    .run();

  db.insert(careerStats)
    .values([
      { buildId, franchiseId: f1, seasons: 2, wins: 3, losses: 1, ties: 0, winPct: 0.75, pointsFor: 420, pointsAgainst: 375, allplayW: 6, allplayL: 4, allplayT: 0, championships: 1, sackos: 0, playoffAppearances: 2, currentElo: 1550, peakElo: 1600, beatdowns: 3 },
      { buildId, franchiseId: f2, seasons: 2, wins: 3, losses: 1, ties: 0, winPct: 0.75, pointsFor: 440, pointsAgainst: 395, allplayW: 7, allplayL: 3, allplayT: 0, championships: 1, sackos: 0, playoffAppearances: 2, currentElo: 1620, peakElo: 1650 },
      { buildId, franchiseId: f3, seasons: 2, wins: 1, losses: 3, ties: 0, winPct: 0.25, pointsFor: 350, pointsAgainst: 405, allplayW: 3, allplayL: 7, allplayT: 0, championships: 0, sackos: 1, playoffAppearances: 0, currentElo: 1420, peakElo: 1480 },
      { buildId, franchiseId: f4, seasons: 1, wins: 0, losses: 2, ties: 0, winPct: 0, pointsFor: 150, pointsAgainst: 230, allplayW: 1, allplayL: 5, allplayT: 0, championships: 0, sackos: 1, playoffAppearances: 0, currentElo: 1300, peakElo: 1350 },
    ])
    .run();

  db.insert(eloHistory)
    .values([
      { buildId, season: 2015, week: 1, franchiseId: f1, eloPre: 1500, eloPost: 1520 },
      { buildId, season: 2015, week: 2, franchiseId: f1, eloPre: 1520, eloPost: 1540 },
      { buildId, season: 2016, week: 1, franchiseId: f1, eloPre: 1540, eloPost: 1550 },
      { buildId, season: 2015, week: 1, franchiseId: f4, eloPre: 1500, eloPost: 1480 },
      { buildId, season: 2015, week: 2, franchiseId: f4, eloPre: 1480, eloPost: 1460 },
    ])
    .run();

  db.insert(beltReigns)
    .values([
      { buildId, reignNo: 1, franchiseId: f1, wonFromFranchiseId: null, startSeason: 2015, startWeek: 1, endSeason: 2015, endWeek: 2, defenses: 0, weeksHeld: 2, endReason: "lost", isCurrent: false },
      { buildId, reignNo: 2, franchiseId: f2, wonFromFranchiseId: f1, startSeason: 2015, startWeek: 2, endSeason: 2016, endWeek: 1, defenses: 1, weeksHeld: 2, endReason: "lost", isCurrent: false },
      { buildId, reignNo: 3, franchiseId: f3, wonFromFranchiseId: f2, startSeason: 2016, startWeek: 1, endSeason: null, endWeek: null, defenses: 0, weeksHeld: 1, endReason: null, isCurrent: true },
    ])
    .run();

  db.insert(beltMatches)
    .values([
      { buildId, matchupId: 9001, season: 2015, week: 2, holderFranchiseId: f1, challengerFranchiseId: f2, result: "transfer", holderScore: 90, challengerScore: 95 },
      { buildId, matchupId: 9002, season: 2016, week: 1, holderFranchiseId: f2, challengerFranchiseId: f3, result: "transfer", holderScore: 100, challengerScore: 110 },
    ])
    .run();

  db.insert(recordEntries)
    .values([
      { buildId, recordKey: "highest_week_score", rank: 1, franchiseId: f2, season: 2015, week: 2, value: 140, weekType: "regular" },
      { buildId, recordKey: "highest_week_score", rank: 2, franchiseId: f1, season: 2015, week: 1, value: 130, weekType: "regular" },
      { buildId, recordKey: "largest_blowout", rank: 1, franchiseId: f2, season: 2015, week: 2, value: 80, weekType: "regular" },
      { buildId, recordKey: "longest_belt_reign", rank: 1, franchiseId: f1, season: 2015, week: 1, value: 2, weekType: null },
      { buildId, recordKey: "best_season_record", rank: 1, franchiseId: f2, season: 2016, week: null, value: 1.0, weekType: null },
    ])
    .run();

  db.insert(h2hPairs)
    .values([
      {
        buildId,
        franchiseA: Math.min(f1, f2),
        franchiseB: Math.max(f1, f2),
        regW: f1 < f2 ? 3 : 1,
        regL: f1 < f2 ? 1 : 3,
        regT: 0,
        playoffW: 0,
        playoffL: 0,
        playoffT: 0,
        pointsA: 500,
        pointsB: 480,
        avgMargin: 5,
        streakHolder: f1,
        streakLen: 2,
        largestWinJson: { winnerFranchiseId: f1, value: 30, season: 2015, week: 1 },
        closestGameJson: { season: 2016, week: 1, margin: 5 },
        lastMeetingJson: { season: 2016, week: 1 },
      },
      {
        buildId,
        franchiseA: Math.min(f1, f4),
        franchiseB: Math.max(f1, f4),
        regW: f1 < f4 ? 2 : 0,
        regL: f1 < f4 ? 0 : 2,
        regT: 0,
        playoffW: 0,
        playoffL: 0,
        playoffT: 0,
        pointsA: 300,
        pointsB: 200,
        avgMargin: 20,
        streakHolder: f1,
        streakLen: 1,
        largestWinJson: null,
        closestGameJson: null,
        lastMeetingJson: { season: 2015, week: 2 },
      },
    ])
    .run();

  const player1 = db.insert(players).values({ espnPlayerId: 101, fullName: "Test Player A", defaultPosition: "RB" }).returning().get();
  const player2 = db.insert(players).values({ espnPlayerId: 102, fullName: "Test Player B", defaultPosition: "WR" }).returning().get();

  db.insert(draftPicks)
    .values([
      { season: 2015, round: 1, roundPick: 1, overallPick: 1, teamSeasonId: ts2015F1, playerId: player1.espnPlayerId, keeper: false },
      { season: 2015, round: 1, roundPick: 2, overallPick: 2, teamSeasonId: ts2015F2, playerId: player2.espnPlayerId, keeper: true },
    ])
    .run();

  // Task 12: context_notes for the one real matchup this fixture has (2015 wk1, f1 home over f2)
  // — 4 candidates for that one matchup, deliberately more than the top-3 cap so the query layer's
  // ORDER BY salience DESC LIMIT 3 is actually exercised, not just trivially satisfied.
  db.insert(contextNotes)
    .values([
      { buildId, subjectType: "team_week", season: 2015, week: 1, franchiseId: f1, matchupId: matchup2015Wk1, ruleId: "all_time_score_rank", salience: 90, renderedText: "Highest score in league history" },
      { buildId, subjectType: "matchup", season: 2015, week: 1, franchiseId: null, matchupId: matchup2015Wk1, ruleId: "belt_stakes", salience: 60, renderedText: "The belt changes hands — 1st reign for Gridiron Gladiators" },
      { buildId, subjectType: "team_week", season: 2015, week: 1, franchiseId: f2, matchupId: matchup2015Wk1, ruleId: "streak_context", salience: 45, renderedText: "Extends the losing streak to 4 — franchise record is 6" },
      { buildId, subjectType: "team_week", season: 2015, week: 1, franchiseId: f1, matchupId: matchup2015Wk1, ruleId: "career_milestone", salience: 40, renderedText: "Manager's 25th career win" },
    ])
    .run();
});

afterAll(() => {
  sqlite.close();
  // Every query function under test opened `db/client.ts`'s lazy singleton (a SECOND connection
  // to the same temp file, alongside `sqlite` above) — has to be closed too, or Windows holds an
  // exclusive lock on the temp directory and rmSync below fails with EPERM.
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe("franchises queries", () => {
  it("getFranchiseIndex returns every franchise, active-first by Elo desc", () => {
    const rows = getFranchiseIndex();
    expect(rows.map((r) => r.id)).toEqual([f2, f1, f3, f4]); // f2(1620) > f1(1550) > f3(1420) active; f4 departed
    expect(rows.find((r) => r.id === f1)!.beltReignCount).toBe(1);
  });

  it("getFranchiseHeader resolves managers, career stats, and belt reign count", () => {
    const header = getFranchiseHeader(f1)!;
    expect(header.name).toBe("Gridiron Gladiators");
    expect(header.managers).toEqual([
      { name: "Alice", fromSeason: 2015, toSeason: 2015 },
      { name: "Zoe", fromSeason: 2016, toSeason: null },
    ]);
    expect(header.championships).toBe(1);
    expect(header.beltReignCount).toBe(1);
    expect(header.beatdowns).toBe(3); // Task 17
  });

  it("getFranchiseHeader returns null for an unknown id", () => {
    expect(getFranchiseHeader(999999)).toBeNull();
  });

  it("getFranchiseEloSeries reads only this franchise's rows and stops at departure for f4", () => {
    const series = getFranchiseEloSeries(f4);
    expect(series.points).toHaveLength(2);
    expect(series.seasonTicks).toEqual([{ x: 0, season: 2015 }]);
  });

  it("getFranchiseSeasons joins team_seasons and season_stats, newest first", () => {
    const rows = getFranchiseSeasons(f1);
    expect(rows.map((r) => r.season)).toEqual([2016, 2015]);
    expect(rows[1]!.champion).toBe(true);
    expect(rows[1]!.efficiencyAvg).toBeNull(); // pre-2018 -> null, never 0
    expect(rows[0]!.efficiencyAvg).toBe(0.87);
  });

  it("getFranchiseBeltHistory resolves wonFromName and marks the current reign", () => {
    const rows = getFranchiseBeltHistory(f3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.wonFromName).toBe("Blue Thunder");
    expect(rows[0]!.isCurrent).toBe(true);
  });

  it("getFranchiseH2H flips perspective correctly for both sides of a real pair", () => {
    const rowsF1 = getFranchiseH2H(f1);
    const vsF2 = rowsF1.find((r) => r.opponentId === f2)!;
    expect(vsF2.opponentName).toBe("Blue Thunder");
    expect(vsF2.wins + vsF2.losses).toBe(4);
  });

  it("getFranchiseRecords only returns rank<=3 entries for that franchise", () => {
    const rows = getFranchiseRecords(f1);
    expect(rows.every((r) => r.rank <= 3)).toBe(true);
    expect(rows.some((r) => r.recordKey === "longest_belt_reign")).toBe(true);
  });
});

describe("records queries", () => {
  it("getRecordBook resolves franchise names and groups correctly end-to-end", () => {
    const groups = getRecordBook();
    const singleWeek = groups.find((g) => g.group === "single-week")!;
    const highestWeek = singleWeek.sections.find((s) => s.key === "highest_week_score")!;
    expect(highestWeek.rows[0]).toMatchObject({ franchiseName: "Blue Thunder", value: 140 });
  });
});

describe("h2h queries", () => {
  it("getActiveH2HMatrix includes only active franchises (excludes departed f4)", () => {
    const matrix = getActiveH2HMatrix();
    expect(matrix.franchises.map((f) => f.id).sort()).toEqual([f1, f2, f3].sort());
  });

  it("getHistoricalH2H includes the departed franchise with its real opponents", () => {
    const historical = getHistoricalH2H();
    const dynasty = historical.find((h) => h.franchiseId === f4)!;
    expect(dynasty.opponents.some((o) => o.opponentId === f1)).toBe(true);
  });

  it("getH2HPairDetail works regardless of argument order and resolves names/streak", () => {
    const forward = getH2HPairDetail(f1, f2)!;
    const backward = getH2HPairDetail(f2, f1)!;
    expect(forward).not.toBeNull();
    expect(forward.franchiseA.id).toBe(backward.franchiseA.id);
    expect(forward.streak!.holderName).toBe("Gridiron Gladiators");
  });

  it("getH2HPairDetail returns null for a pair with no recorded history", () => {
    expect(getH2HPairDetail(f3, f4)).toBeNull();
  });
});

describe("seasons queries", () => {
  it("getSeasonIndex resolves champion/runnerUp/sacko/highestWeek per season", () => {
    const rows = getSeasonIndex();
    const s2015 = rows.find((r) => r.season === 2015)!;
    expect(s2015.champion).toEqual({ id: f1, name: "Gridiron Gladiators" });
    expect(s2015.sacko).toEqual({ id: f4, name: "Departed Dynasty" });
    expect(s2015.highestWeek).toMatchObject({ franchiseName: "Blue Thunder", value: 140 });
  });

  it("getSeasonStandings joins team_seasons+season_stats ordered by final standing", () => {
    const rows = getSeasonStandings(2015);
    expect(rows.map((r) => r.franchiseId)).toEqual([f1, f2, f3, f4]);
    expect(rows[0]!.champion).toBe(true);
    expect(rows[3]!.sacko).toBe(true);
  });

  it("getSeasonWeeks groups matchups under their week with resolved franchise names", () => {
    const weeksResult = getSeasonWeeks(2015);
    expect(weeksResult).toHaveLength(2);
    const week1 = weeksResult.find((w) => w.week === 1)!;
    expect(week1.matchups[0]).toMatchObject({ homeFranchiseName: "Gridiron Gladiators", awayFranchiseName: "Blue Thunder" });
  });

  it("getSeasonDraftBoard builds a real grid from draft_picks+players+team_seasons", () => {
    const board = getSeasonDraftBoard(2015);
    expect(board.teamCount).toBe(4);
    expect(board.grid[0]![0]).toMatchObject({ playerName: "Test Player A", teamName: "F1 2015 Name" });
    expect(board.grid[0]![1]).toMatchObject({ playerName: "Test Player B", keeper: true });
  });

  it("getSeasonBeltActivity resolves holder/challenger names for that season", () => {
    const rows = getSeasonBeltActivity(2015);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ holderName: "Gridiron Gladiators", challengerName: "Blue Thunder", result: "transfer" });
  });

  it("getSeasonSuperlatives resolves names for the season's highest week/blowout/closest game", () => {
    const superlatives = getSeasonSuperlatives(2015);
    expect(superlatives.highestWeek).toMatchObject({ franchiseName: "Blue Thunder", value: 140 });
    expect(superlatives.biggestBlowout).toMatchObject({ winnerName: "Blue Thunder", loserName: "Departed Dynasty" });
    expect(superlatives.closestGame).toMatchObject({ margin: 5 });
  });
});

describe("belt queries", () => {
  it("getCurrentBeltHolder resolves the is_current reign's franchise", () => {
    expect(getCurrentBeltHolder()).toMatchObject({ franchiseName: "Red Rockets", reignNo: 3 });
  });

  it("getBeltLineage returns all reigns, most recent first, with wonFromName resolved", () => {
    const lineage = getBeltLineage();
    expect(lineage.map((r) => r.reignNo)).toEqual([3, 2, 1]);
    expect(lineage[0]!.wonFromName).toBe("Blue Thunder");
    expect(lineage[2]!.wonFromName).toBeNull(); // reign 1 — inaugural, no prior holder
  });

  it("getBeltRecords aggregates reign count/weeks/defenses across all reigns", () => {
    const records = getBeltRecords();
    expect(records.longestReign).toMatchObject({ name: "Gridiron Gladiators", weeksHeld: 2 });
  });

  it("getCurrentReignDetail resolves the title-winning match's score", () => {
    const detail = getCurrentReignDetail()!;
    expect(detail.franchiseName).toBe("Red Rockets");
    expect(detail.wonFromName).toBe("Blue Thunder");
    expect(detail.wonFromScore).toBe(100);
    expect(detail.holderWinScore).toBe(110);
  });
});

describe("home queries", () => {
  it("getChampion resolves the season's champion franchise", () => {
    expect(getChampion(2015)).toMatchObject({ franchiseName: "Gridiron Gladiators" });
    expect(getChampion(2099)).toBeNull();
  });

  it("getTopRecord resolves the #1 record_entries row for a key", () => {
    expect(getTopRecord("highest_week_score")).toMatchObject({ franchiseName: "Blue Thunder", value: 140 });
  });

  it("getEloTop orders career_stats by current Elo descending", () => {
    const top = getEloTop(2);
    expect(top.map((r) => r.franchiseId)).toEqual([f2, f1]);
  });

  it("getDraftCountdown falls back to the default date when app_settings has no draft_date row", () => {
    const countdown = getDraftCountdown(new Date("2026-08-04T00:00:00Z"));
    expect(countdown.targetDateIso).toBe("2026-08-29");
    expect(countdown.daysRemaining).toBe(25);
  });

  it("getDraftCountdown reads a real app_settings override once one exists", () => {
    db.insert(appSettings).values({ key: "draft_date", valueJson: "2027-01-01", updatedAt: new Date() }).run();
    const countdown = getDraftCountdown(new Date("2026-12-01T00:00:00Z"));
    expect(countdown.targetDateIso).toBe("2027-01-01");
    db.delete(appSettings).where(eq(appSettings.key, "draft_date")).run();
  });

  it("getLastTimeOut resolves the most recent completed week and returns its top 3 notes, salience order, franchise names resolved", () => {
    // The fixture has exactly one real `matchups` row (2015 wk1) — that's necessarily "the most
    // recent completed week" here regardless of how much OTHER derived data references 2016.
    const result = getLastTimeOut();
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ season: 2015, week: 1 });
    expect(result!.notes).toHaveLength(3); // the 4th candidate (career_milestone, salience 40) is capped out
    expect(result!.notes.map((n) => n.ruleId)).toEqual(["all_time_score_rank", "belt_stakes", "streak_context"]);
    expect(result!.notes[1]).toMatchObject({ isBeltNote: true, renderedText: "The belt changes hands — 1st reign for Gridiron Gladiators" });
    expect(result!.notes[0].isBeltNote).toBe(false);
    // team_week-subject notes resolve a franchise name; the matchup-subject belt note has none.
    expect(result!.notes[0].franchiseName).toBe("Gridiron Gladiators");
    expect(result!.notes[1].franchiseName).toBeNull();
  });
});

describe("matchups queries — Task 12 context notes surfacing", () => {
  it("getMatchupDetail.contextNotes returns the top 3 (of 4 candidates) across both team-weeks + the matchup itself, salience order", () => {
    const detail = getMatchupDetail(matchup2015Wk1);
    expect(detail).not.toBeNull();
    expect(detail!.contextNotes).toHaveLength(3);
    expect(detail!.contextNotes.map((n) => n.ruleId)).toEqual(["all_time_score_rank", "belt_stakes", "streak_context"]);
    expect(detail!.contextNotes[0]).toMatchObject({ salience: 90, franchiseId: f1, franchiseName: "Gridiron Gladiators", isBeltNote: false });
    expect(detail!.contextNotes[1]).toMatchObject({ salience: 60, franchiseId: null, franchiseName: null, isBeltNote: true });
    // career_milestone (salience 40) never appears — capped out, not merely deprioritized.
    expect(detail!.contextNotes.some((n) => n.ruleId === "career_milestone")).toBe(false);
  });

  it("getWeekMatchupRows.topNote surfaces the single highest-salience note for the matchup", () => {
    const rows = getWeekMatchupRows(2015, 1);
    const row = rows.find((r) => r.matchupId === matchup2015Wk1)!;
    expect(row.topNote).toMatchObject({ ruleId: "all_time_score_rank", renderedText: "Highest score in league history", isBeltNote: false });
  });
});
