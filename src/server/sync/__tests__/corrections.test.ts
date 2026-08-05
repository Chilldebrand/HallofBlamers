import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { corrections, players, transactions, weeks } from "../../db/schema";
import { applyCorrections, loadSeedCorrections } from "../corrections";

describe("corrections", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-corrections-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("loadSeedCorrections", () => {
    it("returns zero with no warnings when the directory doesn't exist", () => {
      const result = loadSeedCorrections(db, path.join(tmpDir, "does-not-exist"));
      expect(result).toEqual({ loaded: 0, warnings: [] });
    });

    it("loads *.json array files and ignores *.example.json", () => {
      const dir = path.join(tmpDir, "corrections");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "fix1.json"),
        JSON.stringify([
          {
            targetTable: "players",
            targetKey: { espn_player_id: 1 },
            field: "full_name",
            value: "Corrected Name",
            reason: "typo",
            createdBy: "test",
          },
        ]),
      );
      fs.writeFileSync(
        path.join(dir, "ignored.example.json"),
        JSON.stringify([{ targetTable: "players", targetKey: { espn_player_id: 2 }, field: "full_name", value: "x", reason: "r", createdBy: "c" }]),
      );

      const result = loadSeedCorrections(db, dir);
      expect(result).toEqual({ loaded: 1, warnings: [] });

      const rows = db.select().from(corrections).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.targetTable).toBe("players");
    });

    it("is idempotent: loading the same file twice updates the existing row instead of duplicating it", () => {
      const dir = path.join(tmpDir, "corrections");
      fs.mkdirSync(dir);
      const file = path.join(dir, "fix1.json");
      const write = (value: string) =>
        fs.writeFileSync(
          file,
          JSON.stringify([
            { targetTable: "players", targetKey: { espn_player_id: 1 }, field: "full_name", value, reason: "r", createdBy: "c" },
          ]),
        );

      write("First Value");
      loadSeedCorrections(db, dir);
      write("Second Value");
      loadSeedCorrections(db, dir);

      const rows = db.select().from(corrections).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.valueJson).toBe("Second Value");
    });

    it("skips a malformed entry (missing required fields) with a warning, keeps loading the rest", () => {
      const dir = path.join(tmpDir, "corrections");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "fix1.json"),
        JSON.stringify([
          { targetTable: "players" }, // missing everything else
          { targetTable: "players", targetKey: { espn_player_id: 1 }, field: "full_name", value: "x", reason: "r", createdBy: "c" },
        ]),
      );

      const result = loadSeedCorrections(db, dir);
      expect(result.loaded).toBe(1);
      expect(result.warnings.some((w) => w.includes("skipped"))).toBe(true);
    });
  });

  describe("applyCorrections", () => {
    it("applies a global (no `season` key) correction regardless of which season is being normalized", () => {
      db.insert(players).values({ espnPlayerId: 1, fullName: "Old Name", defaultPosition: "QB" }).run();
      db.insert(corrections)
        .values({
          targetTable: "players",
          targetKeyJson: { espn_player_id: 1 },
          field: "full_name",
          valueJson: "New Name",
          reason: "r",
          createdBy: "c",
        })
        .run();

      const result = applyCorrections(db, 2019);
      expect(result).toEqual({ applied: 1, warnings: [] });
      expect(db.select().from(players).where(eq(players.espnPlayerId, 1)).get()?.fullName).toBe("New Name");

      // Same correction applies again for a totally different season — it's global, not season-scoped.
      const result2 = applyCorrections(db, 2024);
      expect(result2.applied).toBe(1);
    });

    it("only applies a season-scoped correction (target_key_json.season) for the matching season", () => {
      db.insert(weeks).values({ season: 2023, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: false }).run();
      db.insert(weeks).values({ season: 2024, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: false }).run();
      db.insert(corrections)
        .values({
          targetTable: "weeks",
          targetKeyJson: { season: 2024, week: 1 },
          field: "is_complete",
          valueJson: true,
          reason: "r",
          createdBy: "c",
        })
        .run();

      const skipResult = applyCorrections(db, 2023);
      expect(skipResult).toEqual({ applied: 0, warnings: [] });
      expect(db.select().from(weeks).where(eq(weeks.season, 2023)).get()?.isComplete).toBe(false);
      expect(db.select().from(weeks).where(eq(weeks.season, 2024)).get()?.isComplete).toBe(false);

      const applyResult = applyCorrections(db, 2024);
      expect(applyResult.applied).toBe(1);
      expect(db.select().from(weeks).where(eq(weeks.season, 2024)).get()?.isComplete).toBe(true);
      expect(db.select().from(weeks).where(eq(weeks.season, 2023)).get()?.isComplete).toBe(false);
    });

    it("warns (not crashes) on an unknown target table", () => {
      db.insert(corrections)
        .values({
          targetTable: "snapshots", // layer-1, not allowed
          targetKeyJson: { id: 1 },
          field: "payload",
          valueJson: "x",
          reason: "r",
          createdBy: "c",
        })
        .run();

      const result = applyCorrections(db, 2024);
      expect(result.applied).toBe(0);
      expect(result.warnings.some((w) => w.includes("not an allowed layer-2 table"))).toBe(true);
    });

    it("warns (not crashes) on an unknown field", () => {
      db.insert(players).values({ espnPlayerId: 1, fullName: "Name", defaultPosition: "QB" }).run();
      db.insert(corrections)
        .values({
          targetTable: "players",
          targetKeyJson: { espn_player_id: 1 },
          field: "not_a_real_column",
          valueJson: "x",
          reason: "r",
          createdBy: "c",
        })
        .run();

      const result = applyCorrections(db, 2024);
      expect(result.applied).toBe(0);
      expect(result.warnings.some((w) => w.includes("is not a column of"))).toBe(true);
    });

    it("warns (not crashes) on an unknown target_key_json column", () => {
      db.insert(players).values({ espnPlayerId: 1, fullName: "Name", defaultPosition: "QB" }).run();
      db.insert(corrections)
        .values({
          targetTable: "players",
          targetKeyJson: { not_a_real_column: 1 },
          field: "full_name",
          valueJson: "x",
          reason: "r",
          createdBy: "c",
        })
        .run();

      const result = applyCorrections(db, 2024);
      expect(result.applied).toBe(0);
      expect(result.warnings.some((w) => w.includes("target_key_json field"))).toBe(true);
    });

    it("warns (not crashes) when target_key_json matches no row", () => {
      db.insert(corrections)
        .values({
          targetTable: "players",
          targetKeyJson: { espn_player_id: 99999 },
          field: "full_name",
          valueJson: "x",
          reason: "r",
          createdBy: "c",
        })
        .run();

      const result = applyCorrections(db, 2024);
      expect(result.applied).toBe(0);
      expect(result.warnings.some((w) => w.includes("no row"))).toBe(true);
    });

    it("ignores inactive corrections", () => {
      db.insert(players).values({ espnPlayerId: 1, fullName: "Old Name", defaultPosition: "QB" }).run();
      db.insert(corrections)
        .values({
          targetTable: "players",
          targetKeyJson: { espn_player_id: 1 },
          field: "full_name",
          valueJson: "New Name",
          reason: "r",
          createdBy: "c",
          active: false,
        })
        .run();

      const result = applyCorrections(db, 2024);
      expect(result.applied).toBe(0);
      expect(db.select().from(players).where(eq(players.espnPlayerId, 1)).get()?.fullName).toBe("Old Name");
    });

    it("regression I4: a correction targeting a timestamp_ms column (processed_at) applies cleanly instead of crashing", () => {
      db.insert(transactions)
        .values({
          season: 2024,
          espnTxId: "tx1",
          type: "waiver",
          status: "EXECUTED",
          rawJson: {},
        })
        .run();
      db.insert(corrections)
        .values({
          targetTable: "transactions",
          targetKeyJson: { season: 2024, espn_tx_id: "tx1" },
          field: "processed_at",
          valueJson: 1700000000000, // plain JSON number, as a hand-authored correction file would carry it
          reason: "backfill was mid-flight when this transaction settled",
          createdBy: "test",
        })
        .run();

      const result = applyCorrections(db, 2024);
      expect(result).toEqual({ applied: 1, warnings: [] });

      const row = db.select().from(transactions).where(eq(transactions.espnTxId, "tx1")).get();
      expect(row?.processedAt).toEqual(new Date(1700000000000));
    });

    it("regression I4: an unparseable timestamp value is a warning, not a crash", () => {
      db.insert(transactions)
        .values({ season: 2024, espnTxId: "tx1", type: "waiver", status: "EXECUTED", rawJson: {} })
        .run();
      db.insert(corrections)
        .values({
          targetTable: "transactions",
          targetKeyJson: { season: 2024, espn_tx_id: "tx1" },
          field: "proposed_at",
          valueJson: "not-a-real-timestamp",
          reason: "test",
          createdBy: "test",
        })
        .run();

      let result: ReturnType<typeof applyCorrections> | undefined;
      expect(() => {
        result = applyCorrections(db, 2024);
      }).not.toThrow();
      expect(result?.applied).toBe(0);
      expect(result?.warnings.some((w) => w.includes("not a valid timestamp"))).toBe(true);

      // The row is untouched — a failed correction must not leave a half-applied write.
      const row = db.select().from(transactions).where(eq(transactions.espnTxId, "tx1")).get();
      expect(row?.proposedAt).toBeNull();
    });

    it("regression I4: an ISO date string is accepted for a timestamp_ms column", () => {
      db.insert(transactions)
        .values({ season: 2024, espnTxId: "tx1", type: "waiver", status: "EXECUTED", rawJson: {} })
        .run();
      db.insert(corrections)
        .values({
          targetTable: "transactions",
          targetKeyJson: { season: 2024, espn_tx_id: "tx1" },
          field: "proposed_at",
          valueJson: "2024-09-01T00:00:00.000Z",
          reason: "test",
          createdBy: "test",
        })
        .run();

      const result = applyCorrections(db, 2024);
      expect(result).toEqual({ applied: 1, warnings: [] });
      const row = db.select().from(transactions).where(eq(transactions.espnTxId, "tx1")).get();
      expect(row?.proposedAt).toEqual(new Date("2024-09-01T00:00:00.000Z"));
    });
  });
});
