/**
 * Separate file (not a second `describe` in `live.test.ts`) deliberately — `getDb()` is a
 * module-level lazy singleton keyed by `DATABASE_PATH` read on its FIRST call; once initialized
 * it ignores later env var changes for the rest of the process. Vitest isolates process.env AND
 * module state per TEST FILE (its own fork/worker by default), so a second singleton-pointed-at-
 * a-different-path scenario needs its own file, not just another `describe` block in the same one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getSqlite } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { getLiveSnapshot } from "../live";

describe("getLiveSnapshot — empty league", () => {
  let dbPath: string;
  let sqlite: Database.Database;

  beforeAll(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-live-query-empty-test-")), "test.db");
    process.env.DATABASE_PATH = dbPath;
    const opened = createDb(dbPath);
    sqlite = opened.sqlite;
    runMigrations(opened.db);
  });

  afterAll(() => {
    sqlite.close();
    getSqlite().close(); // see live.test.ts's afterAll — closes the getDb() singleton's own connection
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    delete process.env.DATABASE_PATH;
  });

  it("returns null when there are no matchups anywhere yet, never a fabricated shape", () => {
    expect(getLiveSnapshot()).toBeNull();
  });
});
