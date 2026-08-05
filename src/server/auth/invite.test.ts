import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db/client";
import { runMigrations } from "../db/migrate";
import { managers } from "../db/schema";
import { findManagerByInviteToken } from "./invite";

describe("findManagerByInviteToken", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-invite-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds a manager by a valid invite token", () => {
    const inserted = db
      .insert(managers)
      .values({ name: "Richey", franchiseId: null, role: "commissioner", inviteToken: "valid-token" })
      .returning()
      .get();

    const found = findManagerByInviteToken(db, "valid-token");

    expect(found).not.toBeNull();
    expect(found?.id).toBe(inserted.id);
    expect(found?.name).toBe("Richey");
  });

  it("returns null for an unknown token", () => {
    const found = findManagerByInviteToken(db, "does-not-exist");
    expect(found).toBeNull();
  });
});
