/**
 * Seeded-temp-DB smoke test for `getLiveSnapshot` (Task 25) — same DATABASE_PATH-swap pattern
 * `db-integration.test.ts` uses for every other getDb()-based query function. Self-contained in
 * its own file/DB (rather than folded into that shared fixture) to stay isolated from the rest of
 * that suite's much larger fixture graph.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { events, franchises, leagues, matchups, seasons, teamSeasons, weeks } from "../../db/schema";
import { getLiveSnapshot } from "../live";

describe("getLiveSnapshot", () => {
  let dbPath: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-live-query-test-")), "test.db");
    process.env.DATABASE_PATH = dbPath; // getDb() singleton reads this on first call — see db-integration.test.ts

    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2026 }).returning().get();
    db.insert(seasons)
      .values({ season: 2026, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 1, status: "active" })
      .run();
    db.insert(weeks).values({ season: 2026, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: false }).run();

    const f1 = db.insert(franchises).values({ canonicalName: "Home Franchise", managerName: "M1", joinedSeason: 2026, active: true }).returning().get().id;
    const f2 = db.insert(franchises).values({ canonicalName: "Away Franchise", managerName: "M2", joinedSeason: 2026, active: true }).returning().get().id;
    const ts1 = db
      .insert(teamSeasons)
      .values({ season: 2026, franchiseId: f1, espnTeamId: 1, teamName: "T1", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
    const ts2 = db
      .insert(teamSeasons)
      .values({ season: 2026, franchiseId: f2, espnTeamId: 2, teamName: "T2", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
    db.insert(matchups)
      .values({ season: 2026, week: 1, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 42.5, awayScore: 30, isFinal: false, winner: null })
      .run();

    db.insert(events)
      .values({
        eventType: "MatchupLeadChanged",
        season: 2026,
        week: 1,
        occurredAt: new Date(),
        detectedAt: new Date(),
        franchiseId: f1,
        matchupId: null,
        playerId: null,
        payloadJson: { leader: "home" },
        dedupeKey: "matchup_lead_changed:1:0",
      })
      .run();
  });

  afterAll(() => {
    sqlite.close();
    // getLiveSnapshot() reads through db/client.ts's lazy singleton — a SECOND connection to the
    // same temp file, alongside `sqlite` above — which also needs closing, or Windows holds an
    // exclusive lock on the temp directory and rmSync below fails with EPERM (see
    // db-integration.test.ts, which hit the exact same issue first).
    getSqlite().close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it("returns the current week's matchup scores plus the latest event id", () => {
    const snapshot = getLiveSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.season).toBe(2026);
    expect(snapshot!.week).toBe(1);
    expect(snapshot!.matchups).toHaveLength(1);
    expect(snapshot!.matchups[0]).toMatchObject({
      home: { name: "Home Franchise" },
      away: { name: "Away Franchise" },
      isFinal: false,
    });
    expect(snapshot!.lastEventId).toBeGreaterThan(0);
  });
});
