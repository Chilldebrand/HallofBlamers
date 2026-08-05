import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../client";
import { runMigrations } from "../migrate";

/**
 * Task 28 (deploy migration hardening) — the deploy fix relies on
 * `runMigrations` being safe to call more than once against the same
 * database (the new `migrate` compose service runs it once per deploy, and
 * `worker/index.ts`'s own startup call runs it again immediately after —
 * see docker-compose.yml). Drizzle tracks applied migrations in its own
 * `__drizzle_migrations` journal table and skips anything already applied,
 * but that's an assumption about a dependency's behavior, not this repo's
 * code — worth pinning with a real test against a scratch DB rather than
 * trusting docs.
 */
describe("runMigrations idempotency", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-migrate-test-"));
    dbPath = path.join(tmpDir, "test.db");
    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("running migrations twice in a row is a no-op the second time", () => {
    runMigrations(db);

    const journalAfterFirst = sqlite
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id")
      .all();
    const tablesAfterFirst = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();
    expect(journalAfterFirst.length).toBeGreaterThan(0);

    // Second run: must not throw, must not re-apply anything, must not touch the journal.
    expect(() => runMigrations(db)).not.toThrow();

    const journalAfterSecond = sqlite
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY id")
      .all();
    const tablesAfterSecond = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();

    expect(journalAfterSecond).toEqual(journalAfterFirst);
    expect(tablesAfterSecond).toEqual(tablesAfterFirst);
  });

  it("running migrations against a brand-new (empty) database applies all of them", () => {
    runMigrations(db);
    const applied = sqlite.prepare("SELECT COUNT(*) as n FROM __drizzle_migrations").get() as {
      n: number;
    };
    // One row per migration file under src/server/db/migrations/*.sql.
    expect(applied.n).toBeGreaterThan(0);
  });
});
