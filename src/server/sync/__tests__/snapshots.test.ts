import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { snapshots } from "../../db/schema";
import { getLatestSnapshot, hasSnapshot, seasonsWithSnapshot, storeSnapshot, viewKey } from "../snapshots";

describe("snapshot store", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-snapshots-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterAll(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    sqlite.exec("DELETE FROM snapshots");
  });

  const base = {
    season: 2024,
    scoringPeriod: 1 as number | null,
    view: "mBoxscore,mMatchupScore,mRoster",
    url: "https://example.com/snap",
    httpStatus: 200,
  };

  describe("storeSnapshot — hash-skip semantics", () => {
    it("inserts a new row on the first store for a key", () => {
      const result = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      expect(result.inserted).toBe(true);
      expect(typeof result.id).toBe("number");

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payloadHash).toBe(
        // sha256("{\"a\":1}") — pinned so a hashing regression is caught explicitly.
        "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
      );
    });

    it("does NOT insert a second row when the identical payload is stored again for the same key", () => {
      const first = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      const second = storeSnapshot(db, { ...base, payload: '{"a":1}' });

      expect(second.inserted).toBe(false);
      expect(second.id).toBe(first.id);

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(1);
    });

    it("inserts a second row when the payload changes for the same key", () => {
      const first = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      const second = storeSnapshot(db, { ...base, payload: '{"a":2}' });

      expect(second.inserted).toBe(true);
      expect(second.id).not.toBe(first.id);

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(2);
    });

    it("treats a different scoringPeriod as an independent hash lineage", () => {
      const period1 = storeSnapshot(db, { ...base, scoringPeriod: 1, payload: '{"a":1}' });
      const period2 = storeSnapshot(db, { ...base, scoringPeriod: 2, payload: '{"a":1}' });

      expect(period1.inserted).toBe(true);
      expect(period2.inserted).toBe(true);
      expect(period1.id).not.toBe(period2.id);
    });

    it("treats a different view key as an independent hash lineage", () => {
      const boxscore = storeSnapshot(db, { ...base, view: "mBoxscore,mMatchupScore,mRoster", payload: '{"a":1}' });
      const settings = storeSnapshot(db, { ...base, view: "mSettings,mTeam", payload: '{"a":1}' });

      expect(boxscore.inserted).toBe(true);
      expect(settings.inserted).toBe(true);
      expect(boxscore.id).not.toBe(settings.id);
    });

    it("stores season-scope fetches (scoringPeriod: null) as their own lineage, independent of any per-period rows", () => {
      const seasonScope = storeSnapshot(db, { ...base, scoringPeriod: null, payload: '{"a":1}' });
      const period = storeSnapshot(db, { ...base, scoringPeriod: 1, payload: '{"a":1}' });

      expect(seasonScope.inserted).toBe(true);
      expect(period.inserted).toBe(true);
      expect(seasonScope.id).not.toBe(period.id);

      const row = db.select().from(snapshots).where(eq(snapshots.id, seasonScope.id)).get();
      expect(row?.scoringPeriod).toBeNull();

      // Re-storing the identical payload against the NULL-scoringPeriod key still hash-skips.
      const seasonScopeAgain = storeSnapshot(db, { ...base, scoringPeriod: null, payload: '{"a":1}' });
      expect(seasonScopeAgain.inserted).toBe(false);
      expect(seasonScopeAgain.id).toBe(seasonScope.id);
    });

    it("ignores superseded rows for hash comparison — a matching hash on a superseded row still gets a fresh insert", () => {
      const first = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      db.update(snapshots).set({ superseded: true }).where(eq(snapshots.id, first.id)).run();

      const second = storeSnapshot(db, { ...base, payload: '{"a":1}' });

      expect(second.inserted).toBe(true);
      expect(second.id).not.toBe(first.id);

      const rows = db.select().from(snapshots).all();
      expect(rows).toHaveLength(2);
    });

    it("compares against the MOST RECENT non-superseded row, not an older one, when both exist", () => {
      const oldest = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      const middle = storeSnapshot(db, { ...base, payload: '{"a":2}' });
      // Mark the oldest superseded; "middle" (hash for {"a":2}) is now the most recent non-superseded row.
      db.update(snapshots).set({ superseded: true }).where(eq(snapshots.id, oldest.id)).run();

      // Re-storing {"a":2} should hash-skip against "middle", not insert a new row.
      const repeatOfMiddle = storeSnapshot(db, { ...base, payload: '{"a":2}' });
      expect(repeatOfMiddle.inserted).toBe(false);
      expect(repeatOfMiddle.id).toBe(middle.id);

      // But re-storing {"a":1} (the now-superseded row's payload) inserts fresh, since
      // the superseded row is excluded from comparison.
      const repeatOfOldest = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      expect(repeatOfOldest.inserted).toBe(true);
      expect(repeatOfOldest.id).not.toBe(oldest.id);
    });
  });

  describe("hasSnapshot", () => {
    it("returns false when no row exists for the key", () => {
      expect(hasSnapshot(db, { season: 2099, view: "mRoster", scoringPeriod: 1 })).toBe(false);
    });

    it("returns true once any row has been stored for the key", () => {
      storeSnapshot(db, { ...base, payload: '{"a":1}' });
      expect(hasSnapshot(db, { season: base.season, view: base.view, scoringPeriod: base.scoringPeriod })).toBe(
        true,
      );
    });

    it("is scoped by season/view/scoringPeriod independently", () => {
      storeSnapshot(db, { ...base, season: 2024, scoringPeriod: 1, payload: '{"a":1}' });

      expect(hasSnapshot(db, { season: 2023, view: base.view, scoringPeriod: 1 })).toBe(false);
      expect(hasSnapshot(db, { season: 2024, view: base.view, scoringPeriod: 2 })).toBe(false);
      expect(hasSnapshot(db, { season: 2024, view: "mSettings,mTeam", scoringPeriod: 1 })).toBe(false);
      expect(hasSnapshot(db, { season: 2024, view: base.view, scoringPeriod: 1 })).toBe(true);
    });

    it("returns true even for a superseded-only row (any row counts)", () => {
      const row = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      db.update(snapshots).set({ superseded: true }).where(eq(snapshots.id, row.id)).run();

      expect(hasSnapshot(db, { season: base.season, view: base.view, scoringPeriod: base.scoringPeriod })).toBe(
        true,
      );
    });
  });

  describe("getLatestSnapshot", () => {
    it("returns null when nothing has been stored for the key", () => {
      expect(getLatestSnapshot(db, { season: base.season, view: base.view, scoringPeriod: base.scoringPeriod })).toBeNull();
    });

    it("returns the row for the key, with its payload intact", () => {
      storeSnapshot(db, { ...base, payload: '{"a":1}' });
      const row = getLatestSnapshot(db, { season: base.season, view: base.view, scoringPeriod: base.scoringPeriod });
      expect(row?.payload).toBe('{"a":1}');
    });

    it("returns the most recently fetched non-superseded row when several exist for the key", () => {
      storeSnapshot(db, { ...base, payload: '{"a":1}' });
      storeSnapshot(db, { ...base, payload: '{"a":2}' }); // different payload -> a second row, same key

      const row = getLatestSnapshot(db, { season: base.season, view: base.view, scoringPeriod: base.scoringPeriod });
      expect(row?.payload).toBe('{"a":2}');
    });

    it("skips a superseded row even if it is the only one", () => {
      const row = storeSnapshot(db, { ...base, payload: '{"a":1}' });
      db.update(snapshots).set({ superseded: true }).where(eq(snapshots.id, row.id)).run();

      expect(getLatestSnapshot(db, { season: base.season, view: base.view, scoringPeriod: base.scoringPeriod })).toBeNull();
    });

    it("is scoped by season/view/scoringPeriod independently, including the null (season-scope) case", () => {
      storeSnapshot(db, { ...base, season: 2024, scoringPeriod: null, payload: '{"a":1}' });

      expect(getLatestSnapshot(db, { season: 2023, view: base.view, scoringPeriod: null })).toBeNull();
      expect(getLatestSnapshot(db, { season: 2024, view: base.view, scoringPeriod: 1 })).toBeNull();
      expect(getLatestSnapshot(db, { season: 2024, view: base.view, scoringPeriod: null })?.payload).toBe('{"a":1}');
    });
  });

  describe("seasonsWithSnapshot", () => {
    it("returns an empty array when nothing is archived for the view", () => {
      expect(seasonsWithSnapshot(db, base.view)).toEqual([]);
    });

    it("returns distinct seasons with a season-scope (scoringPeriod NULL) snapshot for the view, ascending", () => {
      storeSnapshot(db, { ...base, season: 2024, scoringPeriod: null, payload: '{"a":1}' });
      storeSnapshot(db, { ...base, season: 2022, scoringPeriod: null, payload: '{"a":2}' });
      storeSnapshot(db, { ...base, season: 2024, scoringPeriod: null, payload: '{"a":3}' }); // same season again
      storeSnapshot(db, { ...base, season: 2023, scoringPeriod: 1, payload: '{"a":4}' }); // per-period, not season-scope

      expect(seasonsWithSnapshot(db, base.view)).toEqual([2022, 2024]);
    });

    it("ignores a season whose only season-scope snapshot is superseded", () => {
      const row = storeSnapshot(db, { ...base, season: 2024, scoringPeriod: null, payload: '{"a":1}' });
      db.update(snapshots).set({ superseded: true }).where(eq(snapshots.id, row.id)).run();

      expect(seasonsWithSnapshot(db, base.view)).toEqual([]);
    });

    it("is scoped by view", () => {
      storeSnapshot(db, { ...base, season: 2024, scoringPeriod: null, view: "mSettings,mTeam", payload: '{"a":1}' });
      expect(seasonsWithSnapshot(db, base.view)).toEqual([]);
      expect(seasonsWithSnapshot(db, "mSettings,mTeam")).toEqual([2024]);
    });
  });

  describe("viewKey", () => {
    it("sorts and comma-joins view names deterministically regardless of input order", () => {
      expect(viewKey(["mRoster", "mBoxscore", "mMatchupScore"])).toBe("mBoxscore,mMatchupScore,mRoster");
      expect(viewKey(["mMatchupScore", "mBoxscore", "mRoster"])).toBe("mBoxscore,mMatchupScore,mRoster");
    });

    it("does not mutate the input array", () => {
      const input = ["mRoster", "mBoxscore"];
      viewKey(input);
      expect(input).toEqual(["mRoster", "mBoxscore"]);
    });
  });
});
