/**
 * Query-shape test for Task 33's achievements query layer — the first UI consumer of the
 * `achievements` table (stage 6 of stat build, `src/engines/achievements.ts`). Hand-inserts
 * directly into `achievements` (same dedupe-key/shape that engine produces) rather than running a
 * full stat build — that derivation is already covered end to end by
 * src/engines/__tests__/achievements.test.ts and src/server/stats/build.ts's own tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { achievements, franchises, statBuilds } from "../../db/schema";
import { getFranchiseAchievements, getWeekAchievements } from "../achievements";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
let f1: number;
let f2: number;
let buildId: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-achievements-query-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;

  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  f1 = db.insert(franchises).values({ canonicalName: "Franchise One", managerName: "Ann", joinedSeason: 2018, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Franchise Two", managerName: "Ben", joinedSeason: 2018, active: true }).returning().get().id;
  buildId = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "x", status: "ok" }).returning().get().id;

  db.insert(achievements)
    .values([
      { buildId, achievementKey: "weekly_high", franchiseId: f1, season: 2025, week: 3, dedupeKey: "weekly_high:2025:3:" + f1, payloadJson: { score: 150.1 } },
      { buildId, achievementKey: "weekly_high", franchiseId: f1, season: 2025, week: 10, dedupeKey: "weekly_high:2025:10:" + f1, payloadJson: { score: 160.2 } },
      { buildId, achievementKey: "narrow_escape", franchiseId: f1, season: 2025, week: 3, dedupeKey: "narrow_escape:2025:3:" + f1, payloadJson: { margin: 1.1 } },
      { buildId, achievementKey: "belt_thief", franchiseId: f2, season: 2025, week: 3, dedupeKey: "belt_thief:2025:3:" + f2, payloadJson: {} },
    ])
    .run();
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe("getFranchiseAchievements", () => {
  it("groups by achievement type with a career count and the most recent occurrence", () => {
    const groups = getFranchiseAchievements(f1);
    const weeklyHigh = groups.find((g) => g.achievementKey === "weekly_high");
    expect(weeklyHigh).toMatchObject({ label: "Weekly High", count: 2, mostRecent: { season: 2025, week: 10 } });
  });

  it("sorts most-earned first", () => {
    const groups = getFranchiseAchievements(f1);
    expect(groups[0]!.achievementKey).toBe("weekly_high"); // count 2, beats narrow_escape's count 1
  });

  it("returns [] for a franchise with no achievements", () => {
    expect(getFranchiseAchievements(999999)).toEqual([]);
  });

  it("never mixes one franchise's achievements into another's group", () => {
    const groups = getFranchiseAchievements(f2);
    expect(groups.map((g) => g.achievementKey)).toEqual(["belt_thief"]);
  });
});

describe("getWeekAchievements", () => {
  it("returns every achievement awarded that (season, week), with franchise names resolved", () => {
    const rows = getWeekAchievements(2025, 3);
    expect(rows).toHaveLength(3); // f1's weekly_high + narrow_escape, f2's belt_thief
    expect(rows.find((r) => r.achievementKey === "belt_thief")).toMatchObject({ franchiseId: f2, franchiseName: "Franchise Two" });
  });

  it("returns [] for a week with no recorded achievements (unsettled or genuinely none)", () => {
    expect(getWeekAchievements(2025, 4)).toEqual([]);
  });
});
