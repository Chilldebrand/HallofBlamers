/**
 * Task 31 — pick'em lock semantics + "The Algorithm" AI-pick computation. Seeds tables directly
 * (franchises/team_seasons/matchups/elo_history/snapshots/app_settings) rather than running a full
 * sync tier — same "insert a fixture row directly" style run-tier.test.ts's isSeasonUnderway suite
 * uses for its corrupt-snapshot case.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { appSettings, eloHistory, franchises, leagues, matchups, pickemPicks, seasons, snapshots, statBuilds, teamSeasons } from "../../db/schema";
import { getCurrentPickemWeek } from "../../queries/pickem";
import { SEASON_SCOPE_VIEW_KEY } from "../espn-shapes";
import {
  computeAndStoreAlgorithmPicks,
  getPickemAiEnabled,
  isPickemLocked,
  isThursdayLockPassed,
  loadPreLockEloByFranchise,
  PICKEM_AI_ENABLED_KEY,
} from "../pickem-lock";

const SEASON = 2026;

describe("isThursdayLockPassed — pure wall-clock check (America/New_York)", () => {
  // Reference week reused from live-window.test.ts: 2026-09-02 Wed .. 09-08 Tue, all EDT (UTC-4).

  it("is false any time Monday through Wednesday", () => {
    expect(isThursdayLockPassed(new Date("2026-09-07T08:00:00-04:00"))).toBe(false); // Mon
    expect(isThursdayLockPassed(new Date("2026-09-08T23:00:00-04:00"))).toBe(false); // Tue
    expect(isThursdayLockPassed(new Date("2026-09-02T23:59:59-04:00"))).toBe(false); // Wed
  });

  it("is false one minute before Thursday 20:00 ET, true exactly at the boundary", () => {
    expect(isThursdayLockPassed(new Date("2026-09-03T19:59:00-04:00"))).toBe(false);
    expect(isThursdayLockPassed(new Date("2026-09-03T20:00:00-04:00"))).toBe(true);
  });

  it("stays true through Friday, Saturday, and Sunday", () => {
    expect(isThursdayLockPassed(new Date("2026-09-04T10:00:00-04:00"))).toBe(true); // Fri
    expect(isThursdayLockPassed(new Date("2026-09-05T10:00:00-04:00"))).toBe(true); // Sat
    expect(isThursdayLockPassed(new Date("2026-09-06T23:59:59-04:00"))).toBe(true); // Sun
  });

  it("flips back to false starting Monday 00:00 ET (a new open week)", () => {
    expect(isThursdayLockPassed(new Date("2026-09-07T00:00:00-04:00"))).toBe(false);
  });

  it("respects the DST-adjusted America/New_York offset in winter (EST, UTC-5)", () => {
    // 2026-12-03 is a Thursday, EST in effect (no DST in December) — same reference date
    // live-window.test.ts uses for its own DST case.
    expect(isThursdayLockPassed(new Date("2026-12-03T19:59:00-05:00"))).toBe(false);
    expect(isThursdayLockPassed(new Date("2026-12-03T20:00:00-05:00"))).toBe(true);
  });
});

describe("Task 31 DB-backed suite", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-pickem-lock-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSeasonScopeSnapshot(latestScoringPeriod: number): void {
    db.insert(snapshots)
      .values({
        season: SEASON,
        scoringPeriod: null,
        view: SEASON_SCOPE_VIEW_KEY,
        url: "https://example.com/season",
        fetchedAt: new Date(),
        httpStatus: 200,
        payload: JSON.stringify({ status: { latestScoringPeriod } }),
        payloadHash: "test-hash",
      })
      .run();
  }

  /** seasons.season -> leagues.id is a hard FK, and team_seasons.season -> seasons.season is too
   * — seed both once per test DB. Idempotent-safe to call more than once per test (upsert-free,
   * only ever called once here, but guarded anyway via a plain existence check). */
  function seedSeasonRow(): void {
    const existing = db.select({ season: seasons.season }).from(seasons).all();
    if (existing.some((s) => s.season === SEASON)) return;
    const leagueId = db.insert(leagues).values({ espnLeagueId: 1690915927, name: "Test League", firstSeason: SEASON }).returning().get().id;
    db.insert(seasons)
      .values({
        season: SEASON,
        leagueId,
        settingsJson: {},
        scoringJson: {},
        playoffFormatJson: {},
        teamCount: 2,
        regSeasonWeeks: 14,
        status: "upcoming",
      })
      .run();
  }

  /** franchiseId/espnTeamId are auto-derived from a running counter so this can be called
   * repeatedly (multiple matchups/weeks) within one test without id collisions. */
  let franchiseCounter = 0;
  function seedFranchiseAndTeam(): { franchiseId: number; teamSeasonId: number } {
    franchiseCounter++;
    const franchiseId = db
      .insert(franchises)
      .values({ canonicalName: `Franchise ${franchiseCounter}`, managerName: `Manager ${franchiseCounter}`, joinedSeason: SEASON })
      .returning()
      .get().id;
    const teamSeasonId = db
      .insert(teamSeasons)
      .values({
        season: SEASON,
        franchiseId,
        espnTeamId: franchiseCounter,
        teamName: `Franchise ${franchiseCounter}`,
        wins: 0,
        losses: 0,
        ties: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        madePlayoffs: false,
      })
      .returning()
      .get().id;
    return { franchiseId, teamSeasonId };
  }

  /** Seeds one two-sided matchup for (SEASON, week) with the given score/final state — the
   * general-purpose fixture builder fix round 1's new tests need (a preseason 0-0 shell, a
   * mid-week real-but-not-final score, a fully final result, etc.), replacing the old fixed
   * always-0-0-week-1 `seedTwoFranchiseMatchup` helper. */
  function seedMatchup(week: number, opts: { homeScore?: number; awayScore?: number; isFinal?: boolean; winner?: "home" | "away" | "tie" | null } = {}): {
    matchupId: number;
    franchiseA: number;
    franchiseB: number;
  } {
    seedSeasonRow();
    const { franchiseId: franchiseA, teamSeasonId: teamA } = seedFranchiseAndTeam();
    const { franchiseId: franchiseB, teamSeasonId: teamB } = seedFranchiseAndTeam();
    const matchupId = db
      .insert(matchups)
      .values({
        season: SEASON,
        week,
        espnMatchupId: 1000 + week * 10 + franchiseCounter,
        homeTeamSeasonId: teamA,
        awayTeamSeasonId: teamB,
        homeScore: opts.homeScore ?? 0,
        awayScore: opts.awayScore ?? 0,
        isFinal: opts.isFinal ?? false,
        winner: opts.winner ?? null,
      })
      .returning()
      .get().id;
    return { matchupId, franchiseA, franchiseB };
  }

  /** Back-compat name for the original single-matchup-week-1-all-zero fixture most of this file's
   * pre-existing tests (AI toggle, Elo loading, algorithm-pick computation) still want unchanged. */
  function seedTwoFranchiseMatchup(): { matchupId: number; franchiseA: number; franchiseB: number } {
    return seedMatchup(1);
  }

  function enableAi(): void {
    db.insert(appSettings).values({ key: PICKEM_AI_ENABLED_KEY, valueJson: true, updatedAt: new Date() }).run();
  }

  describe("getPickemAiEnabled", () => {
    it("defaults to false with no app_settings row at all", () => {
      expect(getPickemAiEnabled(db)).toBe(false);
    });

    it("is true once the commissioner's toggle is saved", () => {
      enableAi();
      expect(getPickemAiEnabled(db)).toBe(true);
    });
  });

  describe("isPickemLocked — fix round 1: isSeasonUnderway AND (isThursdayLockPassed OR hasAnyGameBegun)", () => {
    // Reference week reused from live-window.test.ts / isThursdayLockPassed's own tests above:
    // 2026-09-02 Wed .. 09-08 Tue, all EDT (UTC-4); 2026-12-03 Thu is the DST(EST) reference date.

    it("(a) REPRODUCED FAILURE, now fixed: Tuesday after a played weekend, week still current (some matchups final, all with real scores) -> LOCKED", () => {
      seedSeasonScopeSnapshot(1); // season underway
      seedMatchup(1, { homeScore: 118.4, awayScore: 96.2, isFinal: true, winner: "home" }); // Thu/Sun game, decided
      seedMatchup(1, { homeScore: 41.6, awayScore: 33.0, isFinal: false }); // Monday Night, real score, not final yet

      const tuesday = new Date("2026-09-08T09:00:00-04:00");
      expect(isThursdayLockPassed(tuesday)).toBe(false); // the wall-clock floor alone says "open" — the bug
      expect(isPickemLocked(db, SEASON, 1, tuesday)).toBe(true); // the data floor holds the lock anyway
    });

    it("(b) Wednesday with the NEXT week now current and untouched (all 0.0, none final) -> UNLOCKED for the new week", () => {
      seedSeasonScopeSnapshot(1);
      seedMatchup(1, { homeScore: 118.4, awayScore: 96.2, isFinal: true, winner: "home" }); // week 1 fully final
      seedMatchup(2, { homeScore: 0, awayScore: 0, isFinal: false }); // week 2 untouched preseason-shaped shell

      // computeCurrentPickemWeek has genuinely rolled over — week 2 is "current" now, not week 1.
      expect(getCurrentPickemWeek(db)).toEqual({ season: SEASON, week: 2 });

      const wednesday = new Date("2026-09-09T09:00:00-04:00");
      expect(isPickemLocked(db, SEASON, 2, wednesday)).toBe(false);
    });

    it("an UNSTARTED week's own pre-Thursday Tuesday (no scores yet at all) also stays open — distinct from case (a)'s POST-weekend Tuesday", () => {
      seedSeasonScopeSnapshot(1);
      seedMatchup(1, { homeScore: 0, awayScore: 0, isFinal: false }); // this week hasn't kicked off yet
      const tuesday = new Date("2026-09-08T12:00:00-04:00");
      expect(isPickemLocked(db, SEASON, 1, tuesday)).toBe(false);
    });

    it("(c) Thursday 20:00 ET boundary locks even BEFORE any score arrives, incl. a DST-sensitive (EST) instant", () => {
      seedSeasonScopeSnapshot(1);
      seedMatchup(1, { homeScore: 0, awayScore: 0, isFinal: false }); // nothing has happened yet

      expect(isPickemLocked(db, SEASON, 1, new Date("2026-09-03T19:59:00-04:00"))).toBe(false); // one minute early
      expect(isPickemLocked(db, SEASON, 1, new Date("2026-09-03T20:00:00-04:00"))).toBe(true); // EDT boundary
      expect(isPickemLocked(db, SEASON, 1, new Date("2026-12-03T20:00:00-05:00"))).toBe(true); // EST (DST) boundary
    });

    it("(d) real 2026 preseason state (84 scheduled matchups, latestScoringPeriod 0): NEVER locked, unchanged from before this fix", () => {
      seedSeasonScopeSnapshot(0);
      seedMatchup(1, { homeScore: 0, awayScore: 0, isFinal: false });
      // Saturday — isThursdayLockPassed(now) alone would read true.
      const saturday = new Date("2026-08-08T12:00:00-04:00");
      expect(isThursdayLockPassed(saturday)).toBe(true);
      expect(isPickemLocked(db, SEASON, 1, saturday)).toBe(false);
    });

    it("no season-scope snapshot archived at all -> isSeasonUnderway false -> never locked, even with real final scores on record", () => {
      seedMatchup(1, { homeScore: 118.4, awayScore: 96.2, isFinal: true, winner: "home" });
      expect(isPickemLocked(db, SEASON, 1, new Date("2026-09-03T21:00:00-04:00"))).toBe(false);
    });
  });

  describe("loadPreLockEloByFranchise", () => {
    it("returns each franchise's eloPost from its MOST RECENT (season, week) row, not eloPre and not an earlier week", () => {
      const buildId = db.insert(statBuilds).values({ startedAt: new Date(), status: "ok", inputHash: "test-hash" }).returning().get().id;
      const { franchiseA } = seedTwoFranchiseMatchup();
      db.insert(eloHistory).values([
        { buildId, season: 2025, week: 16, franchiseId: franchiseA, eloPre: 1480, eloPost: 1500 },
        { buildId, season: 2025, week: 17, franchiseId: franchiseA, eloPre: 1500, eloPost: 1560 }, // latest -> expected
      ]).run();

      const elo = loadPreLockEloByFranchise(db);
      expect(elo.get(franchiseA)).toBe(1560);
    });

    it("a franchise with zero elo_history rows is simply absent from the map (never fabricated)", () => {
      expect(loadPreLockEloByFranchise(db).size).toBe(0);
    });
  });

  describe("computeAndStoreAlgorithmPicks", () => {
    const THURSDAY_LOCK = new Date("2026-09-03T20:00:00-04:00");
    const PRESEASON_NOW = new Date("2026-08-08T12:00:00-04:00");
    const TUESDAY_NOW = new Date("2026-09-08T12:00:00-04:00");

    it("skips when the AI toggle is disabled (default)", () => {
      seedSeasonScopeSnapshot(1);
      seedTwoFranchiseMatchup();
      const result = computeAndStoreAlgorithmPicks(db, SEASON, THURSDAY_LOCK);
      expect(result).toEqual({ inserted: 0, skippedReason: "ai-disabled" });
      expect(db.select().from(pickemPicks).all()).toEqual([]);
    });

    it("skips (not-locked-yet) mid-week even with AI enabled", () => {
      enableAi();
      seedSeasonScopeSnapshot(1);
      seedTwoFranchiseMatchup();
      const result = computeAndStoreAlgorithmPicks(db, SEASON, TUESDAY_NOW);
      expect(result).toEqual({ inserted: 0, skippedReason: "not-locked-yet" });
    });

    it("real 2026 preseason state: skips (not-locked-yet) even on a day isThursdayLockPassed alone would call locked", () => {
      enableAi();
      seedSeasonScopeSnapshot(0);
      seedTwoFranchiseMatchup();
      const result = computeAndStoreAlgorithmPicks(db, SEASON, PRESEASON_NOW);
      expect(result).toEqual({ inserted: 0, skippedReason: "not-locked-yet" });
      expect(db.select().from(pickemPicks).all()).toEqual([]);
    });

    it("at lock time, with AI enabled: computes and stores exactly one pick per matchup, favoring the higher pre-lock Elo side", () => {
      enableAi();
      seedSeasonScopeSnapshot(1);
      const { matchupId, franchiseA, franchiseB } = seedTwoFranchiseMatchup();
      const buildId = db.insert(statBuilds).values({ startedAt: new Date(), status: "ok", inputHash: "test-hash" }).returning().get().id;
      db.insert(eloHistory).values([
        { buildId, season: 2025, week: 17, franchiseId: franchiseA, eloPre: 1500, eloPost: 1650 },
        { buildId, season: 2025, week: 17, franchiseId: franchiseB, eloPre: 1500, eloPost: 1350 },
      ]).run();

      const result = computeAndStoreAlgorithmPicks(db, SEASON, THURSDAY_LOCK);
      expect(result).toEqual({ inserted: 1, skippedReason: null });

      const rows = db.select().from(pickemPicks).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.matchupId).toBe(matchupId);
      expect(rows[0]!.pickedFranchiseId).toBe(franchiseA); // higher Elo
      expect(rows[0]!.managerId).toBeNull();
      expect(rows[0]!.isAlgorithm).toBe(true);
    });

    it("is idempotent: a second call after the picks already exist inserts nothing new", () => {
      enableAi();
      seedSeasonScopeSnapshot(1);
      seedTwoFranchiseMatchup();

      const first = computeAndStoreAlgorithmPicks(db, SEASON, THURSDAY_LOCK);
      expect(first.inserted).toBe(1);

      const second = computeAndStoreAlgorithmPicks(db, SEASON, new Date("2026-09-03T22:00:00-04:00"));
      expect(second).toEqual({ inserted: 0, skippedReason: "already-computed" });
      expect(db.select().from(pickemPicks).all()).toHaveLength(1);
    });

    it("same Elo state across repeated (idempotent-guard-bypassed) computations would produce the same picks — determinism carried through from the pure engine", () => {
      const buildId = db.insert(statBuilds).values({ startedAt: new Date(), status: "ok", inputHash: "test-hash" }).returning().get().id;
      const { franchiseA, franchiseB } = seedTwoFranchiseMatchup();
      db.insert(eloHistory).values([
        { buildId, season: 2025, week: 17, franchiseId: franchiseA, eloPre: 1500, eloPost: 1520 },
        { buildId, season: 2025, week: 17, franchiseId: franchiseB, eloPre: 1500, eloPost: 1480 },
      ]).run();

      const elo1 = loadPreLockEloByFranchise(db);
      const elo2 = loadPreLockEloByFranchise(db);
      expect([...elo1.entries()]).toEqual([...elo2.entries()]);
    });
  });
});
