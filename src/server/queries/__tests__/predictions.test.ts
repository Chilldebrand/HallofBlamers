/**
 * Task 30 — Preseason Predictions Time Capsule, read side. Pure helpers (sortCellsByCategory,
 * toRevealCell) run against plain fixture objects; the DB-facing functions run against a real
 * migrated temp DB, same pattern as identity.test.ts/run-tier.test.ts. The lock-enforcement
 * fixture (`archiveSeasonScopeSnapshot`) mirrors run-tier.test.ts's own direct-insert-into-
 * `snapshots` pattern, since `isPredictionsLocked` is a thin wrapper over `isSeasonUnderway`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { franchises, leagues, managers, predictions, seasons, snapshots } from "../../db/schema";
import { SEASON_SCOPE_VIEW_KEY } from "../../sync/espn-shapes";
import {
  getActiveFranchises,
  getMyPredictions,
  getPredictionsSeason,
  getReveal,
  getSubmissionStatus,
  getWinTotalMax,
  isPredictionsLocked,
  sortCellsByCategory,
  toRevealCell,
  type RevealCell,
} from "../predictions";

// ---------------------------------------------------------------------------
// Pure helpers — no DB
// ---------------------------------------------------------------------------

describe("sortCellsByCategory (pure)", () => {
  it("orders cells champion, sacko, top_scorer, win_total, bold_take regardless of input order", () => {
    const cells: RevealCell[] = [
      { kind: "text", category: "bold_take", value: "x" },
      { kind: "number", category: "win_total", value: 9 },
      { kind: "franchise", category: "sacko", franchiseId: 2, franchiseName: "B" },
      { kind: "franchise", category: "champion", franchiseId: 1, franchiseName: "A" },
      { kind: "franchise", category: "top_scorer", franchiseId: 3, franchiseName: "C" },
    ];
    expect(sortCellsByCategory(cells).map((c) => c.category)).toEqual(["champion", "sacko", "top_scorer", "win_total", "bold_take"]);
  });
});

describe("toRevealCell (pure)", () => {
  const names = new Map([[1, "Dynasty FC"]]);

  it("resolves a franchise-subject category to a franchise cell with the real name", () => {
    expect(toRevealCell("champion", "1", names)).toEqual({ kind: "franchise", category: "champion", franchiseId: 1, franchiseName: "Dynasty FC" });
  });

  it("falls back to an em-dash name for a franchise id with no match (never throws)", () => {
    expect(toRevealCell("sacko", "999", names)).toEqual({ kind: "franchise", category: "sacko", franchiseId: 999, franchiseName: "—" });
  });

  it("resolves win_total to a numeric cell", () => {
    expect(toRevealCell("win_total", "9", names)).toEqual({ kind: "number", category: "win_total", value: 9 });
  });

  it("resolves bold_take to a text cell verbatim", () => {
    expect(toRevealCell("bold_take", "The sacko wins it all.", names)).toEqual({ kind: "text", category: "bold_take", value: "The sacko wins it all." });
  });
});

// ---------------------------------------------------------------------------
// DB-facing
// ---------------------------------------------------------------------------

describe("predictions queries (DB-facing)", () => {
  let db: Db;
  let sqlite: Database.Database;
  let dbPath: string;

  let champFranchise: number;
  let sackoFranchise: number;
  let scorerFranchise: number;
  let inactiveFranchise: number;

  let alice: number; // has a franchise
  let bob: number; // has a franchise
  let cara: number; // NO franchise

  const SEASON = 2026;

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-predictions-query-test-")), "test.db");
    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2015 }).returning().get();
    // Two season rows — proves getPredictionsSeason picks the NEWEST (2026), not just any row.
    db.insert(seasons)
      .values([
        { season: 2025, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 13, status: "complete" },
        { season: SEASON, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 3, regSeasonWeeks: 14, status: "upcoming" },
      ])
      .run();

    champFranchise = db.insert(franchises).values({ canonicalName: "Champ FC", managerName: "Alice", joinedSeason: 2015, active: true }).returning().get().id;
    sackoFranchise = db.insert(franchises).values({ canonicalName: "Sacko FC", managerName: "Bob", joinedSeason: 2015, active: true }).returning().get().id;
    scorerFranchise = db.insert(franchises).values({ canonicalName: "Scorer FC", managerName: "Cara", joinedSeason: 2015, active: true }).returning().get().id;
    inactiveFranchise = db.insert(franchises).values({ canonicalName: "Departed FC", managerName: "Dave", joinedSeason: 2015, active: false }).returning().get().id;

    alice = db.insert(managers).values({ name: "Alice", role: "manager", franchiseId: champFranchise, inviteToken: "tok-alice" }).returning().get().id;
    bob = db.insert(managers).values({ name: "Bob", role: "commissioner", franchiseId: sackoFranchise, inviteToken: "tok-bob" }).returning().get().id;
    cara = db.insert(managers).values({ name: "Cara", role: "manager", franchiseId: null, inviteToken: "tok-cara" }).returning().get().id;
  });

  afterAll(() => {
    sqlite.close();
    getSqlite().close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  describe("getPredictionsSeason", () => {
    it("returns the newest season row, not just any row", () => {
      expect(getPredictionsSeason(db)).toBe(SEASON);
    });
  });

  describe("getWinTotalMax", () => {
    it("reads regSeasonWeeks from the seasons row for the given season (never a hardcoded 14)", () => {
      expect(getWinTotalMax(db, SEASON)).toBe(14);
      expect(getWinTotalMax(db, 2025)).toBe(13);
    });

    it("returns null for a season with no seasons row", () => {
      expect(getWinTotalMax(db, 1999)).toBeNull();
    });
  });

  describe("getActiveFranchises", () => {
    it("excludes inactive franchises and sorts by name", () => {
      const options = getActiveFranchises(db);
      expect(options.map((f) => f.id)).not.toContain(inactiveFranchise);
      expect(options.map((f) => f.name)).toEqual(["Champ FC", "Sacko FC", "Scorer FC"]); // alphabetical
    });
  });

  describe("isPredictionsLocked", () => {
    it("is false when no season-scope snapshot has been archived yet (real preseason state before the worker's first tick)", () => {
      expect(isPredictionsLocked(db, SEASON)).toBe(false);
    });
  });

  describe("schema — migration 0009 applies cleanly and enforces the intended constraints", () => {
    it("UNIQUE(manager_id, season, category) rejects a duplicate row — one prediction per manager per season per category", () => {
      db.insert(predictions).values({ managerId: alice, season: SEASON, category: "sacko", subject: String(sackoFranchise) }).run();
      expect(() => db.insert(predictions).values({ managerId: alice, season: SEASON, category: "sacko", subject: String(champFranchise) }).run()).toThrow();
    });

    it("the same category is allowed for a DIFFERENT manager or season (the unique index is composite, not per-column)", () => {
      expect(() => db.insert(predictions).values({ managerId: bob, season: SEASON, category: "sacko", subject: String(sackoFranchise) }).run()).not.toThrow();
      expect(() => db.insert(predictions).values({ managerId: alice, season: 2025, category: "sacko", subject: String(sackoFranchise) }).run()).not.toThrow();
      // Clean up — these rows only exist to prove the constraint shape; leaving them would pollute
      // the getSubmissionStatus/getReveal assertions below.
      db.delete(predictions).where(and(eq(predictions.managerId, alice), eq(predictions.season, SEASON), eq(predictions.category, "sacko"))).run();
      db.delete(predictions).where(and(eq(predictions.managerId, bob), eq(predictions.season, SEASON), eq(predictions.category, "sacko"))).run();
      db.delete(predictions).where(and(eq(predictions.managerId, alice), eq(predictions.season, 2025), eq(predictions.category, "sacko"))).run();
    });
  });

  describe("getMyPredictions — per-manager isolation (read side)", () => {
    beforeAll(() => {
      db.insert(predictions)
        .values([
          { managerId: alice, season: SEASON, category: "champion", subject: String(champFranchise) },
          { managerId: alice, season: SEASON, category: "bold_take", subject: "Alice's take" },
          { managerId: bob, season: SEASON, category: "champion", subject: String(sackoFranchise) },
          { managerId: bob, season: SEASON, category: "bold_take", subject: "Bob's take" },
        ])
        .run();
    });

    it("returns only the requested manager's own rows for the season — never another manager's", () => {
      const aliceRows = getMyPredictions(db, alice, SEASON);
      expect(aliceRows).toHaveLength(2);
      expect(aliceRows.every((r) => r.subject !== "Bob's take")).toBe(true);

      const bobRows = getMyPredictions(db, bob, SEASON);
      expect(bobRows.some((r) => r.subject === "Bob's take")).toBe(true);
      expect(bobRows.some((r) => r.subject === "Alice's take")).toBe(false);
    });

    it("returns an empty array for a manager who hasn't predicted anything", () => {
      expect(getMyPredictions(db, cara, SEASON)).toEqual([]);
    });
  });

  describe("getSubmissionStatus — names only, no content", () => {
    it("marks alice and bob submitted, cara not — and the shape carries no prediction content at all", () => {
      const status = getSubmissionStatus(db, SEASON);
      const byName = new Map(status.map((s) => [s.name, s]));
      expect(byName.get("Alice")?.submitted).toBe(true);
      expect(byName.get("Bob")?.submitted).toBe(true);
      expect(byName.get("Cara")?.submitted).toBe(false);
      // Structural guarantee, not just "the test didn't check": the row shape is
      // {managerId, name, submitted} — there is no field a caller could even accidentally render
      // that would leak a category/subject.
      expect(Object.keys(status[0]!).sort()).toEqual(["managerId", "name", "submitted"]);
    });
  });

  describe("getReveal — lock-gated at the query boundary", () => {
    it("returns null before the season is underway, even though real prediction rows exist — this IS the seal", () => {
      expect(isPredictionsLocked(db, SEASON)).toBe(false);
      expect(getReveal(db, SEASON)).toBeNull();
    });

    it("returns everyone's full set once the season is underway, with franchise subjects resolved to names", () => {
      // Seed win_total for alice/bob (has franchise) and bold_take for cara (no franchise — proves
      // a manager who never predicted win_total simply has no win_total cell, not a fabricated 0).
      db.insert(predictions)
        .values([
          { managerId: alice, season: SEASON, category: "win_total", subject: "9" },
          { managerId: bob, season: SEASON, category: "win_total", subject: "5" },
          { managerId: cara, season: SEASON, category: "champion", subject: String(scorerFranchise) },
          { managerId: cara, season: SEASON, category: "bold_take", subject: "Cara's take" },
        ])
        .run();

      const { sqlite: snapshotSqlite } = archiveUnderwaySeasonScopeSnapshot(dbPath, SEASON);
      snapshotSqlite.close();

      expect(isPredictionsLocked(db, SEASON)).toBe(true);
      const reveal = getReveal(db, SEASON);
      expect(reveal).not.toBeNull();

      const aliceRow = reveal!.find((r) => r.managerName === "Alice")!;
      expect(aliceRow.franchiseName).toBe("Champ FC");
      const aliceChampion = aliceRow.cells.find((c) => c.category === "champion")!;
      expect(aliceChampion).toEqual({ kind: "franchise", category: "champion", franchiseId: champFranchise, franchiseName: "Champ FC" });
      const aliceWinTotal = aliceRow.cells.find((c) => c.category === "win_total")!;
      expect(aliceWinTotal).toEqual({ kind: "number", category: "win_total", value: 9 });

      const caraRow = reveal!.find((r) => r.managerName === "Cara")!;
      expect(caraRow.franchiseId).toBeNull();
      expect(caraRow.cells.some((c) => c.category === "win_total")).toBe(false); // never fabricated
      expect(caraRow.cells.some((c) => c.category === "bold_take" && c.kind === "text" && c.value === "Cara's take")).toBe(true);
    });
  });
});

/**
 * Inserts a season-scope snapshot with `status.latestScoringPeriod=1` directly into a SEPARATE
 * connection to the same on-disk DB file — same fixture technique run-tier.test.ts's own
 * "isSeasonUnderway" tests use (a direct insert into `snapshots`, not a real ESPN fetch), since
 * `isPredictionsLocked` only cares about the snapshot existing, not about running a full sync
 * tier. `view` uses SEASON_SCOPE_VIEW_KEY directly (already the deterministic sorted/joined key —
 * see espn-shapes.ts) rather than recomputing it, matching exactly what `isSeasonUnderway` looks
 * up.
 */
function archiveUnderwaySeasonScopeSnapshot(dbPath: string, season: number): { sqlite: Database.Database } {
  const opened = createDb(dbPath);
  const payload = JSON.stringify({ status: { latestScoringPeriod: 1, finalScoringPeriod: 14 } });
  opened.db
    .insert(snapshots)
    .values({
      season,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season",
      fetchedAt: new Date(),
      httpStatus: 200,
      payload,
      payloadHash: "test-hash",
    })
    .run();
  return { sqlite: opened.sqlite };
}
