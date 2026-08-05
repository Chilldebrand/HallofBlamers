/**
 * Task 20 — proves `run-tier.ts`'s wiring for lineup-hole detection end to end: a real
 * hourly/live tick (mocked ESPN client, real fetch -> normalize -> stat build -> detection
 * pipeline) actually reaches `emitLineupHoleEvents` when the season is underway, and does NOT when
 * it isn't. The preseason case here mirrors the REAL 2026 league state verified against a read-only
 * scratch copy of `data/league.db` during this task's ground-truth pass: `status.
 * latestScoringPeriod` is 0 months before Week 1, even though the full schedule already exists —
 * see `run-tier.ts`'s `isSeasonUnderway` docstring for the same real-data finding that motivated
 * that gate in the first place. Deliberately a SEPARATE small fixture from `__fixtures__/
 * season-2024.ts` (season 2026, 4 teams — the minimum `validate.ts` accepts — 1 week) rather than
 * reusing/mutating that shared fixture — keeps this file's blast radius to itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { events } from "../../db/schema";
import type { BackfillEspnClient } from "../../espn/backfill";
import type { EspnLogger, FetchLeagueParams, FetchLeagueResult } from "../../espn/types";
import { LINEUP_EVENT_TYPES } from "../lineup-holes";
import { runSyncTier, type SyncTierOptions } from "../run-tier";

const SEASON = 2026;
const LEAGUE_ID = 9999;

const SWIDS = [1, 2, 3, 4].map((n) => `{SWID-LH-0000-0000-00000000000${n}}`);

const LINEUP_SLOT_COUNTS = { "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 1, "20": 7, "21": 1, "23": 1 }; // QB1/RB2/WR2/TE1/D-ST1/K1/FLEX1

/** `validate.ts` requires at least 4 teams — team 1 carries the deliberate hole; 2/3/4 stay fully
 * healthy so this test isolates exactly one hole. */
const NORMALIZE_OPTS: SyncTierOptions["normalizeOpts"] = {
  leagueId: LEAGUE_ID,
  franchiseSeed: {
    franchises: [1, 2, 3, 4].map((n) => ({
      id: n,
      canonicalName: `Franchise ${n}`,
      managerName: `Manager ${n}`,
      joinedSeason: SEASON,
      departedSeason: null,
      active: true,
      accentColor: null,
      notes: null,
      managers: [{ managerName: `Manager ${n}`, espnOwnerSwid: SWIDS[n - 1]!, fromSeason: SEASON, toSeason: null }],
      espnTeamIds: [{ season: SEASON, espnTeamId: n }],
    })),
  },
};

function seasonScopePayload(latestScoringPeriod: number): Record<string, unknown> {
  return {
    settings: {
      name: "Lineup Holes Fixture League",
      size: 4,
      rosterSettings: { lineupSlotCounts: LINEUP_SLOT_COUNTS },
      scheduleSettings: { matchupPeriodCount: 1 },
      scoringSettings: { scoringItems: [] },
    },
    status: { finalScoringPeriod: 1, currentMatchupPeriod: 1, latestScoringPeriod },
    members: [1, 2, 3, 4].map((n) => ({ id: SWIDS[n - 1], displayName: `Manager ${n}`, firstName: `${n}`, lastName: "Manager" })),
    teams: [1, 2, 3, 4].map((n) => ({
      id: n,
      abbrev: `T${n}`,
      name: `Team ${n}`,
      logo: "",
      owners: [SWIDS[n - 1]],
      record: { overall: { wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 } },
      playoffSeed: n,
      rankCalculatedFinal: 0,
    })),
    schedule: [
      { id: 501, matchupPeriodId: 1, home: { teamId: 1, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 }, winner: "UNDECIDED" },
      { id: 502, matchupPeriodId: 1, home: { teamId: 3, totalPoints: 0 }, away: { teamId: 4, totalPoints: 0 }, winner: "UNDECIDED" },
    ],
    draftDetail: { picks: [] },
  };
}

/** Team 1's week-1 lineup deliberately omits one of its 2 configured RB slots — a real, provable
 * empty-slot hole once this flows through normalize.ts into `roster_slots`. Team 2 is fully
 * healthy. Also carries the top-level `teams[]` array `lineup-holes.ts` reads injuryStatus from
 * (Task 20 ground truth) — both players here are ACTIVE, so this test's only hole is the empty RB. */
function weekScopePayload(): Record<string, unknown> {
  const player = (id: number, fullName: string, positionId: number, slotId: number, eligibleSlots: number[]) => ({
    lineupSlotId: slotId,
    playerPoolEntry: { id, appliedStatTotal: 0, player: { id, fullName, defaultPositionId: positionId, proTeamId: 1, eligibleSlots, stats: [] } },
  });

  const team1Roster = [
    player(1, "QB One", 1, 0, [0]),
    player(2, "RB One", 2, 2, [2, 23]),
    // Only ONE RB started (configured count is 2) — the deliberate hole.
    player(4, "WR One", 3, 4, [4, 23]),
    player(5, "WR Two", 3, 4, [4, 23]),
    player(6, "TE One", 4, 6, [6, 23]),
    player(7, "FLEX One", 3, 23, [4, 23]),
    player(8, "DST One", 16, 16, [16]),
    player(9, "K One", 5, 17, [17]),
  ];

  /** A fully healthy 9-slot roster for a team, with unique player ids in the `base..base+8` range
   * so teams 2/3/4 never collide on the shared `players` table. */
  const healthyRoster = (base: number, label: string): ReturnType<typeof player>[] => [
    player(base, `QB ${label}`, 1, 0, [0]),
    player(base + 1, `RB ${label} A`, 2, 2, [2, 23]),
    player(base + 2, `RB ${label} B`, 2, 2, [2, 23]),
    player(base + 3, `WR ${label} A`, 3, 4, [4, 23]),
    player(base + 4, `WR ${label} B`, 3, 4, [4, 23]),
    player(base + 5, `TE ${label}`, 4, 6, [6, 23]),
    player(base + 6, `FLEX ${label}`, 3, 23, [4, 23]),
    player(base + 7, `DST ${label}`, 16, 16, [16]),
    player(base + 8, `K ${label}`, 5, 17, [17]),
  ];
  const team2Roster = healthyRoster(100, "Two");
  const team3Roster = healthyRoster(200, "Three");
  const team4Roster = healthyRoster(300, "Four");

  const teamTeamsEntry = (espnTeamId: number, roster: ReturnType<typeof player>[]) => ({
    id: espnTeamId,
    roster: {
      entries: roster.map((r) => ({
        lineupSlotId: r.lineupSlotId,
        injuryStatus: "NORMAL", // entry-level sentinel — never the field read (see espn-shapes.ts)
        playerId: r.playerPoolEntry.id,
        playerPoolEntry: { id: r.playerPoolEntry.id, player: { id: r.playerPoolEntry.id, fullName: r.playerPoolEntry.player.fullName, injuryStatus: "ACTIVE" } },
      })),
    },
  });

  return {
    schedule: [
      {
        id: 501,
        matchupPeriodId: 1,
        home: { teamId: 1, rosterForCurrentScoringPeriod: { entries: team1Roster } },
        away: { teamId: 2, rosterForCurrentScoringPeriod: { entries: team2Roster } },
        winner: "UNDECIDED",
        playoffTierType: "NONE",
      },
      {
        id: 502,
        matchupPeriodId: 1,
        home: { teamId: 3, rosterForCurrentScoringPeriod: { entries: team3Roster } },
        away: { teamId: 4, rosterForCurrentScoringPeriod: { entries: team4Roster } },
        winner: "UNDECIDED",
        playoffTierType: "NONE",
      },
    ],
    teams: [teamTeamsEntry(1, team1Roster), teamTeamsEntry(2, team2Roster), teamTeamsEntry(3, team3Roster), teamTeamsEntry(4, team4Roster)],
  };
}

function buildMockClient(handler: (params: FetchLeagueParams) => FetchLeagueResult): BackfillEspnClient {
  return { fetchLeague: async (params) => handler(params) };
}

function jsonResult(json: unknown, url: string): FetchLeagueResult {
  return { payload: JSON.stringify(json), json, url, status: 200 };
}

function testLogger(): EspnLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function instantSleep(): (ms: number) => Promise<void> {
  return async () => {};
}

function handlerFor(latestScoringPeriod: number) {
  return (params: FetchLeagueParams): FetchLeagueResult => {
    if (params.scoringPeriodId === undefined) return jsonResult(seasonScopePayload(latestScoringPeriod), "https://example.com/season");
    if (params.views.includes("mRoster")) return jsonResult(weekScopePayload(), "https://example.com/week");
    return jsonResult({ transactions: [] }, "https://example.com/tx");
  };
}

function lineupHoleDetectedRows(db: Db) {
  return db.select().from(events).where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_DETECTED), eq(events.season, SEASON))).all();
}

describe("run-tier lineup-hole wiring (Task 20)", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-run-tier-lineup-holes-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preseason (latestScoringPeriod 0, matching the real verified 2026 state) emits ZERO lineup-hole events, even though the hourly tier runs successfully", async () => {
    const client = buildMockClient(handlerFor(0));
    const logger = testLogger();

    const result = await runSyncTier({ db, client, sleep: instantSleep(), logger }, { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS });

    expect(result.status).toBe("ok");
    expect(lineupHoleDetectedRows(db)).toHaveLength(0);
  });

  it("once the season is underway (latestScoringPeriod >= 1), the SAME hourly tick detects the real empty RB slot and records it", async () => {
    const client = buildMockClient(handlerFor(1));
    const logger = testLogger();

    const result = await runSyncTier({ db, client, sleep: instantSleep(), logger }, { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS });

    expect(result.status).toBe("ok");
    const rows = lineupHoleDetectedRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.week).toBe(1);
    expect(rows[0]!.payloadJson).toMatchObject({ slot: "RB", reason: "empty", franchiseName: "Franchise 1" });
    expect(result.eventsEmitted).toBeGreaterThanOrEqual(1);
  });

  it("the live tier ALSO runs detection once underway (not just hourly)", async () => {
    // Prime the archive the way a real hourly tick would first (live tier reads the period from an
    // already-archived season-scope snapshot — see run-tier.ts's module docstring).
    await runSyncTier({ db, client: buildMockClient(handlerFor(1)), sleep: instantSleep(), logger: testLogger() }, { tier: "hourly", season: SEASON, normalizeOpts: NORMALIZE_OPTS });

    const result = await runSyncTier(
      { db, client: buildMockClient(handlerFor(1)), sleep: instantSleep(), logger: testLogger() },
      { tier: "live", season: SEASON, normalizeOpts: NORMALIZE_OPTS },
    );

    expect(result.status).toBe("ok");
    expect(lineupHoleDetectedRows(db)).toHaveLength(1); // idempotent re-detection, not a duplicate
  });

  it("the daily tier does NOT run lineup-hole detection (brief scope: hourly + live only)", async () => {
    const client = buildMockClient(handlerFor(1));
    const logger = testLogger();

    await runSyncTier({ db, client, sleep: instantSleep(), logger }, { tier: "daily", season: SEASON, normalizeOpts: NORMALIZE_OPTS });

    expect(lineupHoleDetectedRows(db)).toHaveLength(0);
  });
});
