import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import {
  beltMatches,
  events,
  franchises,
  leagues,
  matchups,
  recordEntries,
  seasons,
  statBuilds,
  teamSeasons,
  teamWeek,
  weeks,
  type NewMatchup,
} from "../../db/schema";
import { EMISSION_MIN_SEASON, emitEvents, EVENT_TYPES } from "../emit-events";

const SEASON = EMISSION_MIN_SEASON; // 2026 — the ruling's fixed epoch

describe("emitEvents", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;
  let f1: number;
  let f2: number;
  let f3: number;
  let f4: number;
  let ts1: number;
  let ts2: number;
  let ts3: number;
  let ts4: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-emit-events-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2024 }).returning().get();
    db.insert(seasons)
      .values([
        { season: 2024, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 2, status: "complete" },
        { season: SEASON, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 2, status: "active" },
      ])
      .run();

    f1 = db.insert(franchises).values({ canonicalName: "Franchise One", managerName: "Ann", joinedSeason: 2024, active: true }).returning().get().id;
    f2 = db.insert(franchises).values({ canonicalName: "Franchise Two", managerName: "Ben", joinedSeason: 2024, active: true }).returning().get().id;
    f3 = db.insert(franchises).values({ canonicalName: "Franchise Three", managerName: "Cid", joinedSeason: 2024, active: true }).returning().get().id;
    f4 = db.insert(franchises).values({ canonicalName: "Franchise Four", managerName: "Dee", joinedSeason: 2024, active: true }).returning().get().id;

    const ts = (season: number, franchiseId: number, espnTeamId: number) =>
      db
        .insert(teamSeasons)
        .values({ season, franchiseId, espnTeamId, teamName: `Team ${espnTeamId}`, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
        .returning()
        .get().id;

    ts1 = ts(SEASON, f1, 1);
    ts2 = ts(SEASON, f2, 2);
    ts3 = ts(SEASON, f3, 3);
    ts4 = ts(SEASON, f4, 4);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMatchup(overrides: Partial<NewMatchup> & { week: number; espnMatchupId: number; homeTeamSeasonId: number }): number {
    return db
      .insert(matchups)
      .values({
        season: SEASON,
        awayTeamSeasonId: null,
        homeScore: 0,
        awayScore: 0,
        isFinal: false,
        winner: null,
        ...overrides,
      })
      .returning()
      .get().id;
  }

  function eventRowsOfType(eventType: string) {
    return db.select().from(events).where(eq(events.eventType, eventType)).orderBy(events.id).all();
  }

  // -------------------------------------------------------------------------
  // Scoping ruling
  // -------------------------------------------------------------------------

  describe("season scoping (EMISSION_MIN_SEASON ruling)", () => {
    it("is a no-op for any season before EMISSION_MIN_SEASON, even with fully-final matchup data present", () => {
      const priorSeason = EMISSION_MIN_SEASON - 1;
      const league = db.select().from(leagues).get()!;
      db.insert(seasons)
        .values({ season: priorSeason, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 1, status: "complete" })
        .run();
      const ts5 = db
        .insert(teamSeasons)
        .values({ season: priorSeason, franchiseId: f1, espnTeamId: 5, teamName: "T5", wins: 1, losses: 0, ties: 0, pointsFor: 100, pointsAgainst: 90, madePlayoffs: false })
        .returning()
        .get().id;
      const ts6 = db
        .insert(teamSeasons)
        .values({ season: priorSeason, franchiseId: f2, espnTeamId: 6, teamName: "T6", wins: 0, losses: 1, ties: 0, pointsFor: 90, pointsAgainst: 100, madePlayoffs: false })
        .returning()
        .get().id;
      db.insert(matchups)
        .values({ season: priorSeason, week: 1, espnMatchupId: 1, homeTeamSeasonId: ts5, awayTeamSeasonId: ts6, homeScore: 100, awayScore: 90, isFinal: true, winner: "home" })
        .run();

      const result = emitEvents(db, { season: priorSeason });
      expect(result.inserted).toBe(0);
      expect(db.select().from(events).all()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // MatchupLeadChanged — the stateful event type
  // -------------------------------------------------------------------------

  describe("MatchupLeadChanged", () => {
    it("never emits from a pregame 0-0, not-final matchup (sentinel avoidance)", () => {
      insertMatchup({ week: 1, espnMatchupId: 101, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2 });
      const result = emitEvents(db, { season: SEASON, now: new Date("2026-09-10T20:10:00Z") });
      expect(result.inserted).toBe(0);
      expect(eventRowsOfType(EVENT_TYPES.MATCHUP_LEAD_CHANGED)).toHaveLength(0);
    });

    it("never emits for a bye (no away franchise), regardless of score", () => {
      insertMatchup({ week: 1, espnMatchupId: 102, homeTeamSeasonId: ts1, awayTeamSeasonId: null, homeScore: 40, isFinal: true });
      const result = emitEvents(db, { season: SEASON });
      expect(result.inserted).toBe(0);
    });

    it("tracks a scripted score progression with a monotonic sequence, skipping ticks with no lead change, and settles on the true final leader", () => {
      const matchupId = insertMatchup({ week: 1, espnMatchupId: 103, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2 });

      // Tick 1: home takes an early lead.
      db.update(matchups).set({ homeScore: 10, awayScore: 0 }).where(eq(matchups.id, matchupId)).run();
      let result = emitEvents(db, { season: SEASON, now: new Date("2026-09-10T20:10:00Z") });
      expect(result.inserted).toBe(1);

      // Tick 2: away overtakes.
      db.update(matchups).set({ homeScore: 10, awayScore: 15 }).where(eq(matchups.id, matchupId)).run();
      result = emitEvents(db, { season: SEASON, now: new Date("2026-09-10T20:12:00Z") });
      expect(result.inserted).toBe(1);

      // Tick 3: no change at all — must be a pure no-op.
      result = emitEvents(db, { season: SEASON, now: new Date("2026-09-10T20:14:00Z") });
      expect(result.inserted).toBe(0);

      // Tick 4: home retakes the lead.
      db.update(matchups).set({ homeScore: 20, awayScore: 15 }).where(eq(matchups.id, matchupId)).run();
      result = emitEvents(db, { season: SEASON, now: new Date("2026-09-10T20:16:00Z") });
      expect(result.inserted).toBe(1);

      const rows = eventRowsOfType(EVENT_TYPES.MATCHUP_LEAD_CHANGED);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => (r.payloadJson as { leader: string }).leader)).toEqual(["home", "away", "home"]);
      expect(rows.map((r) => (r.payloadJson as { sequence: number }).sequence)).toEqual([0, 1, 2]);
      expect(rows.map((r) => r.dedupeKey)).toEqual([
        `matchup_lead_changed:${matchupId}:0`,
        `matchup_lead_changed:${matchupId}:1`,
        `matchup_lead_changed:${matchupId}:2`,
      ]);
      expect(rows[0]!.franchiseId).toBe(f1);
      expect(rows[1]!.franchiseId).toBe(f2);

      // Tick 5: the game goes final with the SAME leader as last recorded — no new lead event,
      // but this is exactly the moment MatchupFinished should appear (covered below).
      db.update(matchups).set({ homeScore: 30, awayScore: 20, isFinal: true, winner: "home" }).where(eq(matchups.id, matchupId)).run();
      result = emitEvents(db, { season: SEASON, now: new Date("2026-09-10T23:00:00Z") });
      expect(eventRowsOfType(EVENT_TYPES.MATCHUP_LEAD_CHANGED)).toHaveLength(3); // unchanged
      expect(eventRowsOfType(EVENT_TYPES.MATCHUP_FINISHED)).toHaveLength(1);
    });

    it("emits a settling lead-change event when the final result differs from the last tracked leader (a missed intermediate poll)", () => {
      const matchupId = insertMatchup({ week: 1, espnMatchupId: 104, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2 });
      db.update(matchups).set({ homeScore: 20, awayScore: 5 }).where(eq(matchups.id, matchupId)).run();
      emitEvents(db, { season: SEASON, now: new Date("2026-09-10T20:10:00Z") });

      // Next observed tick: the game is already final, and the AWAY team actually won — a comeback
      // this tier never saw an intermediate poll for.
      db.update(matchups).set({ homeScore: 20, awayScore: 35, isFinal: true, winner: "away" }).where(eq(matchups.id, matchupId)).run();
      const result = emitEvents(db, { season: SEASON, now: new Date("2026-09-10T23:00:00Z") });
      expect(result.inserted).toBeGreaterThanOrEqual(1);

      const leadRows = eventRowsOfType(EVENT_TYPES.MATCHUP_LEAD_CHANGED);
      expect(leadRows).toHaveLength(2);
      expect((leadRows[1]!.payloadJson as { leader: string; sequence: number }).leader).toBe("away");
      expect((leadRows[1]!.payloadJson as { sequence: number }).sequence).toBe(1);
    });

    it("is idempotent across an unchanged re-run", () => {
      insertMatchup({ week: 1, espnMatchupId: 105, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 12, awayScore: 3 });
      const first = emitEvents(db, { season: SEASON });
      expect(first.inserted).toBe(1);
      const second = emitEvents(db, { season: SEASON });
      expect(second.inserted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // MatchupFinished
  // -------------------------------------------------------------------------

  describe("MatchupFinished", () => {
    it("emits once a matchup is final, with final scores + winner in the payload, and is idempotent", () => {
      const matchupId = insertMatchup({
        week: 1,
        espnMatchupId: 201,
        homeTeamSeasonId: ts1,
        awayTeamSeasonId: ts2,
        homeScore: 105.5,
        awayScore: 98.25,
        isFinal: true,
        winner: "home",
      });

      const first = emitEvents(db, { season: SEASON });
      const rows = eventRowsOfType(EVENT_TYPES.MATCHUP_FINISHED);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupeKey).toBe(`matchup_finished:${matchupId}`);
      expect(rows[0]!.franchiseId).toBe(f1);
      const payload = rows[0]!.payloadJson as Record<string, unknown>;
      expect(payload).toMatchObject({
        matchupId,
        homeFranchiseId: f1,
        homeFranchiseName: "Franchise One",
        homeScore: 105.5,
        awayFranchiseId: f2,
        awayFranchiseName: "Franchise Two",
        awayScore: 98.25,
        winner: "home",
        winnerFranchiseId: f1,
      });
      expect(first.inserted).toBeGreaterThanOrEqual(1);

      const second = emitEvents(db, { season: SEASON });
      expect(second.inserted).toBe(0);
      expect(eventRowsOfType(EVENT_TYPES.MATCHUP_FINISHED)).toHaveLength(1);
    });

    it("never emits for a non-final matchup or a bye", () => {
      insertMatchup({ week: 1, espnMatchupId: 202, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 10, awayScore: 5 });
      insertMatchup({ week: 1, espnMatchupId: 203, homeTeamSeasonId: ts3, awayTeamSeasonId: null, homeScore: 0, isFinal: true });
      emitEvents(db, { season: SEASON });
      expect(eventRowsOfType(EVENT_TYPES.MATCHUP_FINISHED)).toHaveLength(0);
    });

    it("records a tie with a null winnerFranchiseId", () => {
      insertMatchup({ week: 1, espnMatchupId: 204, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 88, awayScore: 88, isFinal: true, winner: "tie" });
      emitEvents(db, { season: SEASON });
      const rows = eventRowsOfType(EVENT_TYPES.MATCHUP_FINISHED);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.franchiseId).toBeNull();
      expect((rows[0]!.payloadJson as Record<string, unknown>).winnerFranchiseId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Belt events
  // -------------------------------------------------------------------------

  describe("BeltDefended / BeltTransferred", () => {
    it("emits BeltDefended for a defense row and BeltTransferred for a transfer row, idempotently", () => {
      const matchupA = insertMatchup({ week: 1, espnMatchupId: 301, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 120, awayScore: 90, isFinal: true, winner: "home" });
      const matchupB = insertMatchup({ week: 2, espnMatchupId: 302, homeTeamSeasonId: ts3, awayTeamSeasonId: ts1, homeScore: 130, awayScore: 100, isFinal: true, winner: "home" });

      db.insert(beltMatches)
        .values([
          { buildId: fakeBuildId(db), matchupId: matchupA, season: SEASON, week: 1, holderFranchiseId: f1, challengerFranchiseId: f2, result: "defense", holderScore: 120, challengerScore: 90 },
          { buildId: fakeBuildId(db), matchupId: matchupB, season: SEASON, week: 2, holderFranchiseId: f1, challengerFranchiseId: f3, result: "transfer", holderScore: 100, challengerScore: 130 },
        ])
        .run();

      const first = emitEvents(db, { season: SEASON });
      expect(first.inserted).toBeGreaterThanOrEqual(2);

      const defended = eventRowsOfType(EVENT_TYPES.BELT_DEFENDED);
      expect(defended).toHaveLength(1);
      expect(defended[0]!.dedupeKey).toBe(`belt_defended:${matchupA}`);
      expect(defended[0]!.franchiseId).toBe(f1);
      expect(defended[0]!.payloadJson).toMatchObject({ holderFranchiseName: "Franchise One", challengerFranchiseName: "Franchise Two" });

      const transferred = eventRowsOfType(EVENT_TYPES.BELT_TRANSFERRED);
      expect(transferred).toHaveLength(1);
      expect(transferred[0]!.dedupeKey).toBe(`belt_transferred:${matchupB}`);
      expect(transferred[0]!.franchiseId).toBe(f3); // the NEW holder, not the old one

      const second = emitEvents(db, { season: SEASON });
      // Re-run against fully unchanged state (belt AND the now-final matchups' lead state) must
      // insert nothing new at all, belt rows included.
      expect(second.inserted).toBe(0);
      expect(eventRowsOfType(EVENT_TYPES.BELT_DEFENDED)).toHaveLength(1);
      expect(eventRowsOfType(EVENT_TYPES.BELT_TRANSFERRED)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // RecordBroken
  // -------------------------------------------------------------------------

  describe("RecordBroken", () => {
    it("emits 'breaks' with the correct chronologically-earlier comparison, not simply rank 2", () => {
      const buildId = fakeBuildId(db);
      // The 2024 entry is rank 2 by value but the ONLY entry earlier than the 2026 one -> it's the
      // correct comparison target even though a later, higher-ranked (by value) entry also exists.
      db.insert(recordEntries)
        .values([
          { buildId, recordKey: "highest_week_score", rank: 1, franchiseId: f1, season: SEASON, week: 3, value: 200 },
          { buildId, recordKey: "highest_week_score", rank: 2, franchiseId: f2, season: 2024, week: 1, value: 180 },
        ])
        .run();
      insertMatchup({ week: 3, espnMatchupId: 401, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 200, awayScore: 50, isFinal: true, winner: "home" });

      emitEvents(db, { season: SEASON });
      const rows = eventRowsOfType(EVENT_TYPES.RECORD_BROKEN);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupeKey).toBe(`record_broken:highest_week_score:${f1}:${SEASON}:3`);
      expect(rows[0]!.franchiseId).toBe(f1);
      expect(rows[0]!.payloadJson).toMatchObject({ kind: "breaks", value: 200, previousValue: 180, previousSeason: 2024 });
    });

    it("emits 'sets' when there is no earlier entry at all", () => {
      const buildId = fakeBuildId(db);
      db.insert(recordEntries).values([{ buildId, recordKey: "largest_blowout", rank: 1, franchiseId: f1, season: SEASON, week: 1, value: 55.5 }]).run();
      insertMatchup({ week: 1, espnMatchupId: 402, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 100, awayScore: 44.5, isFinal: true, winner: "home" });

      emitEvents(db, { season: SEASON });
      const rows = eventRowsOfType(EVENT_TYPES.RECORD_BROKEN);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payloadJson).toMatchObject({ kind: "sets", previousValue: null });
    });

    it("does not emit for a season before EMISSION_MIN_SEASON even if it's the rank-1 entry", () => {
      const buildId = fakeBuildId(db);
      db.insert(recordEntries).values([{ buildId, recordKey: "highest_week_score", rank: 1, franchiseId: f1, season: 2024, week: 1, value: 300 }]).run();
      emitEvents(db, { season: SEASON });
      expect(eventRowsOfType(EVENT_TYPES.RECORD_BROKEN)).toHaveLength(0);
    });

    it("is idempotent across a re-run with unchanged record_entries", () => {
      const buildId = fakeBuildId(db);
      db.insert(recordEntries).values([{ buildId, recordKey: "closest_game", rank: 1, franchiseId: f1, season: SEASON, week: 1, value: 0.5 }]).run();
      const first = emitEvents(db, { season: SEASON });
      expect(first.inserted).toBeGreaterThanOrEqual(1);
      const second = emitEvents(db, { season: SEASON });
      expect(second.inserted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // BeatdownOfWeek
  // -------------------------------------------------------------------------

  describe("BeatdownOfWeek", () => {
    it("does not emit until the week is fully complete (weeks.is_complete)", () => {
      db.insert(weeks).values({ season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: false }).run();
      db.insert(teamWeek)
        .values([
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, score: 100, result: "W", margin: 40 },
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts2, franchiseId: f2, opponentFranchiseId: f1, score: 60, result: "L", margin: -40 },
        ])
        .run();
      emitEvents(db, { season: SEASON });
      expect(eventRowsOfType(EVENT_TYPES.BEATDOWN_OF_WEEK)).toHaveLength(0);
    });

    it("emits once the week completes, with the correct losing franchise + margin, and is idempotent", () => {
      db.insert(weeks).values({ season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true }).run();
      db.insert(teamWeek)
        .values([
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, score: 100, result: "W", margin: 40 },
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts2, franchiseId: f2, opponentFranchiseId: f1, score: 60, result: "L", margin: -40 },
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts3, franchiseId: f3, opponentFranchiseId: f4, score: 90, result: "W", margin: 5 },
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts4, franchiseId: f4, opponentFranchiseId: f3, score: 85, result: "L", margin: -5 },
        ])
        .run();

      const first = emitEvents(db, { season: SEASON });
      const rows = eventRowsOfType(EVENT_TYPES.BEATDOWN_OF_WEEK);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dedupeKey).toBe(`beatdown_of_week:${SEASON}:1:${f2}`);
      expect(rows[0]!.franchiseId).toBe(f2);
      expect(rows[0]!.payloadJson).toMatchObject({ margin: -40, franchiseName: "Franchise Two" });
      expect(first.inserted).toBeGreaterThanOrEqual(1);

      const second = emitEvents(db, { season: SEASON });
      expect(second.inserted).toBe(0);
      expect(eventRowsOfType(EVENT_TYPES.BEATDOWN_OF_WEEK)).toHaveLength(1);
    });

    it("awards ALL tied losers when margins tie exactly", () => {
      db.insert(weeks).values({ season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true }).run();
      db.insert(teamWeek)
        .values([
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, score: 100, result: "W", margin: 20 },
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts2, franchiseId: f2, opponentFranchiseId: f1, score: 80, result: "L", margin: -20 },
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts3, franchiseId: f3, opponentFranchiseId: f4, score: 100, result: "W", margin: 20 },
          { buildId: fakeBuildId(db), season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts4, franchiseId: f4, opponentFranchiseId: f3, score: 80, result: "L", margin: -20 },
        ])
        .run();
      emitEvents(db, { season: SEASON });
      const rows = eventRowsOfType(EVENT_TYPES.BEATDOWN_OF_WEEK);
      expect(rows.map((r) => r.franchiseId).sort()).toEqual([f2, f4].sort());
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: a full tick's insert count
  // -------------------------------------------------------------------------

  it("a single call across a mix of event types reports the true total inserted (post-dedupe), and a repeat call inserts nothing new", () => {
    insertMatchup({ week: 1, espnMatchupId: 501, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 50, awayScore: 10, isFinal: true, winner: "home" });
    const buildId = fakeBuildId(db);
    db.insert(recordEntries).values([{ buildId, recordKey: "highest_week_score", rank: 1, franchiseId: f1, season: SEASON, week: 1, value: 50 }]).run();

    const first = emitEvents(db, { season: SEASON });
    expect(first.inserted).toBeGreaterThan(0);
    const totalAfterFirst = db.select().from(events).all().length;
    expect(totalAfterFirst).toBe(first.inserted);

    const second = emitEvents(db, { season: SEASON });
    expect(second.inserted).toBe(0);
    expect(db.select().from(events).all()).toHaveLength(totalAfterFirst);
  });
});

/** `belt_matches`/`record_entries`/`team_week` all carry a `build_id` FK — this test suite never
 * runs the real stats pipeline, so it stamps a throwaway `stat_builds` row per call instead. */
function fakeBuildId(db: Db): number {
  return db
    .insert(statBuilds)
    .values({ startedAt: new Date(), status: "ok", inputHash: `test-${Math.random()}` })
    .returning({ id: statBuilds.id })
    .get().id;
}
