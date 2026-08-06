import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../client";
import { runMigrations } from "../migrate";
import {
  appSettings,
  events,
  franchises,
  leagues,
  matchups,
  seasons,
  snapshots,
  teamSeasons,
} from "../schema";
import type Database from "better-sqlite3";

describe("db schema + migrations", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-db-test-"));
    dbPath = path.join(tmpDir, "test.db");
    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterAll(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies migrations cleanly and creates all expected tables", () => {
    const rows = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '__drizzle%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    const tableNames = rows.map((r) => r.name);

    expect(tableNames).toEqual(
      [
        "achievements",
        "allplay_week",
        "app_settings",
        "belt_matches",
        "belt_reigns",
        "career_stats",
        "chat_messages",
        "context_notes",
        "corrections",
        "draft_grades",
        "draft_picks",
        "draft_pick_values",
        "elo_history",
        "events",
        "franchise_elo",
        "franchise_managers",
        "franchises",
        "h2h_pairs",
        "leagues",
        "managers",
        "matchups",
        "notification_prefs",
        "pickem_picks",
        "players",
        "playoff_odds",
        "podcast_episodes",
        "poll_options",
        "poll_votes",
        "polls",
        "predictions",
        "preview_episodes",
        "push_subscriptions",
        "recap_exemplars",
        "recap_style_guides",
        "recaps",
        "record_entries",
        "revenge_events",
        "roster_slots",
        "season_stats",
        "seasons",
        "slot_scoring_stats",
        "snapshots",
        "stat_builds",
        "sync_runs",
        "team_seasons",
        "team_week",
        "trade_ledger",
        "transaction_items",
        "transactions",
        "waiver_acquisitions",
        "weeks",
      ].sort(),
    );
  });

  it("has foreign_keys pragma ON", () => {
    const value = sqlite.pragma("foreign_keys", { simple: true });
    expect(value).toBe(1);
  });

  it("allows two snapshots rows with the same payload_hash (no false uniqueness)", () => {
    const now = new Date();
    const row = {
      season: 2024,
      scoringPeriod: 1,
      view: "mRoster",
      url: "https://example.com/mRoster",
      fetchedAt: now,
      httpStatus: 200,
      payload: "{\"raw\":true}",
      payloadHash: "same-hash-both-rows",
    };

    expect(() => {
      db.insert(snapshots).values(row).run();
      db.insert(snapshots).values(row).run();
    }).not.toThrow();

    const count = sqlite
      .prepare(`SELECT COUNT(*) as n FROM snapshots WHERE payload_hash = ?`)
      .get("same-hash-both-rows") as { n: number };
    expect(count.n).toBe(2);
  });

  it("throws when inserting two events rows with the same dedupe_key", () => {
    const now = new Date();
    const eventRow = {
      eventType: "matchup_final",
      occurredAt: now,
      detectedAt: now,
      payloadJson: { foo: "bar" },
      dedupeKey: "dedupe-key-collision",
    };

    db.insert(events).values(eventRow).run();
    expect(() => db.insert(events).values(eventRow).run()).toThrow();
  });

  it("enforces matchups UNIQUE (season, week, espn_matchup_id)", () => {
    const league = db
      .insert(leagues)
      .values({ espnLeagueId: 123456, name: "Test League", firstSeason: 2024 })
      .returning()
      .get();

    db.insert(seasons)
      .values({
        season: 2024,
        leagueId: league.id,
        settingsJson: {},
        scoringJson: {},
        playoffFormatJson: {},
        teamCount: 10,
        regSeasonWeeks: 14,
        status: "active",
      })
      .run();

    const franchise = db
      .insert(franchises)
      .values({ canonicalName: "The Testers", managerName: "Rich", joinedSeason: 2024 })
      .returning()
      .get();

    const teamSeason = db
      .insert(teamSeasons)
      .values({
        season: 2024,
        franchiseId: franchise.id,
        espnTeamId: 1,
        teamName: "The Testers",
        wins: 0,
        losses: 0,
        ties: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        madePlayoffs: false,
      })
      .returning()
      .get();

    const matchupRow = {
      season: 2024,
      week: 1,
      espnMatchupId: 1,
      homeTeamSeasonId: teamSeason.id,
      homeScore: 100,
      awayScore: 90,
      isFinal: true,
    };

    db.insert(matchups).values(matchupRow).run();
    expect(() => db.insert(matchups).values(matchupRow).run()).toThrow();
  });

  it("round-trips JSON through an app_settings key upsert", () => {
    const key = "espn-cookies";
    const initialValue = { swid: "{abc-123}", espn_s2: "initial-token" };
    const updatedValue = { swid: "{abc-123}", espn_s2: "rotated-token" };

    db.insert(appSettings)
      .values({ key, valueJson: initialValue, updatedAt: new Date() })
      .run();

    db.insert(appSettings)
      .values({ key, valueJson: updatedValue, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { valueJson: updatedValue, updatedAt: new Date() },
      })
      .run();

    const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
    expect(row?.valueJson).toEqual(updatedValue);
  });
});
