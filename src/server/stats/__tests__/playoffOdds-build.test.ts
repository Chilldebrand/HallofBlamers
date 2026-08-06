import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, matchups, playoffOdds, seasons, teamSeasons, weeks, type NewMatchup } from "../../db/schema";
import { runStatBuild, validateCompletedScheduleProof } from "../build";

const LEAGUE_ID_COUNTER = { n: 1 };

/**
 * A 4-franchise, 3-regular-week fixture — weeks 1-2 are real, decided finals (so stage 3's
 * `replay()` produces real Elo history for stage 9 to consume); week 3 is left UNFINISHED
 * (`isFinal: false`) so the season has a genuine "remaining regular-season game" for the Monte
 * Carlo engine to simulate. Standings on `team_seasons` are seeded to match the week 1-2 results
 * exactly (T1 2-0, T2/T3 1-1, T4 0-2) — stage 9 reads standings straight off `team_seasons`, same
 * as every other real-data caller.
 */
function seedActiveSeasonFixture(db: Db, opts: { season: number; playoffTeamCount: number | null; leaveWeek3Unplayed: boolean }): Record<"T1" | "T2" | "T3" | "T4", number> {
  const league = db.insert(leagues).values({ espnLeagueId: LEAGUE_ID_COUNTER.n++, name: "Test League", firstSeason: opts.season }).returning().get();

  db.insert(seasons)
    .values({
      season: opts.season,
      leagueId: league.id,
      settingsJson: {},
      scoringJson: {},
      playoffFormatJson: opts.playoffTeamCount !== null ? { playoffTeamCount: opts.playoffTeamCount } : {},
      teamCount: 4,
      regSeasonWeeks: 3,
      status: "active",
    })
    .run();

  const standings: Record<"T1" | "T2" | "T3" | "T4", { wins: number; losses: number; ties: number; pointsFor: number; pointsAgainst: number }> = {
    T1: { wins: 2, losses: 0, ties: 0, pointsFor: 195, pointsAgainst: 160 },
    T2: { wins: 1, losses: 1, ties: 0, pointsFor: 178, pointsAgainst: 190 },
    T3: { wins: 1, losses: 1, ties: 0, pointsFor: 155, pointsAgainst: 180 },
    T4: { wins: 0, losses: 2, ties: 0, pointsFor: 166, pointsAgainst: 205 },
  };

  const franchiseId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
  const teamSeasonId: Partial<Record<"T1" | "T2" | "T3" | "T4", number>> = {};
  for (const key of ["T1", "T2", "T3", "T4"] as const) {
    const f = db.insert(franchises).values({ canonicalName: key, managerName: `${key} Manager`, joinedSeason: opts.season }).returning().get();
    franchiseId[key] = f.id;
    const ts = db
      .insert(teamSeasons)
      .values({
        season: opts.season,
        franchiseId: f.id,
        espnTeamId: franchiseId[key]!,
        teamName: key,
        wins: standings[key].wins,
        losses: standings[key].losses,
        ties: standings[key].ties,
        pointsFor: standings[key].pointsFor,
        pointsAgainst: standings[key].pointsAgainst,
        finalStanding: null,
        madePlayoffs: false,
      })
      .returning()
      .get();
    teamSeasonId[key] = ts.id;
  }

  db.insert(weeks)
    .values([
      { season: opts.season, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true },
      { season: opts.season, week: 2, scoringPeriodId: 2, weekType: "regular", isComplete: true },
      { season: opts.season, week: 3, scoringPeriodId: 3, weekType: "regular", isComplete: !opts.leaveWeek3Unplayed },
    ])
    .run();

  const matchupRows: NewMatchup[] = [
    { season: opts.season, week: 1, espnMatchupId: 1, homeTeamSeasonId: teamSeasonId.T1!, awayTeamSeasonId: teamSeasonId.T2!, homeScore: 100, awayScore: 90, isFinal: true, winner: "home" },
    { season: opts.season, week: 1, espnMatchupId: 2, homeTeamSeasonId: teamSeasonId.T3!, awayTeamSeasonId: teamSeasonId.T4!, homeScore: 85, awayScore: 80, isFinal: true, winner: "home" },
    { season: opts.season, week: 2, espnMatchupId: 3, homeTeamSeasonId: teamSeasonId.T1!, awayTeamSeasonId: teamSeasonId.T3!, homeScore: 95, awayScore: 70, isFinal: true, winner: "home" },
    { season: opts.season, week: 2, espnMatchupId: 4, homeTeamSeasonId: teamSeasonId.T2!, awayTeamSeasonId: teamSeasonId.T4!, homeScore: 88, awayScore: 86, isFinal: true, winner: "home" },
  ];

  if (opts.leaveWeek3Unplayed) {
    matchupRows.push(
      { season: opts.season, week: 3, espnMatchupId: 5, homeTeamSeasonId: teamSeasonId.T1!, awayTeamSeasonId: teamSeasonId.T4!, homeScore: 0, awayScore: 0, isFinal: false, winner: null },
      { season: opts.season, week: 3, espnMatchupId: 6, homeTeamSeasonId: teamSeasonId.T2!, awayTeamSeasonId: teamSeasonId.T3!, homeScore: 0, awayScore: 0, isFinal: false, winner: null },
    );
  } else {
    matchupRows.push(
      { season: opts.season, week: 3, espnMatchupId: 5, homeTeamSeasonId: teamSeasonId.T1!, awayTeamSeasonId: teamSeasonId.T4!, homeScore: 92, awayScore: 60, isFinal: true, winner: "home" },
      { season: opts.season, week: 3, espnMatchupId: 6, homeTeamSeasonId: teamSeasonId.T2!, awayTeamSeasonId: teamSeasonId.T3!, homeScore: 77, awayScore: 60, isFinal: true, winner: "home" },
    );
  }
  db.insert(matchups).values(matchupRows).run();

  return franchiseId as Record<"T1" | "T2" | "T3" | "T4", number>;
}

describe("runStatBuild — stage 9 (playoff odds, Task 52)", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffootball-playoffodds-build-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces one row per franchise for an ACTIVE season with a remaining regular-season game", () => {
    const franchiseId = seedActiveSeasonFixture(db, { season: 2026, playoffTeamCount: 2, leaveWeek3Unplayed: true });
    const result = runStatBuild(db, { force: true });
    expect(result.status).toBe("ok");
    expect(result.rowCounts.playoffOdds).toBe(4);

    const rows = db.select().from(playoffOdds).all();
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(r.season).toBe(2026);
      expect(r.playoffProbability).toBeGreaterThanOrEqual(0);
      expect(r.playoffProbability).toBeLessThanOrEqual(1);
      expect(r.topSeedProbability).toBeGreaterThanOrEqual(0);
      expect(r.topSeedProbability).toBeLessThanOrEqual(1);
      expect(r.runs).toBeGreaterThan(1); // real remaining games exist -> the full Monte Carlo run count, not the degenerate short-circuit
      expect(Array.isArray(r.seedDistributionJson)).toBe(true);
    }

    // T1 (2-0, beat everyone it's played) should be a stronger playoff bet than T4 (0-2).
    const byFranchise = new Map(rows.map((r) => [r.franchiseId, r]));
    expect(byFranchise.get(franchiseId.T1)!.playoffProbability).toBeGreaterThan(byFranchise.get(franchiseId.T4)!.playoffProbability);

    // Invariant: exactly playoffTeamCount (2) seats filled in expectation, every trajectory.
    const total = rows.reduce((a, r) => a + r.playoffProbability, 0);
    expect(total).toBeCloseTo(2, 6);
  });

  it("produces ZERO rows for a COMPLETE season (real finals exist — no simulated odds, honest empty)", () => {
    seedActiveSeasonFixture(db, { season: 2025, playoffTeamCount: 2, leaveWeek3Unplayed: false });
    db.update(seasons).set({ status: "complete" }).where(eq(seasons.season, 2025)).run();

    const result = runStatBuild(db, { force: true });
    expect(result.status).toBe("ok");
    expect(result.rowCounts.playoffOdds).toBe(0);
    expect(db.select().from(playoffOdds).all()).toHaveLength(0);
  });

  it("produces ZERO rows for an UPCOMING season (nothing to simulate from yet)", () => {
    seedActiveSeasonFixture(db, { season: 2027, playoffTeamCount: 2, leaveWeek3Unplayed: true });
    db.update(seasons).set({ status: "upcoming" }).where(eq(seasons.season, 2027)).run();

    const result = runStatBuild(db, { force: true });
    expect(result.status).toBe("ok");
    expect(result.rowCounts.playoffOdds).toBe(0);
  });

  it("skips an active season with no resolvable playoffTeamCount, with a warning, rather than fabricating a bracket size", () => {
    seedActiveSeasonFixture(db, { season: 2028, playoffTeamCount: null, leaveWeek3Unplayed: true });
    const result = runStatBuild(db, { force: true });
    expect(result.status).toBe("ok");
    expect(result.rowCounts.playoffOdds).toBe(0);
    expect(result.warnings.some((w) => w.includes("stage 9") && w.includes("2028"))).toBe(true);
  });

  it("degenerate case: an active season with NO remaining regular-season games reports exactly-decided (0/100%) odds, runs=1", () => {
    const franchiseId = seedActiveSeasonFixture(db, { season: 2029, playoffTeamCount: 2, leaveWeek3Unplayed: false });
    const result = runStatBuild(db, { force: true });
    expect(result.status).toBe("ok");
    expect(result.rowCounts.playoffOdds).toBe(4);

    const rows = db.select().from(playoffOdds).all();
    for (const r of rows) {
      expect(r.runs).toBe(1); // no randomness possible — see src/engines/playoffOdds.ts's short-circuit
      expect([0, 1]).toContain(r.playoffProbability);
      expect([0, 1]).toContain(r.topSeedProbability);
    }
    // T1 (2-0-0 on team_seasons, the fixture's real seeded standings, best record of the four)
    // is the clear #1 seed — week 3's outcome doesn't change team_seasons here (see the fixture's
    // docstring: it's a fixed, ESPN-reported record, not recomputed from matchups).
    const t1Odds = rows.find((r) => r.franchiseId === franchiseId.T1)!;
    expect(t1Odds.topSeedProbability).toBe(1);
    expect(t1Odds.playoffProbability).toBe(1);
  });

  it("writes no 0/100 odds when an active season has no remaining games but lacks independent completion proof", () => {
    seedActiveSeasonFixture(db, { season: 2031, playoffTeamCount: 2, leaveWeek3Unplayed: false });
    db.update(weeks).set({ isComplete: false }).where(eq(weeks.season, 2031)).run();

    const result = runStatBuild(db, { force: true });

    expect(result.status).toBe("ok");
    expect(result.rowCounts.playoffOdds).toBe(0);
    expect(db.select().from(playoffOdds).all()).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("2031") && warning.includes("completion"))).toBe(true);
  });

  it("writes no completed odds when unique standings coverage is smaller than season.teamCount", () => {
    seedActiveSeasonFixture(db, { season: 2032, playoffTeamCount: 2, leaveWeek3Unplayed: false });
    db.update(seasons).set({ teamCount: 6 }).where(eq(seasons.season, 2032)).run();

    const result = runStatBuild(db, { force: true });

    expect(result.status).toBe("ok");
    expect(result.rowCounts.playoffOdds).toBe(0);
    expect(db.select().from(playoffOdds).all()).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("2032") && warning.includes("franchise coverage"))).toBe(true);
  });

  it("rejects completed schedule proof when matchup rows duplicate franchises and omit others", () => {
    const proof = validateCompletedScheduleProof({
      teamCount: 4,
      regSeasonWeeks: 1,
      standingsFranchiseIds: [1, 2, 3, 4],
      regularWeeks: [{ week: 1, isComplete: true }],
      matchups: [
        { week: 1, homeFranchiseId: 1, awayFranchiseId: 2, isFinal: true },
        { week: 1, homeFranchiseId: 2, awayFranchiseId: 1, isFinal: true },
      ],
    });

    expect(proof.complete).toBe(false);
    expect(proof.unavailableReason).toMatch(/franchise coverage/i);
  });

  it("is deterministic: rebuilding against the exact same source data reproduces byte-identical playoff-odds numbers", () => {
    seedActiveSeasonFixture(db, { season: 2030, playoffTeamCount: 2, leaveWeek3Unplayed: true });
    const first = runStatBuild(db, { force: true });
    const firstRows = db.select().from(playoffOdds).all().sort((a, b) => a.franchiseId - b.franchiseId);
    const second = runStatBuild(db, { force: true });
    const secondRows = db.select().from(playoffOdds).all().sort((a, b) => a.franchiseId - b.franchiseId);

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(secondRows.map((r) => ({ franchiseId: r.franchiseId, playoffProbability: r.playoffProbability, topSeedProbability: r.topSeedProbability, seedDistributionJson: r.seedDistributionJson }))).toEqual(
      firstRows.map((r) => ({ franchiseId: r.franchiseId, playoffProbability: r.playoffProbability, topSeedProbability: r.topSeedProbability, seedDistributionJson: r.seedDistributionJson })),
    );
  });
});
