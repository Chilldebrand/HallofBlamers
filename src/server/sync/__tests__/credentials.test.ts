import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { appSettings } from "../../db/schema";
import { getEspnCredentials, getLeagueId } from "../credentials";

describe("credentials", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-credentials-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);

    delete process.env.ESPN_S2;
    delete process.env.ESPN_SWID;
    delete process.env.ESPN_LEAGUE_ID;
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...originalEnv };
  });

  describe("getEspnCredentials", () => {
    it("returns null when neither app_settings nor env vars have cookies (public-league mode)", () => {
      expect(getEspnCredentials(db)).toBeNull();
    });

    it("reads cookies from app_settings when both keys are present", () => {
      const now = new Date();
      db.insert(appSettings)
        .values([
          { key: "espn_s2", valueJson: "db-s2-token", updatedAt: now },
          { key: "swid", valueJson: "{DB-SWID-BRACES}", updatedAt: now },
        ])
        .run();

      expect(getEspnCredentials(db)).toEqual({ espn_s2: "db-s2-token", swid: "{DB-SWID-BRACES}" });
    });

    it("bootstraps from ESPN_S2 / ESPN_SWID env vars when app_settings has neither, and persists them", () => {
      process.env.ESPN_S2 = "env-s2-token";
      process.env.ESPN_SWID = "{ENV-SWID-BRACES}";

      const result = getEspnCredentials(db);
      expect(result).toEqual({ espn_s2: "env-s2-token", swid: "{ENV-SWID-BRACES}" });

      const s2Row = db.select().from(appSettings).where(eq(appSettings.key, "espn_s2")).get();
      const swidRow = db.select().from(appSettings).where(eq(appSettings.key, "swid")).get();
      expect(s2Row?.valueJson).toBe("env-s2-token");
      expect(swidRow?.valueJson).toBe("{ENV-SWID-BRACES}");
    });

    it("preserves SWID braces verbatim — does not strip or add them when bootstrapping from env", () => {
      process.env.ESPN_S2 = "s2";
      process.env.ESPN_SWID = "{ABC-123-DEF}";

      const result = getEspnCredentials(db);
      expect(result?.swid).toBe("{ABC-123-DEF}");
      expect(result?.swid.startsWith("{")).toBe(true);
      expect(result?.swid.endsWith("}")).toBe(true);
    });

    it("prefers app_settings over env vars once app_settings has a complete pair", () => {
      const now = new Date();
      db.insert(appSettings)
        .values([
          { key: "espn_s2", valueJson: "db-s2-token", updatedAt: now },
          { key: "swid", valueJson: "{DB-SWID}", updatedAt: now },
        ])
        .run();
      process.env.ESPN_S2 = "env-s2-token";
      process.env.ESPN_SWID = "{ENV-SWID}";

      expect(getEspnCredentials(db)).toEqual({ espn_s2: "db-s2-token", swid: "{DB-SWID}" });
    });

    it("returns null overall when only one of ESPN_S2 / ESPN_SWID is set, but still bootstraps that individual field (field-level, not pair-level)", () => {
      process.env.ESPN_S2 = "only-s2";

      expect(getEspnCredentials(db)).toBeNull();

      const s2Row = db.select().from(appSettings).where(eq(appSettings.key, "espn_s2")).get();
      expect(s2Row?.valueJson).toBe("only-s2");
      const swidRow = db.select().from(appSettings).where(eq(appSettings.key, "swid")).get();
      expect(swidRow).toBeUndefined();
    });

    it("bootstraps only the missing field when app_settings already has espn_s2 and both env vars are present — does not overwrite the existing DB value", () => {
      const now = new Date();
      db.insert(appSettings).values({ key: "espn_s2", valueJson: "db-s2-token", updatedAt: now }).run();
      process.env.ESPN_S2 = "env-s2-token";
      process.env.ESPN_SWID = "{ENV-SWID}";

      const result = getEspnCredentials(db);

      expect(result).toEqual({ espn_s2: "db-s2-token", swid: "{ENV-SWID}" });

      const s2Row = db.select().from(appSettings).where(eq(appSettings.key, "espn_s2")).get();
      expect(s2Row?.valueJson).toBe("db-s2-token"); // unchanged — never overwritten by env
      const swidRow = db.select().from(appSettings).where(eq(appSettings.key, "swid")).get();
      expect(swidRow?.valueJson).toBe("{ENV-SWID}"); // bootstrapped from env to fill the gap
    });

    it("bootstraps only the missing field when app_settings already has swid and both env vars are present (symmetric case)", () => {
      const now = new Date();
      db.insert(appSettings).values({ key: "swid", valueJson: "{DB-SWID}", updatedAt: now }).run();
      process.env.ESPN_S2 = "env-s2-token";
      process.env.ESPN_SWID = "{ENV-SWID}";

      const result = getEspnCredentials(db);

      expect(result).toEqual({ espn_s2: "env-s2-token", swid: "{DB-SWID}" });

      const swidRow = db.select().from(appSettings).where(eq(appSettings.key, "swid")).get();
      expect(swidRow?.valueJson).toBe("{DB-SWID}"); // unchanged — never overwritten by env
      const s2Row = db.select().from(appSettings).where(eq(appSettings.key, "espn_s2")).get();
      expect(s2Row?.valueJson).toBe("env-s2-token"); // bootstrapped from env to fill the gap
    });
  });

  describe("getLeagueId", () => {
    it("reads the league id from app_settings when present", () => {
      db.insert(appSettings).values({ key: "espn_league_id", valueJson: 123456, updatedAt: new Date() }).run();

      expect(getLeagueId(db)).toBe(123456);
    });

    it("falls back to ESPN_LEAGUE_ID env var and persists it into app_settings", () => {
      process.env.ESPN_LEAGUE_ID = "987654";

      expect(getLeagueId(db)).toBe(987654);

      const row = db.select().from(appSettings).where(eq(appSettings.key, "espn_league_id")).get();
      expect(row?.valueJson).toBe(987654);
    });

    it("throws a clear error when neither app_settings nor env has a league id", () => {
      expect(() => getLeagueId(db)).toThrow(/league id/i);
    });
  });
});
