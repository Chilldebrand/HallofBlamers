import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { statBuilds, syncRuns } from "../../db/schema";
import { getHealthStatus, SYNC_STALE_WARN_MINUTES } from "../health";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-health-test-")), "test.db");
  // getHealthStatus() reads through db/client.ts's lazy getDb() singleton (see
  // db-integration.test.ts for why DATABASE_PATH has to be set before the first call).
  process.env.DATABASE_PATH = dbPath;

  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe("getHealthStatus", () => {
  it("reports ok:true with lastSync null and buildId null on a fresh, empty database", () => {
    const status = getHealthStatus(new Date("2026-08-03T12:00:00Z"));
    expect(status.ok).toBe(true);
    expect(status.lastSync).toBeNull();
    expect(status.buildId).toBeNull();
  });

  it("reports the most recent sync_runs row and its age, not stale when recent", () => {
    db.insert(syncRuns)
      .values({ startedAt: new Date("2026-08-03T11:00:00Z"), finishedAt: new Date("2026-08-03T11:01:00Z"), tier: "hourly", status: "ok" })
      .run();

    const status = getHealthStatus(new Date("2026-08-03T11:30:00Z"));
    expect(status.lastSync).toEqual({
      tier: "hourly",
      status: "ok",
      startedAt: "2026-08-03T11:00:00.000Z",
      finishedAt: "2026-08-03T11:01:00.000Z",
      ageMinutes: 30,
      stale: false,
    });
  });

  it("flags lastSync as stale once its age exceeds the warn threshold", () => {
    // The previous test's row started 2026-08-03T11:00:00Z — evaluate "now" just past the warn
    // threshold from that same start time.
    const justPastThreshold = new Date(new Date("2026-08-03T11:00:00Z").getTime() + (SYNC_STALE_WARN_MINUTES + 1) * 60_000);
    const status = getHealthStatus(justPastThreshold);
    expect(status.lastSync?.stale).toBe(true);
  });

  it("reports the latest successful stat_builds.id, ignoring failed/running builds", () => {
    db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "a", status: "failed", errorText: "boom" }).run();
    const ok1 = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "b", status: "ok" }).returning().get();
    db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "c", status: "running" }).run();

    const status = getHealthStatus();
    expect(status.buildId).toBe(ok1.id);
  });
});
