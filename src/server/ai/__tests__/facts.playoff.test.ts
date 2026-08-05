/**
 * Fix round 1, I3 regression coverage: a playoff-week recap must never blend bracket games into
 * the standings/movement it reports, and playoff_picture must never generate for a playoff week.
 * Real-data reproduction of the reviewer's finding: 2025 wk17 (a playoff week) naively summed to
 * Bills Mafia Don 14-2 through cumulative team_week rows, when the real (and team_seasons') record
 * is 13-1 — confirmed directly against data/league.db before writing this fixture. This file
 * mirrors that shape at a small scale: 5 regular-season weeks, then a playoff-week upset that MUST
 * NOT move the standings.
 *
 * Also cross-checks against `getStandingsReal` (src/server/queries/standings.ts), which reads
 * through the `getDb()` singleton — so `DATABASE_PATH` is pointed at this file's temp DB for the
 * whole suite, same pattern as `src/features/admin/__tests__/actions.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb, getSqlite, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { franchises, leagues, matchups, seasons, statBuilds, teamSeasons, teamWeek, weeks } from "@/server/db/schema";
import { buildWeekFacts } from "../facts";
import { getStandingsReal } from "@/server/queries/standings";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

const SEASON = 2025;
let f1: number;
let f2: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-facts-playoff-test-")), "test.db");
  // getStandingsReal() reads through the db/client.ts singleton, not an injected db — point it at
  // this temp file before any call, same as the admin actions test pattern.
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: SEASON }).returning().get();
  db.insert(seasons)
    .values({
      season: SEASON,
      leagueId: league.id,
      settingsJson: {},
      scoringJson: {},
      playoffFormatJson: { playoffTeamCount: 1 },
      teamCount: 2,
      regSeasonWeeks: 5,
      status: "active",
    })
    .run();

  f1 = db.insert(franchises).values({ canonicalName: "Bills Mafia Don", managerName: "Don", joinedSeason: SEASON, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Challenger Co", managerName: "Cass", joinedSeason: SEASON, active: true }).returning().get().id;

  const ts1 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f1, espnTeamId: 1, teamName: "Don's Team", wins: 4, losses: 1, ties: 0, pointsFor: 650, pointsAgainst: 500, finalStanding: 0, madePlayoffs: true })
    .returning()
    .get().id;
  const ts2 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f2, espnTeamId: 2, teamName: "Cass's Team", wins: 1, losses: 4, ties: 0, pointsFor: 500, pointsAgainst: 650, finalStanding: 0, madePlayoffs: false })
    .returning()
    .get().id;

  // 5 regular-season weeks: F1 wins weeks 1-4, F2 wins week 5. Final regular record: F1 4-1, F2 1-4.
  const regularWeeks = [
    { week: 1, winner: "f1" as const },
    { week: 2, winner: "f1" as const },
    { week: 3, winner: "f1" as const },
    { week: 4, winner: "f1" as const },
    { week: 5, winner: "f2" as const },
  ];
  db.insert(weeks)
    .values(regularWeeks.map((w) => ({ season: SEASON, week: w.week, scoringPeriodId: w.week, weekType: "regular" as const, isComplete: true })))
    .run();
  // Playoff week 6 — an upset (F2 beats F1). MUST NOT move the frozen regular-season standings.
  db.insert(weeks).values({ season: SEASON, week: 6, scoringPeriodId: 6, weekType: "playoff", isComplete: true }).run();

  const buildId = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get().id;

  for (const w of regularWeeks) {
    const f1Score = w.winner === "f1" ? 130 : 100;
    const f2Score = w.winner === "f1" ? 100 : 130;
    const matchup = db
      .insert(matchups)
      .values({ season: SEASON, week: w.week, espnMatchupId: w.week, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: f1Score, awayScore: f2Score, isFinal: true, winner: w.winner === "f1" ? "home" : "away" })
      .returning()
      .get();
    db.insert(teamWeek)
      .values([
        { buildId, season: SEASON, week: w.week, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, matchupId: matchup.id, score: f1Score, result: w.winner === "f1" ? "W" : "L", margin: f1Score - f2Score },
        { buildId, season: SEASON, week: w.week, weekType: "regular", teamSeasonId: ts2, franchiseId: f2, opponentFranchiseId: f1, matchupId: matchup.id, score: f2Score, result: w.winner === "f1" ? "L" : "W", margin: f2Score - f1Score },
      ])
      .run();
  }

  // Playoff week 6: F2 upsets F1 (the exact shape of the real bug — a bracket win/loss that must
  // never be folded into the regular-season W-L record).
  const playoffMatchup = db
    .insert(matchups)
    .values({ season: SEASON, week: 6, espnMatchupId: 6, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 90, awayScore: 140, isFinal: true, winner: "away" })
    .returning()
    .get();
  db.insert(teamWeek)
    .values([
      { buildId, season: SEASON, week: 6, weekType: "playoff", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, matchupId: playoffMatchup.id, score: 90, result: "L", margin: -50 },
      { buildId, season: SEASON, week: 6, weekType: "playoff", teamSeasonId: ts2, franchiseId: f2, opponentFranchiseId: f1, matchupId: playoffMatchup.id, score: 140, result: "W", margin: 50 },
    ])
    .run();
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe("buildWeekFacts — playoff weeks never blend into standings (fix round 1, I3)", () => {
  it("a playoff-week recap's standings are frozen at the regular-season final, matching getStandingsReal", () => {
    const facts = buildWeekFacts(db, SEASON, 6);
    const f1Row = facts.standings.find((s) => s.franchiseId === f1)!;
    const f2Row = facts.standings.find((s) => s.franchiseId === f2)!;

    // The real bug: naive cumulative-through-week-6 would show F1 4-2 / F2 2-4. The correct,
    // frozen-at-week-5 answer is F1 4-1 / F2 1-4 — the playoff loss/win never counted.
    expect(f1Row).toMatchObject({ wins: 4, losses: 1, rank: 1 });
    expect(f2Row).toMatchObject({ wins: 1, losses: 4, rank: 2 });

    const real = getStandingsReal(SEASON);
    const realF1 = real.find((r) => r.franchiseId === f1)!;
    const realF2 = real.find((r) => r.franchiseId === f2)!;
    expect(f1Row.wins).toBe(realF1.wins);
    expect(f1Row.losses).toBe(realF1.losses);
    expect(f2Row.wins).toBe(realF2.wins);
    expect(f2Row.losses).toBe(realF2.losses);
  });

  it("a regular-season week's standings are unaffected (no future playoff week can leak backward)", () => {
    const facts = buildWeekFacts(db, SEASON, 5);
    const f1Row = facts.standings.find((s) => s.franchiseId === f1)!;
    expect(f1Row).toMatchObject({ wins: 4, losses: 1, rank: 1 });
  });

  it("meta.bracket is null for a regular week and a short label for the playoff week", () => {
    expect(buildWeekFacts(db, SEASON, 5).meta.bracket).toBeNull();
    expect(buildWeekFacts(db, SEASON, 6).meta.bracket).toBe("playoff bracket");
  });

  it("playoff_picture is present mid-regular-season but absent for a playoff week", () => {
    const regularFacts = buildWeekFacts(db, SEASON, 5);
    expect(regularFacts.playoffPicture).not.toBeNull();

    const playoffFacts = buildWeekFacts(db, SEASON, 6);
    expect(playoffFacts.playoffPicture).toBeNull();
  });
});
