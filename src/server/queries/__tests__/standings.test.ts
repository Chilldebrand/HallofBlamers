import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { careerStats, franchises, leagues, seasonStats, seasons as seasonsTable, statBuilds, teamSeasons, teamWeek } from "../../db/schema";
import {
  computeCloseGames,
  computeDefaultSeason,
  computeLast5AndStreak,
  computeStreak,
  getStandingsCareerSummary,
  getStandingsLuck,
  getStandingsLuckCareer,
  getStandingsRealCareer,
  resolveStandingsScope,
  resolveStandingsTab,
  scheduleHelp,
  sortLuckStandings,
  sortRealCareerStandings,
  sortRealStandings,
  winPct,
  type SeasonOption,
  type StandingsLuckRow,
  type StandingsRealCareerRow,
  type StandingsRealRow,
} from "../standings";

describe("computeStreak", () => {
  it("returns the trailing run of the same result", () => {
    expect(computeStreak(["W", "L", "W", "W", "W"])).toEqual({ type: "W", count: 3 });
  });

  it("a tie resets the streak to null/0", () => {
    expect(computeStreak(["W", "W", "T"])).toEqual({ type: null, count: 0 });
  });

  it("returns null/0 for no games", () => {
    expect(computeStreak([])).toEqual({ type: null, count: 0 });
  });

  it("a streak can restart after a tie", () => {
    expect(computeStreak(["W", "T", "L", "L"])).toEqual({ type: "L", count: 2 });
  });
});

describe("winPct", () => {
  it("ties count as half a win", () => {
    expect(winPct(5, 3, 2)).toBeCloseTo(0.6, 5);
  });

  it("returns 0 for no games rather than dividing by zero", () => {
    expect(winPct(0, 0, 0)).toBe(0);
  });
});

describe("scheduleHelp", () => {
  it("is POSITIVE when the record beats the all-play line (schedule flattered you)", () => {
    // 10-4 real record on middling weekly scores: real .714 vs all-play .500
    expect(scheduleHelp(0.714, 0.5)).toBeGreaterThan(0);
  });

  it("is NEGATIVE when the all-play line beats the record (schedule buried you)", () => {
    expect(scheduleHelp(0.429, 0.65)).toBeLessThan(0);
  });

  it("matches the luck total's direction, not the pre-flip inverted Delta", () => {
    // Regression pin for the 2026-08-04 sign flip: Delta shipped as allplay - real while the
    // Luck tab's Gap was real - allplay — the same stat with opposite signs on adjacent tabs.
    expect(scheduleHelp(0.7, 0.5)).toBeCloseTo(0.2, 10);
  });
});

describe("computeLast5AndStreak", () => {
  it("takes only the trailing 5 played results, ignoring unplayed (null) rows", () => {
    // played (nulls dropped): W, L, W, W, L, W — trailing 5: L, W, W, L, W
    const results: ("W" | "L" | "T" | null)[] = ["W", "L", null, "W", "W", "L", "W"];
    const { last5 } = computeLast5AndStreak(results);
    expect(last5).toEqual({ wins: 3, losses: 2, ties: 0 });
  });

  it("returns fewer than 5 for a season still early", () => {
    const { last5 } = computeLast5AndStreak(["W", "L"]);
    expect(last5).toEqual({ wins: 1, losses: 1, ties: 0 });
  });

  it("last5Sequence keeps the trailing 5 IN ORDER (oldest -> newest), not just aggregate counts — the Real tab's colored squares need the order", () => {
    const results: ("W" | "L" | "T" | null)[] = ["W", "L", null, "W", "W", "L", "W"];
    const { last5Sequence } = computeLast5AndStreak(results);
    expect(last5Sequence).toEqual(["L", "W", "W", "L", "W"]);
  });

  it("last5Sequence is shorter than 5 early in a season, never padded", () => {
    const { last5Sequence } = computeLast5AndStreak(["W", "L"]);
    expect(last5Sequence).toEqual(["W", "L"]);
  });
});

describe("computeCloseGames", () => {
  it("counts only decided games within a 5-point margin", () => {
    const result = computeCloseGames([
      { franchiseId: 1, result: "W", margin: 3 },
      { franchiseId: 1, result: "L", margin: -5 },
      { franchiseId: 1, result: "W", margin: 20 }, // not close
      { franchiseId: 1, result: null, margin: null }, // unplayed
      { franchiseId: 1, result: "T", margin: 0 }, // tie excluded
    ]);
    expect(result).toEqual({ closeWins: 1, closeLosses: 1 });
  });
});

describe("computeDefaultSeason", () => {
  const seasons: SeasonOption[] = [
    { season: 2015, status: "complete" },
    { season: 2025, status: "complete" },
    { season: 2026, status: "upcoming" },
  ];

  it("picks the latest season with completed games", () => {
    expect(computeDefaultSeason(seasons, new Set([2015, 2025]))).toBe(2025);
  });

  it("falls back to the latest complete season when the newest season has no games", () => {
    expect(computeDefaultSeason(seasons, new Set([2015]))).toBe(2015);
  });

  it("falls back to the newest season overall when nothing has games and nothing is complete", () => {
    const allUpcoming: SeasonOption[] = [{ season: 2026, status: "upcoming" }];
    expect(computeDefaultSeason(allUpcoming, new Set())).toBe(2026);
  });

  it("returns null for no seasons at all", () => {
    expect(computeDefaultSeason([], new Set())).toBeNull();
  });
});

describe("resolveStandingsTab", () => {
  it("defaults to Real for a missing tab param", () => {
    expect(resolveStandingsTab(undefined)).toBe("real");
  });

  it("recognizes luck", () => {
    expect(resolveStandingsTab("luck")).toBe("luck");
  });

  it("?tab=allplay — the dead pre-merge All-Play tab URL — falls back to Luck, not Real, not a crash", () => {
    expect(resolveStandingsTab("allplay")).toBe("luck");
  });

  it("falls back to Real for any other garbage value", () => {
    expect(resolveStandingsTab("xyz")).toBe("real");
    expect(resolveStandingsTab("")).toBe("real");
  });
});

describe("resolveStandingsScope", () => {
  const options: SeasonOption[] = [
    { season: 2015, status: "complete" },
    { season: 2025, status: "complete" },
  ];

  it("selects career mode for ?season=career", () => {
    expect(resolveStandingsScope("career", options, 2025)).toBe("career");
  });

  it("selects a recognized season year", () => {
    expect(resolveStandingsScope("2015", options, 2025)).toBe(2015);
  });

  it("falls back to the default season for an unrecognized year", () => {
    expect(resolveStandingsScope("1999", options, 2025)).toBe(2025);
  });

  it("falls back to the default season for garbage", () => {
    expect(resolveStandingsScope("banana", options, 2025)).toBe(2025);
  });

  it("falls back to the default season when the param is missing", () => {
    expect(resolveStandingsScope(undefined, options, 2025)).toBe(2025);
  });
});

describe("sortRealStandings", () => {
  function row(overrides: Partial<StandingsRealRow>): StandingsRealRow {
    return {
      franchiseId: 1,
      franchiseName: "Team",
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      finalStanding: null,
      champion: false,
      sacko: false,
      last5: { wins: 0, losses: 0, ties: 0 },
      last5Sequence: [],
      streak: { type: null, count: 0 },
      ...overrides,
    };
  }

  it("sorts by final_standing ascending when the season is complete", () => {
    const rows = [row({ franchiseId: 1, finalStanding: 3 }), row({ franchiseId: 2, finalStanding: 1 }), row({ franchiseId: 3, finalStanding: 2 })];
    const sorted = sortRealStandings(rows, true);
    expect(sorted.map((r) => r.franchiseId)).toEqual([2, 3, 1]);
  });

  it("sorts by win% desc then points-for desc when the season is NOT complete (final_standing still the 0 placeholder)", () => {
    const rows = [
      row({ franchiseId: 1, wins: 5, losses: 5, pointsFor: 900 }),
      row({ franchiseId: 2, wins: 8, losses: 2, pointsFor: 800 }),
      row({ franchiseId: 3, wins: 8, losses: 2, pointsFor: 950 }), // same win% as 2, higher PF
    ];
    const sorted = sortRealStandings(rows, false);
    expect(sorted.map((r) => r.franchiseId)).toEqual([3, 2, 1]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ franchiseId: 1, finalStanding: 2 }), row({ franchiseId: 2, finalStanding: 1 })];
    const copy = [...rows];
    sortRealStandings(rows, true);
    expect(rows).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, finding 1: production data has a REAL 4-way career win% tie (franchises 4, 16,
// 19, 20 all at .428571), and the Real Career table numbers ranks off array position — an
// incidental (non-deterministic) tie order silently reshuffles which franchise shows as #N on
// every rebuild/render. These pin a full deterministic order for both career sorts, mirroring
// sortRealStandings' own tiebreak precedent (win% desc, then points-for desc) plus a final
// franchise-id key neither table needed before career data existed.
// ---------------------------------------------------------------------------

describe("sortRealCareerStandings", () => {
  function row(overrides: Partial<StandingsRealCareerRow>): StandingsRealCareerRow {
    return {
      franchiseId: 1,
      franchiseName: "Team",
      active: true,
      wins: 0,
      losses: 0,
      ties: 0,
      winPct: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      seasons: 0,
      championships: 0,
      sackos: 0,
      ...overrides,
    };
  }

  it("sorts by win% desc, then points-for desc", () => {
    const rows = [
      row({ franchiseId: 1, winPct: 0.5, pointsFor: 900 }),
      row({ franchiseId: 2, winPct: 0.6, pointsFor: 800 }),
      row({ franchiseId: 3, winPct: 0.6, pointsFor: 950 }), // same win% as 2, higher PF
    ];
    const sorted = sortRealCareerStandings(rows);
    expect(sorted.map((r) => r.franchiseId)).toEqual([3, 2, 1]);
  });

  it("a 4-way win%+PF tie (the real production shape) resolves deterministically by franchise id ascending, regardless of input order", () => {
    const tied = (franchiseId: number) => row({ franchiseId, winPct: 0.428571, pointsFor: 1000 });
    const inputA = [tied(19), tied(4), tied(20), tied(16)];
    const inputB = [tied(16), tied(20), tied(4), tied(19)]; // same rows, different incoming order
    const sortedA = sortRealCareerStandings(inputA);
    const sortedB = sortRealCareerStandings(inputB);
    expect(sortedA.map((r) => r.franchiseId)).toEqual([4, 16, 19, 20]);
    expect(sortedB.map((r) => r.franchiseId)).toEqual([4, 16, 19, 20]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ franchiseId: 1, winPct: 0.5 }), row({ franchiseId: 2, winPct: 0.6 })];
    const copy = [...rows];
    sortRealCareerStandings(rows);
    expect(rows).toEqual(copy);
  });
});

describe("sortLuckStandings", () => {
  function row(overrides: Partial<StandingsLuckRow>): StandingsLuckRow {
    return {
      franchiseId: 1,
      franchiseName: "Team",
      luckTotal: 0,
      closeWins: 0,
      closeLosses: 0,
      realWinPct: 0,
      allplayWinPct: 0,
      allplayW: 0,
      allplayL: 0,
      allplayT: 0,
      gap: 0,
      ...overrides,
    };
  }

  it("sorts by luck total desc, then gap desc", () => {
    const rows = [
      row({ franchiseId: 1, luckTotal: 2, gap: 0.1 }),
      row({ franchiseId: 2, luckTotal: 5, gap: -0.2 }),
      row({ franchiseId: 3, luckTotal: 5, gap: 0.3 }), // same luck as 2, higher gap
    ];
    const sorted = sortLuckStandings(rows);
    expect(sorted.map((r) => r.franchiseId)).toEqual([3, 2, 1]);
  });

  it("null luckTotal sorts as 0, same as the pre-fix behavior", () => {
    const rows = [row({ franchiseId: 1, luckTotal: -1 }), row({ franchiseId: 2, luckTotal: null }), row({ franchiseId: 3, luckTotal: 1 })];
    expect(sortLuckStandings(rows).map((r) => r.franchiseId)).toEqual([3, 2, 1]);
  });

  it("a multi-way luck+gap tie resolves deterministically by franchise id ascending, regardless of input order", () => {
    const tied = (franchiseId: number) => row({ franchiseId, luckTotal: 1.5, gap: 0.05 });
    const inputA = [tied(19), tied(4), tied(20), tied(16)];
    const inputB = [tied(16), tied(20), tied(4), tied(19)];
    expect(sortLuckStandings(inputA).map((r) => r.franchiseId)).toEqual([4, 16, 19, 20]);
    expect(sortLuckStandings(inputB).map((r) => r.franchiseId)).toEqual([4, 16, 19, 20]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ franchiseId: 1, luckTotal: 2 }), row({ franchiseId: 2, luckTotal: 5 })];
    const copy = [...rows];
    sortLuckStandings(rows);
    expect(rows).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// DB-facing: Task 29 Career scope (getStandingsRealCareer / getStandingsLuckCareer /
// getStandingsCareerSummary / getStandingsLuck's merged All-Play fields). Same
// temp-migrated-DB pattern as identity.test.ts's DB-facing block. Two complete seasons
// (2015, 2016) plus a 2026 "upcoming" season with zero games anywhere near it, to prove
// the preseason contributes nothing to career totals (it never reaches career_stats —
// see buildCareerStatsRows' `playedSeasonStats` filter — this just proves the query
// layer doesn't add its own inflation on top).
// ---------------------------------------------------------------------------

describe("Career scope (DB-facing)", () => {
  let db: Db;
  let sqlite: Database.Database;
  let dbPath: string;
  let franchiseA: number; // active — ties franchiseB on career win%, inserted first (stable-sort order check)
  let franchiseB: number; // active
  let franchiseC: number; // departed after 2015

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-standings-career-test-")), "test.db");
    // getStandingsRealCareer/getStandingsLuckCareer/getStandingsLuck/getStandingsCareerSummary all
    // read through the getDb() lazy singleton (db-integration.test.ts's same pattern) rather than
    // an injected Db — point it at this temp file BEFORE their first call. Vitest isolates
    // process.env per test file (separate fork/worker), so this can't leak into other test files.
    process.env.DATABASE_PATH = dbPath;

    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2015 }).returning().get();
    db.insert(seasonsTable)
      .values([
        { season: 2015, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 2, status: "complete" },
        { season: 2016, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 2, status: "complete" },
        // Upcoming, zero games anywhere — no team_seasons/season_stats/team_week rows for it at
        // all, exactly as the real build would leave it. Only affects getStandingsCareerSummary's
        // honest "N seasons on record" count, never the career_stats-backed totals below.
        { season: 2026, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 14, status: "upcoming" },
      ])
      .run();

    franchiseA = db.insert(franchises).values({ canonicalName: "Alpha", managerName: "Ann", joinedSeason: 2015, active: true }).returning().get().id;
    franchiseB = db.insert(franchises).values({ canonicalName: "Bravo", managerName: "Bea", joinedSeason: 2015, active: true }).returning().get().id;
    franchiseC = db
      .insert(franchises)
      .values({ canonicalName: "Charlie", managerName: "Cid", joinedSeason: 2015, departedSeason: 2015, active: false })
      .returning()
      .get().id;

    const ts = (season: number, franchiseId: number, espnTeamId: number, w: number, l: number, pf: number, pa: number, standing: number) =>
      db
        .insert(teamSeasons)
        .values({ season, franchiseId, espnTeamId, teamName: `Team ${franchiseId}`, wins: w, losses: l, ties: 0, pointsFor: pf, pointsAgainst: pa, finalStanding: standing, madePlayoffs: w > l })
        .returning()
        .get().id;

    const tsA2015 = ts(2015, franchiseA, 1, 2, 1, 200, 150, 1);
    const tsB2015 = ts(2015, franchiseB, 2, 1, 2, 150, 200, 2);
    const tsC2015 = ts(2015, franchiseC, 3, 0, 3, 100, 250, 3);
    const tsA2016 = ts(2016, franchiseA, 1, 1, 2, 180, 190, 2);
    const tsB2016 = ts(2016, franchiseB, 2, 2, 1, 210, 170, 1);

    const build = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get();
    const buildId = build.id;

    // Task 29's merged Luck table reads allplayW/L/T straight off season_stats — this doubles as
    // the "merged-table query shape" fixture for getStandingsLuck(2015) below.
    db.insert(seasonStats)
      .values([
        { buildId, season: 2015, franchiseId: franchiseA, wins: 2, losses: 1, ties: 0, pointsFor: 200, pointsAgainst: 150, allplayW: 3, allplayL: 3, allplayT: 0, luckTotal: 1.5, champion: true, sacko: false, madePlayoffs: true },
        { buildId, season: 2016, franchiseId: franchiseA, wins: 1, losses: 2, ties: 0, pointsFor: 180, pointsAgainst: 190, allplayW: 2, allplayL: 4, allplayT: 0, luckTotal: -0.5, champion: false, sacko: false, madePlayoffs: false },
        { buildId, season: 2015, franchiseId: franchiseB, wins: 1, losses: 2, ties: 0, pointsFor: 150, pointsAgainst: 200, allplayW: 3, allplayL: 3, allplayT: 0, luckTotal: -1.0, champion: false, sacko: false, madePlayoffs: false },
        { buildId, season: 2016, franchiseId: franchiseB, wins: 2, losses: 1, ties: 0, pointsFor: 210, pointsAgainst: 170, allplayW: 4, allplayL: 2, allplayT: 0, luckTotal: 0.5, champion: true, sacko: false, madePlayoffs: true },
        { buildId, season: 2015, franchiseId: franchiseC, wins: 0, losses: 3, ties: 0, pointsFor: 100, pointsAgainst: 250, allplayW: 1, allplayL: 5, allplayT: 0, luckTotal: -3.0, champion: false, sacko: true, madePlayoffs: false },
      ])
      .run();

    // career_stats sums (hand-inserted, same as db-integration.test.ts's convention — build.ts's
    // own summing is build.test.ts's job): A = 2015+2016, B = 2015+2016, C = 2015 only.
    db.insert(careerStats)
      .values([
        { buildId, franchiseId: franchiseA, seasons: 2, wins: 3, losses: 3, ties: 0, winPct: 0.5, pointsFor: 380, pointsAgainst: 340, allplayW: 5, allplayL: 7, allplayT: 0, championships: 1, sackos: 0, playoffAppearances: 1, currentElo: 1500, peakElo: 1550, luckTotal: 1.0 },
        { buildId, franchiseId: franchiseB, seasons: 2, wins: 3, losses: 3, ties: 0, winPct: 0.5, pointsFor: 360, pointsAgainst: 370, allplayW: 7, allplayL: 5, allplayT: 0, championships: 1, sackos: 0, playoffAppearances: 1, currentElo: 1500, peakElo: 1550, luckTotal: -0.5 },
        { buildId, franchiseId: franchiseC, seasons: 1, wins: 0, losses: 3, ties: 0, winPct: 0, pointsFor: 100, pointsAgainst: 250, allplayW: 1, allplayL: 5, allplayT: 0, championships: 0, sackos: 1, playoffAppearances: 0, currentElo: 1400, peakElo: 1450, luckTotal: -3.0 },
      ])
      .run();

    // team_week rows across BOTH seasons per franchise — getStandingsLuckCareer derives close
    // games from every row unscoped by season, so this is what actually exercises "sums match
    // per-season rows, no double count" rather than just trusting a hand-set career_stats field.
    db.insert(teamWeek)
      .values([
        { buildId, season: 2015, week: 1, weekType: "regular", teamSeasonId: tsA2015, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 100, result: "W", margin: 3 }, // close win
        { buildId, season: 2015, week: 2, weekType: "regular", teamSeasonId: tsA2015, franchiseId: franchiseA, opponentFranchiseId: franchiseC, score: 100, result: "L", margin: -20 }, // not close
        { buildId, season: 2016, week: 1, weekType: "regular", teamSeasonId: tsA2016, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 96, result: "L", margin: -4 }, // close loss
        { buildId, season: 2016, week: 2, weekType: "regular", teamSeasonId: tsA2016, franchiseId: franchiseA, opponentFranchiseId: franchiseB, score: 115, result: "W", margin: 15 }, // not close
        { buildId, season: 2015, week: 1, weekType: "regular", teamSeasonId: tsB2015, franchiseId: franchiseB, opponentFranchiseId: franchiseA, score: 97, result: "L", margin: -3 }, // close loss
        { buildId, season: 2016, week: 1, weekType: "regular", teamSeasonId: tsB2016, franchiseId: franchiseB, opponentFranchiseId: franchiseA, score: 100, result: "W", margin: 6 }, // not close
        { buildId, season: 2016, week: 2, weekType: "regular", teamSeasonId: tsB2016, franchiseId: franchiseB, opponentFranchiseId: franchiseA, score: 100, result: "T", margin: 0 }, // tie, excluded
        { buildId, season: 2015, week: 1, weekType: "regular", teamSeasonId: tsC2015, franchiseId: franchiseC, opponentFranchiseId: franchiseA, score: 98, result: "L", margin: -2 }, // close loss
        { buildId, season: 2015, week: 2, weekType: "regular", teamSeasonId: tsC2015, franchiseId: franchiseC, opponentFranchiseId: franchiseA, score: 80, result: "L", margin: -30 }, // not close
      ])
      .run();
  });

  afterAll(() => {
    sqlite.close();
    // The query functions under test opened `db/client.ts`'s lazy singleton (a SECOND connection
    // to the same temp file, alongside `sqlite` above, since they call getDb()/getSqlite() rather
    // than taking an injected Db) — has to be closed too, or Windows holds an exclusive lock on
    // the temp directory and rmSync below fails with EPERM. Same fix as db-integration.test.ts.
    getSqlite().close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it("getStandingsLuck(season) carries the merged All-Play record fields (Task 29's merged-table query shape)", () => {
    const rows = getStandingsLuck(2015);
    const a = rows.find((r) => r.franchiseId === franchiseA);
    expect(a).toBeDefined();
    expect({ allplayW: a!.allplayW, allplayL: a!.allplayL, allplayT: a!.allplayT }).toEqual({ allplayW: 3, allplayL: 3, allplayT: 0 });
  });

  it("getStandingsRealCareer: sorted by win% desc, A/B's real win% tie (0.5 each) resolved by points-for desc (A=380 > B=360) not incidental order, departed franchise included and marked inactive", () => {
    const rows = getStandingsRealCareer();
    expect(rows.map((r) => r.franchiseId)).toEqual([franchiseA, franchiseB, franchiseC]);
    expect(rows.find((r) => r.franchiseId === franchiseC)).toMatchObject({ active: false, wins: 0, losses: 3, seasons: 1, sackos: 1 });
    expect(rows.find((r) => r.franchiseId === franchiseA)).toMatchObject({ active: true, wins: 3, losses: 3, winPct: 0.5, seasons: 2, championships: 1 });
  });

  it("getStandingsRealCareer: exactly one row per franchise (no join fan-out double-counting)", () => {
    const rows = getStandingsRealCareer();
    expect(rows).toHaveLength(3);
  });

  it("getStandingsLuckCareer: pass-through fields (wins/allplay/luck) match career_stats exactly, not re-summed on top of it", () => {
    const rows = getStandingsLuckCareer();
    const a = rows.find((r) => r.franchiseId === franchiseA)!;
    expect(a.luckTotal).toBe(1.0);
    expect(winPct(3, 3, 0)).toBeCloseTo(a.realWinPct, 10);
    expect({ allplayW: a.allplayW, allplayL: a.allplayL, allplayT: a.allplayT }).toEqual({ allplayW: 5, allplayL: 7, allplayT: 0 });
  });

  it("getStandingsLuckCareer: gap direction matches scheduleHelp's pinned convention (A's real record beat its all-play line, B's didn't)", () => {
    const rows = getStandingsLuckCareer();
    const a = rows.find((r) => r.franchiseId === franchiseA)!;
    const b = rows.find((r) => r.franchiseId === franchiseB)!;
    expect(a.gap).toBeGreaterThan(0); // 3-3 real vs 5-7 all-play — schedule flattered A
    expect(b.gap).toBeLessThan(0); // 3-3 real vs 7-5 all-play — schedule buried B
  });

  it("getStandingsLuckCareer: close games sum across BOTH seasons, matching computeCloseGames run separately per season (no double count)", () => {
    const rows = getStandingsLuckCareer();
    const a = rows.find((r) => r.franchiseId === franchiseA)!;
    // 2015: 1 close win (margin 3), 1 not-close loss. 2016: 1 close loss (margin -4), 1 not-close win.
    // Summed independently per season: (1 win + 0 win, 0 loss + 1 loss) = (1, 1).
    const season2015Close = computeCloseGames([
      { franchiseId: franchiseA, result: "W", margin: 3 },
      { franchiseId: franchiseA, result: "L", margin: -20 },
    ]);
    const season2016Close = computeCloseGames([
      { franchiseId: franchiseA, result: "L", margin: -4 },
      { franchiseId: franchiseA, result: "W", margin: 15 },
    ]);
    expect(a.closeWins).toBe(season2015Close.closeWins + season2016Close.closeWins);
    expect(a.closeLosses).toBe(season2015Close.closeLosses + season2016Close.closeLosses);
    expect({ closeWins: a.closeWins, closeLosses: a.closeLosses }).toEqual({ closeWins: 1, closeLosses: 1 });
  });

  it("getStandingsLuckCareer: a tied game never counts as a close game either way (B's 2016 wk2 T, margin 0)", () => {
    const rows = getStandingsLuckCareer();
    const b = rows.find((r) => r.franchiseId === franchiseB)!;
    // B: 2015 wk1 close loss (margin -3), 2016 wk1 not-close win (margin 6), 2016 wk2 tie (excluded).
    expect({ closeWins: b.closeWins, closeLosses: b.closeLosses }).toEqual({ closeWins: 0, closeLosses: 1 });
  });

  it("getStandingsCareerSummary: counts the upcoming 2026 preseason honestly in 'seasons on record' without it touching any career total above", () => {
    const summary = getStandingsCareerSummary();
    expect(summary).toEqual({ seasonCount: 3, franchiseCount: 3 });
  });
});
