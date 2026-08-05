import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { events, franchises, leagues, matchups, players, rosterSlots, seasons, snapshots, teamSeasons, type NewRosterSlot } from "../../db/schema";
import { EMISSION_MIN_SEASON } from "../emit-events";
import { emitLineupHoleEvents, LINEUP_EVENT_TYPES, resolvedDedupeKeyFor } from "../lineup-holes";
import { WEEK_SCOPE_VIEW_KEY } from "../espn-shapes";

const SEASON = EMISSION_MIN_SEASON; // 2026 — same fixed-epoch ruling as emit-events
const WEEK = 3;

const STANDARD_LINEUP_SLOT_COUNTS = { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "21": 1, "23": 1 }; // QB1/RB2/WR2/TE1/D-ST1/K1/FLEX1 + BE7/IR1

describe("emitLineupHoleEvents", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;
  let f1: number;
  let f2: number;
  let ts1: number;
  let ts2: number;
  let espnTeamId1: number;
  let espnTeamId2: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-lineup-holes-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: SEASON }).returning().get();
    db.insert(seasons)
      .values({
        season: SEASON,
        leagueId: league.id,
        settingsJson: { rosterSettings: { lineupSlotCounts: STANDARD_LINEUP_SLOT_COUNTS } },
        scoringJson: {},
        playoffFormatJson: {},
        teamCount: 2,
        regSeasonWeeks: 14,
        status: "active",
      })
      .run();

    f1 = db.insert(franchises).values({ canonicalName: "Franchise One", managerName: "Ann", joinedSeason: SEASON, active: true }).returning().get().id;
    f2 = db.insert(franchises).values({ canonicalName: "Franchise Two", managerName: "Ben", joinedSeason: SEASON, active: true }).returning().get().id;

    espnTeamId1 = 11;
    espnTeamId2 = 22;
    ts1 = db
      .insert(teamSeasons)
      .values({ season: SEASON, franchiseId: f1, espnTeamId: espnTeamId1, teamName: "Team One", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
    ts2 = db
      .insert(teamSeasons)
      .values({ season: SEASON, franchiseId: f2, espnTeamId: espnTeamId2, teamName: "Team Two", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;

    db.insert(matchups)
      .values({ season: SEASON, week: WEEK, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 0, awayScore: 0, isFinal: false, winner: null })
      .run();

    db.insert(players)
      .values([
        { espnPlayerId: 1001, fullName: "QB One", defaultPosition: "QB" },
        { espnPlayerId: 1002, fullName: "RB One", defaultPosition: "RB" },
        { espnPlayerId: 1003, fullName: "RB Two", defaultPosition: "RB" },
        { espnPlayerId: 1004, fullName: "WR One", defaultPosition: "WR" },
        { espnPlayerId: 1005, fullName: "WR Two", defaultPosition: "WR" },
        { espnPlayerId: 1006, fullName: "TE One", defaultPosition: "TE" },
        { espnPlayerId: 1007, fullName: "FLEX One", defaultPosition: "WR" },
        { espnPlayerId: 1008, fullName: "DST One", defaultPosition: "D/ST" },
        { espnPlayerId: 1009, fullName: "K One", defaultPosition: "K" },
      ])
      .run();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Starters for team 1 (franchise f1): every configured slot filled EXCEPT the ones the caller
   * omits from `slots` — models a real roster_slots insert (one row per rostered player). */
  function seedStarters(teamSeasonId: number, slots: { playerId: number; lineupSlot: string }[]) {
    const rows: NewRosterSlot[] = slots.map((s) => ({
      season: SEASON,
      week: WEEK,
      teamSeasonId,
      playerId: s.playerId,
      lineupSlot: s.lineupSlot,
      isStarter: true,
      points: null,
      projectedPoints: null,
      eligibleSlotsJson: [s.lineupSlot],
    }));
    if (rows.length === 0) return;
    db.insert(rosterSlots).values(rows).run();
  }

  const FULL_F1_SLOTS = [
    { playerId: 1001, lineupSlot: "QB" },
    { playerId: 1002, lineupSlot: "RB" },
    { playerId: 1003, lineupSlot: "RB" },
    { playerId: 1004, lineupSlot: "WR" },
    { playerId: 1005, lineupSlot: "WR" },
    { playerId: 1006, lineupSlot: "TE" },
    { playerId: 1007, lineupSlot: "FLEX" },
    { playerId: 1008, lineupSlot: "D/ST" },
    { playerId: 1009, lineupSlot: "K" },
  ];

  /** Archives a minimal weekly (`mBoxscore,mMatchupScore,mRoster`) snapshot whose top-level
   * `teams[]` array carries real-shaped injury data — the ONLY source this module reads
   * injuryStatus from (see module docstring). `entry.injuryStatus` is deliberately always
   * "NORMAL" here too, matching the real sentinel-trap shape (never the signal actually read). */
  function seedInjurySnapshot(injuryByPlayerId: Record<number, string>) {
    const teamEntries = (espnTeamId: number, playerIds: number[]) => ({
      id: espnTeamId,
      roster: {
        entries: playerIds.map((playerId) => ({
          lineupSlotId: 0,
          injuryStatus: "NORMAL", // sentinel trap — never the field this module reads
          playerId,
          playerPoolEntry: {
            id: playerId,
            player: { id: playerId, fullName: `Player ${playerId}`, injuryStatus: injuryByPlayerId[playerId] ?? "ACTIVE" },
          },
        })),
      },
    });

    const payload = {
      schedule: [],
      teams: [teamEntries(espnTeamId1, FULL_F1_SLOTS.map((s) => s.playerId)), teamEntries(espnTeamId2, [])],
    };

    db.insert(snapshots)
      .values({
        season: SEASON,
        scoringPeriod: WEEK,
        view: WEEK_SCOPE_VIEW_KEY,
        url: "https://example.com/week",
        fetchedAt: new Date(),
        httpStatus: 200,
        payload: JSON.stringify(payload),
        payloadHash: `hash-${Math.random()}`,
      })
      .run();
  }

  function detectedRows() {
    return db.select().from(events).where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_DETECTED), eq(events.season, SEASON), eq(events.week, WEEK))).all();
  }
  function resolvedRows() {
    return db.select().from(events).where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_RESOLVED), eq(events.season, SEASON), eq(events.week, WEEK))).all();
  }

  // -------------------------------------------------------------------------
  // Scoping rulings
  // -------------------------------------------------------------------------

  it("is a no-op for any season before EMISSION_MIN_SEASON", () => {
    seedStarters(ts1, FULL_F1_SLOTS.filter((s) => s.playerId !== 1002)); // an RB hole, if it ran
    const result = emitLineupHoleEvents(db, { season: EMISSION_MIN_SEASON - 1, week: WEEK });
    expect(result.inserted).toBe(0);
    expect(db.select().from(events).all()).toHaveLength(0);
  });

  it("never flags a franchise whose matchup is already final (sentinel rule)", () => {
    db.update(matchups).set({ isFinal: true, winner: "home", homeScore: 100, awayScore: 90 }).where(eq(matchups.season, SEASON)).run();
    seedStarters(ts1, FULL_F1_SLOTS.filter((s) => s.playerId !== 1002)); // would be an RB hole otherwise
    const result = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(result.inserted).toBe(0);
    expect(detectedRows()).toHaveLength(0);
  });

  it("never fabricates an empty-slot hole when the season's settings can't be resolved", () => {
    db.update(seasons).set({ settingsJson: {} }).where(eq(seasons.season, SEASON)).run();
    seedStarters(ts1, []); // zero starters at all — would be a full-lineup deficit if counts resolved
    const result = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(result.inserted).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Detection + idempotence
  // -------------------------------------------------------------------------

  it("detects an empty RB slot and is idempotent on re-run (zero new rows)", () => {
    seedStarters(ts1, FULL_F1_SLOTS.filter((s) => s.playerId !== 1002));
    seedStarters(ts2, FULL_F1_SLOTS); // franchise f2 stays fully healthy in every test below, so
    // assertions can focus on f1's scenario without f2 contributing unrelated holes.

    const first = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(first.inserted).toBe(1);
    const rows = detectedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.franchiseId).toBe(f1);
    expect(rows[0]!.payloadJson).toMatchObject({ slot: "RB", reason: "empty", franchiseName: "Franchise One" });

    const second = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(second.inserted).toBe(0);
    expect(detectedRows()).toHaveLength(1); // still exactly one row — no duplicate
  });

  it("detects a disqualified (OUT) starter, reading injuryStatus from the archived weekly snapshot's teams[] array", () => {
    seedStarters(ts1, FULL_F1_SLOTS);
    seedStarters(ts2, FULL_F1_SLOTS); // franchise f2 stays fully healthy in every test below, so
    // assertions can focus on f1's scenario without f2 contributing unrelated holes.
    seedInjurySnapshot({ 1004: "OUT" }); // WR One

    const result = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(result.inserted).toBe(1);
    const rows = detectedRows();
    expect(rows[0]!.playerId).toBe(1004);
    expect(rows[0]!.payloadJson).toMatchObject({ slot: "WR", reason: "disqualified", playerId: 1004, playerName: "WR One", injuryStatus: "OUT" });
  });

  it("never treats QUESTIONABLE as disqualifying, end to end", () => {
    seedStarters(ts1, FULL_F1_SLOTS);
    seedStarters(ts2, FULL_F1_SLOTS); // franchise f2 stays fully healthy in every test below, so
    // assertions can focus on f1's scenario without f2 contributing unrelated holes.
    seedInjurySnapshot({ 1004: "QUESTIONABLE" });

    const result = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(result.inserted).toBe(0);
  });

  it("two different disqualified starters in the SAME slot label both get recorded (no dedupe-key collision)", () => {
    seedStarters(ts1, FULL_F1_SLOTS);
    seedStarters(ts2, FULL_F1_SLOTS); // franchise f2 stays fully healthy in every test below, so
    // assertions can focus on f1's scenario without f2 contributing unrelated holes.
    seedInjurySnapshot({ 1002: "OUT", 1003: "DOUBTFUL" }); // both RB slots

    const result = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(result.inserted).toBe(2);
    expect(detectedRows().map((r) => r.playerId).sort()).toEqual([1002, 1003]);
  });

  // -------------------------------------------------------------------------
  // Detect -> resolve sequence
  // -------------------------------------------------------------------------

  it("resolves a hole once the roster is fixed, and never re-resolves it on a later tick", () => {
    seedStarters(ts1, FULL_F1_SLOTS.filter((s) => s.playerId !== 1002)); // RB hole
    seedStarters(ts2, FULL_F1_SLOTS); // franchise f2 stays fully healthy in every test below, so
    // assertions can focus on f1's scenario without f2 contributing unrelated holes.

    const tick1 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick1.inserted).toBe(1);
    const detectKey = detectedRows()[0]!.dedupeKey;
    expect(resolvedRows()).toHaveLength(0);

    // Manager fills the RB slot.
    seedStarters(ts1, [{ playerId: 1002, lineupSlot: "RB" }]);

    const tick2 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick2.inserted).toBe(1); // exactly the resolve row
    const resolved = resolvedRows();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.dedupeKey).toBe(resolvedDedupeKeyFor(detectKey));
    expect(resolved[0]!.franchiseId).toBe(f1);
    // Task 33 (UI wiring wave) — the franchise is STILL a candidate this tick (its matchup is not
    // final), so this is a genuine fix, not a matchup-went-final no-op.
    expect((resolved[0]!.payloadJson as Record<string, unknown>).resolvedReason).toBe("fixed");

    const tick3 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick3.inserted).toBe(0); // nothing new — already resolved, hole still absent
    expect(resolvedRows()).toHaveLength(1);
  });

  it("resolvedReason is 'matchup_final' when a hole disappears because the franchise's OWN matchup went final, not because it was fixed", () => {
    seedStarters(ts1, FULL_F1_SLOTS.filter((s) => s.playerId !== 1002)); // RB hole, never fixed
    seedStarters(ts2, FULL_F1_SLOTS);

    // A second matchup that stays NOT final throughout, so this covers the "still some active
    // franchise, just not THIS one" resolve path specifically — the all-franchises-final-at-once
    // path (previously a gap; see the earlier early-return removal in lineup-holes.ts) is covered
    // separately below by "resolves every open hole when the ENTIRE week goes final in one tick".
    const f3 = db.insert(franchises).values({ canonicalName: "Franchise Three", managerName: "Cam", joinedSeason: SEASON, active: true }).returning().get().id;
    const f4 = db.insert(franchises).values({ canonicalName: "Franchise Four", managerName: "Dee", joinedSeason: SEASON, active: true }).returning().get().id;
    const ts3 = db
      .insert(teamSeasons)
      .values({ season: SEASON, franchiseId: f3, espnTeamId: 33, teamName: "Team Three", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
    const ts4 = db
      .insert(teamSeasons)
      .values({ season: SEASON, franchiseId: f4, espnTeamId: 44, teamName: "Team Four", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
    db.insert(matchups).values({ season: SEASON, week: WEEK, espnMatchupId: 2, homeTeamSeasonId: ts3, awayTeamSeasonId: ts4, homeScore: 0, awayScore: 0, isFinal: false, winner: null }).run();
    seedStarters(ts3, FULL_F1_SLOTS);
    seedStarters(ts4, FULL_F1_SLOTS);

    const tick1 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick1.inserted).toBe(1);

    // f1's matchup goes final WITHOUT the hole ever being fixed — f1 simply stops being a
    // candidate (loadFranchiseRosterContexts only includes not-yet-final matchups' franchises).
    db.update(matchups).set({ isFinal: true, winner: "away", homeScore: 50, awayScore: 60 }).where(eq(matchups.homeTeamSeasonId, ts1)).run();

    const tick2 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick2.inserted).toBe(1); // exactly the resolve row
    const resolved = resolvedRows();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.franchiseId).toBe(f1);
    expect((resolved[0]!.payloadJson as Record<string, unknown>).resolvedReason).toBe("matchup_final");
  });

  it("resolves every open hole when the ENTIRE week goes final in one tick (fix round 1, finding 4 — the exact all-final-same-tick regression test)", () => {
    // Only ONE matchup exists for this (season, week) — f1 vs f2, seeded in beforeEach. f1 has an
    // open RB hole; f2 stays fully healthy. No second matchup this time, unlike the test above —
    // this is the exact scenario the original early return mishandled: once THIS matchup goes
    // final, `loadFranchiseRosterContexts` returns an EMPTY array (zero franchises with a
    // not-yet-final matchup), which used to make the whole function bail out before the resolve
    // pass ever ran.
    seedStarters(ts1, FULL_F1_SLOTS.filter((s) => s.playerId !== 1002)); // RB hole, never fixed
    seedStarters(ts2, FULL_F1_SLOTS);

    const tick1 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick1.inserted).toBe(1);
    expect(resolvedRows()).toHaveLength(0);

    // The ONLY matchup this week goes final — franchiseContexts is now empty.
    db.update(matchups).set({ isFinal: true, winner: "away", homeScore: 50, awayScore: 60 }).where(and(eq(matchups.season, SEASON), eq(matchups.week, WEEK))).run();

    const tick2 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick2.inserted).toBe(1); // the resolve row — NOT silently dropped
    const resolved = resolvedRows();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.franchiseId).toBe(f1);
    expect((resolved[0]!.payloadJson as Record<string, unknown>).resolvedReason).toBe("matchup_final");

    // Idempotent on a later tick, same as every other resolve path.
    const tick3 = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(tick3.inserted).toBe(0);
    expect(resolvedRows()).toHaveLength(1);
  });

  it("resolved dedupe key is a literal prefix swap of the detected key", () => {
    expect(resolvedDedupeKeyFor("lineup_hole_detected:5:2026:3:RB:empty:1")).toBe("lineup_hole_resolved:5:2026:3:RB:empty:1");
  });

  it("healthy full lineups for both franchises emit nothing", () => {
    seedStarters(ts1, FULL_F1_SLOTS);
    seedStarters(ts2, FULL_F1_SLOTS); // franchise f2 stays fully healthy in every test below, so
    // assertions can focus on f1's scenario without f2 contributing unrelated holes.
    const result = emitLineupHoleEvents(db, { season: SEASON, week: WEEK });
    expect(result.inserted).toBe(0);
  });
});
