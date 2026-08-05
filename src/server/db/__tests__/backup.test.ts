import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../client";
import { runMigrations } from "../migrate";
import { syncRuns } from "../schema";
import { backupFileName, BACKUP_RETENTION_COUNT, pruneOldBackups, runBackup } from "../backup";

describe("backupFileName", () => {
  it("formats as league-YYYY-MM-DD.db in UTC, zero-padded", () => {
    expect(backupFileName(new Date("2026-01-05T04:30:00Z"))).toBe("league-2026-01-05.db");
    expect(backupFileName(new Date("2026-12-31T04:30:00Z"))).toBe("league-2026-12-31.db");
  });
});

describe("runBackup", () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-backup-test-"));
    dbPath = path.join(tmpDir, "league.db");
    backupDir = path.join(tmpDir, "backups");
    const opened = createDb(dbPath);
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
    db.insert(syncRuns).values({ startedAt: new Date(), tier: "manual", status: "ok" }).run();
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a VACUUM INTO snapshot readable as a standalone, complete database", () => {
    const now = new Date("2026-08-03T08:30:00Z");
    const result = runBackup(sqlite, backupDir, now);

    expect(result.path).toBe(path.join(backupDir, "league-2026-08-03.db"));
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.pruned).toEqual([]);

    const restored = new Database(result.path, { readonly: true });
    try {
      const row = restored.prepare("SELECT tier, status FROM sync_runs LIMIT 1").get() as
        | { tier: string; status: string }
        | undefined;
      expect(row).toEqual({ tier: "manual", status: "ok" });
    } finally {
      restored.close();
    }
  });

  it("creates the backup directory if it doesn't exist yet", () => {
    expect(fs.existsSync(backupDir)).toBe(false);
    runBackup(sqlite, backupDir, new Date("2026-08-03T08:30:00Z"));
    expect(fs.existsSync(backupDir)).toBe(true);
  });

  it("overwrites a same-day backup instead of failing", () => {
    const now = new Date("2026-08-03T08:30:00Z");
    const first = runBackup(sqlite, backupDir, now);
    db.insert(syncRuns).values({ startedAt: new Date(), tier: "manual", status: "ok" }).run();
    const second = runBackup(sqlite, backupDir, now);

    expect(second.path).toBe(first.path);
    const restored = new Database(second.path, { readonly: true });
    try {
      const count = restored.prepare("SELECT COUNT(*) AS n FROM sync_runs").get() as { n: number };
      expect(count.n).toBe(2);
    } finally {
      restored.close();
    }
  });

  it("prunes down to BACKUP_RETENTION_COUNT after each run, oldest first", () => {
    fs.mkdirSync(backupDir, { recursive: true });
    // Seed 14 pre-existing daily backups (2026-07-01 .. 2026-07-14), already at the retention cap.
    for (let day = 1; day <= BACKUP_RETENTION_COUNT; day++) {
      const name = `league-2026-07-${String(day).padStart(2, "0")}.db`;
      fs.writeFileSync(path.join(backupDir, name), "placeholder");
    }

    const result = runBackup(sqlite, backupDir, new Date("2026-08-03T08:30:00Z"));

    expect(result.pruned).toEqual(["league-2026-07-01.db"]);
    const remaining = fs.readdirSync(backupDir).sort();
    expect(remaining).toHaveLength(BACKUP_RETENTION_COUNT);
    expect(remaining).not.toContain("league-2026-07-01.db");
    expect(remaining).toContain("league-2026-08-03.db");
  });

  it("never touches files that don't match the league-YYYY-MM-DD.db pattern", () => {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "league-2026-08-03-post-backfill.db"), "manual backup, keep forever");
    fs.writeFileSync(path.join(backupDir, "notes.txt"), "unrelated file");

    runBackup(sqlite, backupDir, new Date("2026-08-03T08:30:00Z"));

    const remaining = fs.readdirSync(backupDir);
    expect(remaining).toContain("league-2026-08-03-post-backfill.db");
    expect(remaining).toContain("notes.txt");
  });
});

describe("pruneOldBackups", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-prune-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array and does nothing if the directory doesn't exist", () => {
    expect(pruneOldBackups(path.join(tmpDir, "nope"), 14)).toEqual([]);
  });

  it("keeps exactly `retain` files when there are more, deleting the oldest by name", () => {
    for (const day of [1, 2, 3, 4, 5]) {
      fs.writeFileSync(path.join(tmpDir, `league-2026-01-0${day}.db`), "x");
    }
    const deleted = pruneOldBackups(tmpDir, 3);
    expect(deleted).toEqual(["league-2026-01-01.db", "league-2026-01-02.db"]);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(["league-2026-01-03.db", "league-2026-01-04.db", "league-2026-01-05.db"]);
  });

  it("does nothing when there are fewer files than the retention count", () => {
    fs.writeFileSync(path.join(tmpDir, "league-2026-01-01.db"), "x");
    expect(pruneOldBackups(tmpDir, 14)).toEqual([]);
    expect(fs.readdirSync(tmpDir)).toEqual(["league-2026-01-01.db"]);
  });
});
