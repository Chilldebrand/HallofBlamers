/**
 * Query-shape smoke test for Task 20's `getLineupHolesForWeek`/`getCurrentWeekLineupHoles` — proves
 * the Drizzle read + detected/resolved diff runs against the real migrated schema and returns the
 * shape a future admin panel/ticker expects. Hand-inserts directly into `events` (the same
 * dedupe-key shape `lineup-holes.ts` produces) rather than running the full sync pipeline — that
 * emission logic is already covered end to end by `src/server/sync/__tests__/lineup-holes.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { events, franchises, leagues, matchups, seasons, teamSeasons } from "../../db/schema";
import { getCurrentWeekLineupHoles, getCurrentWeekResolvedLineupHoles, getLineupHolesForWeek, getResolvedLineupHolesForWeek } from "../lineup-holes";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

const SEASON = 2026;
const WEEK = 3;

let f1: number;
let f2: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-lineup-holes-query-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;

  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: SEASON }).returning().get();
  db.insert(seasons)
    .values({ season: SEASON, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 14, status: "active" })
    .run();

  f1 = db.insert(franchises).values({ canonicalName: "Franchise One", managerName: "Ann", joinedSeason: SEASON, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Franchise Two", managerName: "Ben", joinedSeason: SEASON, active: true }).returning().get().id;

  const ts1 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f1, espnTeamId: 1, teamName: "Team One", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
    .returning()
    .get().id;
  const ts2 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f2, espnTeamId: 2, teamName: "Team Two", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
    .returning()
    .get().id;

  db.insert(matchups)
    .values({ season: SEASON, week: WEEK, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 0, awayScore: 0, isFinal: false, winner: null })
    .run();

  // An UNRESOLVED empty-slot hole for f1.
  db.insert(events)
    .values({
      eventType: "LineupHoleDetected",
      season: SEASON,
      week: WEEK,
      occurredAt: new Date("2026-09-10T12:00:00Z"),
      detectedAt: new Date("2026-09-10T12:00:00Z"),
      franchiseId: f1,
      matchupId: null,
      playerId: null,
      dedupeKey: `lineup_hole_detected:${f1}:${SEASON}:${WEEK}:RB:empty:1`,
      payloadJson: { franchiseId: f1, franchiseName: "Franchise One", season: SEASON, week: WEEK, slot: "RB", reason: "empty", playerId: null, playerName: null, injuryStatus: null },
    })
    .run();

  // A DETECTED-then-RESOLVED disqualified hole for f2 — must NOT appear in the unresolved query.
  const resolvedDetectKey = `lineup_hole_detected:${f2}:${SEASON}:${WEEK}:WR:disqualified:501`;
  db.insert(events)
    .values({
      eventType: "LineupHoleDetected",
      season: SEASON,
      week: WEEK,
      occurredAt: new Date("2026-09-10T12:00:00Z"),
      detectedAt: new Date("2026-09-10T12:00:00Z"),
      franchiseId: f2,
      matchupId: null,
      playerId: 501,
      dedupeKey: resolvedDetectKey,
      payloadJson: { franchiseId: f2, franchiseName: "Franchise Two", season: SEASON, week: WEEK, slot: "WR", reason: "disqualified", playerId: 501, playerName: "Hurt WR", injuryStatus: "OUT" },
    })
    .run();
  db.insert(events)
    .values({
      eventType: "LineupHoleResolved",
      season: SEASON,
      week: WEEK,
      occurredAt: new Date("2026-09-11T12:00:00Z"),
      detectedAt: new Date("2026-09-11T12:00:00Z"),
      franchiseId: f2,
      matchupId: null,
      playerId: 501,
      dedupeKey: `lineup_hole_resolved:${f2}:${SEASON}:${WEEK}:WR:disqualified:501`,
      // Deliberately NO resolvedReason — models a resolved row written before Task 33 added that
      // field, so the query's "null, never fabricated" fallback gets real coverage.
      payloadJson: { franchiseId: f2, franchiseName: "Franchise Two", season: SEASON, week: WEEK, slot: "WR", reason: "disqualified", playerId: 501, playerName: "Hurt WR", injuryStatus: "OUT" },
    })
    .run();

  // A second resolved hole for f1, WITH resolvedReason — the post-Task-33 shape.
  db.insert(events)
    .values({
      eventType: "LineupHoleResolved",
      season: SEASON,
      week: WEEK,
      occurredAt: new Date("2026-09-12T09:00:00Z"),
      detectedAt: new Date("2026-09-12T09:00:00Z"),
      franchiseId: f1,
      matchupId: null,
      playerId: null,
      dedupeKey: `lineup_hole_resolved:${f1}:${SEASON}:${WEEK}:K:empty:1`,
      payloadJson: {
        franchiseId: f1,
        franchiseName: "Franchise One",
        season: SEASON,
        week: WEEK,
        slot: "K",
        reason: "empty",
        playerId: null,
        playerName: null,
        injuryStatus: null,
        resolvedAt: "2026-09-12T09:00:00Z",
        resolvedReason: "fixed",
      },
    })
    .run();
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe("getLineupHolesForWeek", () => {
  it("returns only the UNRESOLVED hole, shaped for direct rendering", () => {
    const rows = getLineupHolesForWeek(SEASON, WEEK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      franchiseId: f1,
      franchiseName: "Franchise One",
      season: SEASON,
      week: WEEK,
      slot: "RB",
      reason: "empty",
      playerId: null,
      playerName: null,
      injuryStatus: null,
    });
  });

  it("excludes a hole that has a matching LineupHoleResolved event", () => {
    const rows = getLineupHolesForWeek(SEASON, WEEK);
    expect(rows.some((r) => r.franchiseId === f2)).toBe(false);
  });

  it("returns [] for a week with no recorded holes", () => {
    expect(getLineupHolesForWeek(SEASON, WEEK + 1)).toEqual([]);
  });
});

describe("getCurrentWeekLineupHoles", () => {
  it("resolves the current matchup week and delegates to getLineupHolesForWeek", () => {
    const rows = getCurrentWeekLineupHoles();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.franchiseId).toBe(f1);
  });
});

describe("getResolvedLineupHolesForWeek", () => {
  it("returns every resolved hole, most recently resolved first", () => {
    const rows = getResolvedLineupHolesForWeek(SEASON, WEEK);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.franchiseId).toBe(f1); // resolved 2026-09-12, newer than f2's 2026-09-11
    expect(rows[1]!.franchiseId).toBe(f2);
  });

  it("surfaces resolvedReason when present", () => {
    const rows = getResolvedLineupHolesForWeek(SEASON, WEEK);
    expect(rows.find((r) => r.franchiseId === f1)!.resolvedReason).toBe("fixed");
  });

  it("falls back to null (never fabricated) for a resolved row written before resolvedReason existed", () => {
    const rows = getResolvedLineupHolesForWeek(SEASON, WEEK);
    expect(rows.find((r) => r.franchiseId === f2)!.resolvedReason).toBeNull();
  });

  it("returns [] for a week with no resolved holes", () => {
    expect(getResolvedLineupHolesForWeek(SEASON, WEEK + 1)).toEqual([]);
  });
});

describe("getCurrentWeekResolvedLineupHoles", () => {
  it("resolves the current matchup week and delegates to getResolvedLineupHolesForWeek", () => {
    expect(getCurrentWeekResolvedLineupHoles()).toHaveLength(2);
  });
});
