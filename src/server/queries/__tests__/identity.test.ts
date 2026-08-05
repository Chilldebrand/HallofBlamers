/**
 * Task 21 — the identity-system resolver (docs/design/redesign-2026-08/README.md). Pure-logic
 * cases (computeLatestCompleteSeason) run against plain objects; the DB-facing resolver
 * (getIdentityFlags/getViewerDisplay) runs against a real migrated temp DB, same pattern as
 * db-integration.test.ts, since this file's own contract takes `db` directly rather than reading
 * through the getDb() singleton.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { beltReigns, franchises, leagues, managers, seasonStats, seasons, statBuilds } from "../../db/schema";
import { computeLatestCompleteSeason, getIdentityFlags, getViewerDisplay, resolveFranchiseFlags } from "../identity";

describe("computeLatestCompleteSeason (pure)", () => {
  it("returns null for no seasons at all", () => {
    expect(computeLatestCompleteSeason([])).toBeNull();
  });

  it("returns null when no season is complete — the no-complete-season edge (a brand-new league, or one mid-flight)", () => {
    expect(
      computeLatestCompleteSeason([
        { season: 2025, status: "active" },
        { season: 2026, status: "upcoming" },
      ]),
    ).toBeNull();
  });

  it("picks the newest COMPLETE season, ignoring a newer upcoming/active one", () => {
    expect(
      computeLatestCompleteSeason([
        { season: 2024, status: "complete" },
        { season: 2025, status: "complete" },
        { season: 2026, status: "upcoming" },
      ]),
    ).toBe(2025);
  });
});

describe("resolveFranchiseFlags (pure)", () => {
  const flags = { championFranchiseId: 1, beltHolderFranchiseId: 2, sackoFranchiseId: 3, viewerFranchiseId: 4 };

  it("sets exactly the matching boolean per franchise id, independently", () => {
    expect(resolveFranchiseFlags(flags, 1)).toEqual({ isChampion: true, holdsBelt: false, isSacko: false, isViewer: false });
    expect(resolveFranchiseFlags(flags, 2)).toEqual({ isChampion: false, holdsBelt: true, isSacko: false, isViewer: false });
    expect(resolveFranchiseFlags(flags, 5)).toEqual({ isChampion: false, holdsBelt: false, isSacko: false, isViewer: false });
  });

  it("lets champion and belt holder co-occur on the same franchise (distinct signals, README: not the same thing)", () => {
    const both = { championFranchiseId: 9, beltHolderFranchiseId: 9, sackoFranchiseId: null, viewerFranchiseId: null };
    expect(resolveFranchiseFlags(both, 9)).toEqual({ isChampion: true, holdsBelt: true, isSacko: false, isViewer: false });
  });
});

describe("getIdentityFlags / getViewerDisplay (DB-facing)", () => {
  let db: Db;
  let sqlite: Database.Database;
  let dbPath: string;
  let champFranchise: number;
  let sackoFranchise: number;
  let beltFranchise: number;
  let viewerNoFranchiseManagerId: number;
  let viewerManagerId: number;

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-identity-test-")), "test.db");
    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2015 }).returning().get();
    db.insert(seasons)
      .values([
        { season: 2024, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 2, status: "complete" },
        { season: 2025, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 2, status: "complete" },
        { season: 2026, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 4, regSeasonWeeks: 2, status: "upcoming" },
      ])
      .run();

    champFranchise = db.insert(franchises).values({ canonicalName: "Champ FC", managerName: "A", joinedSeason: 2015 }).returning().get().id;
    sackoFranchise = db.insert(franchises).values({ canonicalName: "Sacko FC", managerName: "B", joinedSeason: 2015 }).returning().get().id;
    beltFranchise = db.insert(franchises).values({ canonicalName: "Belt FC", managerName: "C", joinedSeason: 2015 }).returning().get().id;

    const buildId = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get().id;

    // season_stats rows only for the two COMPLETE seasons — 2025 is the one that should win
    // (newer than 2024), 2026 (upcoming) intentionally has none at all.
    db.insert(seasonStats)
      .values([
        {
          buildId,
          season: 2024,
          franchiseId: sackoFranchise,
          wins: 0,
          losses: 10,
          ties: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          allplayW: 0,
          allplayL: 0,
          allplayT: 0,
          madePlayoffs: false,
          champion: false,
          sacko: true,
        },
        {
          buildId,
          season: 2025,
          franchiseId: champFranchise,
          wins: 10,
          losses: 0,
          ties: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          allplayW: 0,
          allplayL: 0,
          allplayT: 0,
          madePlayoffs: false,
          champion: true,
          sacko: false,
        },
        {
          buildId,
          season: 2025,
          franchiseId: sackoFranchise,
          wins: 0,
          losses: 10,
          ties: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          allplayW: 0,
          allplayL: 0,
          allplayT: 0,
          madePlayoffs: false,
          champion: false,
          sacko: true,
        },
      ])
      .run();

    db.insert(beltReigns)
      .values([
        {
          buildId,
          reignNo: 1,
          franchiseId: beltFranchise,
          startSeason: 2025,
          startWeek: 1,
          defenses: 0,
          weeksHeld: 5,
          isCurrent: true,
        },
      ])
      .run();

    viewerManagerId = db
      .insert(managers)
      .values({ name: "Viewer Vic", franchiseId: beltFranchise, role: "manager", inviteToken: "tok-viewer" })
      .returning()
      .get().id;
    viewerNoFranchiseManagerId = db
      .insert(managers)
      .values({ name: "Franchiseless Fran", franchiseId: null, role: "manager", inviteToken: "tok-none" })
      .returning()
      .get().id;
  });

  afterAll(() => {
    sqlite.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("resolves champion/sacko from the latest COMPLETE season (2025, not the older 2024 row)", () => {
    const flags = getIdentityFlags(db, null);
    expect(flags.championFranchiseId).toBe(champFranchise);
    expect(flags.sackoFranchiseId).toBe(sackoFranchise);
  });

  it("resolves the current belt holder independent of season completeness", () => {
    const flags = getIdentityFlags(db, null);
    expect(flags.beltHolderFranchiseId).toBe(beltFranchise);
  });

  it("resolves the viewer's own franchise from their manager row", () => {
    const flags = getIdentityFlags(db, viewerManagerId);
    expect(flags.viewerFranchiseId).toBe(beltFranchise);
  });

  it("returns a null viewerFranchiseId for a manager with no franchise attached, and for viewerManagerId=null", () => {
    expect(getIdentityFlags(db, viewerNoFranchiseManagerId).viewerFranchiseId).toBeNull();
    expect(getIdentityFlags(db, null).viewerFranchiseId).toBeNull();
  });

  it("returns a null viewerFranchiseId for an unknown manager id (never throws)", () => {
    expect(getIdentityFlags(db, 999999).viewerFranchiseId).toBeNull();
  });

  it("getViewerDisplay resolves the manager's own franchise name", () => {
    expect(getViewerDisplay(db, { name: "Viewer Vic", franchiseId: beltFranchise })).toEqual({ managerName: "Viewer Vic", franchiseName: "Belt FC" });
  });

  it("getViewerDisplay returns a null franchiseName for a manager with no franchise attached", () => {
    expect(getViewerDisplay(db, { name: "Franchiseless Fran", franchiseId: null })).toEqual({ managerName: "Franchiseless Fran", franchiseName: null });
  });
});
