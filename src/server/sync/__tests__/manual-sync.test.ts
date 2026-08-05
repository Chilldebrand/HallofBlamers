import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import { syncRuns } from "../../db/schema";
import {
  clearManualSyncRequest,
  getManualSyncRequestState,
  isAnySyncRunning,
  recoverStaleSyncRuns,
  requestManualSync,
  STALE_RUNNING_THRESHOLD_MS,
} from "../manual-sync";

describe("manual-sync", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-manual-sync-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getManualSyncRequestState", () => {
    it("starts with nothing pending", () => {
      expect(getManualSyncRequestState(db)).toEqual({ requestedAt: null, anySyncRunning: false, pending: false });
    });

    it("reports anySyncRunning true when a sync_runs row is mid-flight, regardless of tier", () => {
      db.insert(syncRuns).values({ startedAt: new Date(), tier: "hourly", status: "running" }).run();
      const state = getManualSyncRequestState(db);
      expect(state.anySyncRunning).toBe(true);
      expect(state.pending).toBe(true);
    });

    it("does not treat a FINISHED sync_runs row as running", () => {
      db.insert(syncRuns).values({ startedAt: new Date(), finishedAt: new Date(), tier: "hourly", status: "ok" }).run();
      expect(getManualSyncRequestState(db).anySyncRunning).toBe(false);
    });
  });

  describe("requestManualSync", () => {
    it("writes the request flag and reports pending afterward", () => {
      const now = new Date("2026-09-10T12:00:00Z");
      const result = requestManualSync(db, now);
      expect(result).toEqual({ ok: true });

      const state = getManualSyncRequestState(db);
      expect(state.requestedAt).toEqual(now);
      expect(state.pending).toBe(true);
    });

    it("refuses politely when a request is already pending — never queues a second one", () => {
      requestManualSync(db, new Date("2026-09-10T12:00:00Z"));
      const second = requestManualSync(db, new Date("2026-09-10T12:00:05Z"));
      expect(second.ok).toBe(false);

      // The original timestamp is unchanged — no second write happened.
      expect(getManualSyncRequestState(db).requestedAt).toEqual(new Date("2026-09-10T12:00:00Z"));
    });

    it("refuses politely when some OTHER sync is already running", () => {
      db.insert(syncRuns).values({ startedAt: new Date(), tier: "hourly", status: "running" }).run();
      const result = requestManualSync(db);
      expect(result.ok).toBe(false);
      // Never wrote a request flag while another sync is running.
      expect(getManualSyncRequestState(db).requestedAt).toBeNull();
    });

    it("allows a new request once the prior one has been cleared", () => {
      requestManualSync(db, new Date("2026-09-10T12:00:00Z"));
      clearManualSyncRequest(db);
      const second = requestManualSync(db, new Date("2026-09-10T13:00:00Z"));
      expect(second).toEqual({ ok: true });
    });
  });

  describe("clearManualSyncRequest", () => {
    it("is a safe no-op when nothing was requested", () => {
      expect(() => clearManualSyncRequest(db)).not.toThrow();
      expect(getManualSyncRequestState(db).requestedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Fix round 1, findings 2/3 — stale-aware guard + crash recovery, designed together.
  // ---------------------------------------------------------------------------

  describe("isAnySyncRunning (stale-aware)", () => {
    it("blocks on a 'running' row started just now", () => {
      const now = new Date("2026-09-10T12:00:00Z");
      db.insert(syncRuns).values({ startedAt: now, tier: "hourly", status: "running" }).run();
      expect(isAnySyncRunning(db, now)).toBe(true);
    });

    it("still blocks a 'running' row started 1ms inside the threshold", () => {
      const startedAt = new Date("2026-09-10T12:00:00Z");
      const now = new Date(startedAt.getTime() + STALE_RUNNING_THRESHOLD_MS - 1);
      db.insert(syncRuns).values({ startedAt, tier: "live", status: "running" }).run();
      expect(isAnySyncRunning(db, now)).toBe(true);
    });

    it("no longer blocks a 'running' row exactly at the threshold or older — self-heals with no explicit recovery", () => {
      const startedAt = new Date("2026-09-10T12:00:00Z");
      const now = new Date(startedAt.getTime() + STALE_RUNNING_THRESHOLD_MS);
      db.insert(syncRuns).values({ startedAt, tier: "daily", status: "running" }).run();
      expect(isAnySyncRunning(db, now)).toBe(false);
    });

    it("never blocks on a non-'running' status regardless of age", () => {
      db.insert(syncRuns).values({ startedAt: new Date("2026-09-10T12:00:00Z"), finishedAt: new Date(), tier: "manual", status: "failed" }).run();
      expect(isAnySyncRunning(db, new Date("2026-09-10T12:00:01Z"))).toBe(false);
    });
  });

  describe("recoverStaleSyncRuns", () => {
    it("does nothing when there are no 'running' rows at all", () => {
      expect(recoverStaleSyncRuns(db)).toEqual({ recovered: 0 });
    });

    it("leaves a fresh 'running' row untouched", () => {
      const now = new Date("2026-09-10T12:00:00Z");
      const row = db.insert(syncRuns).values({ startedAt: now, tier: "hourly", status: "running" }).returning().get();
      expect(recoverStaleSyncRuns(db, now)).toEqual({ recovered: 0 });
      const after = db.select().from(syncRuns).where(eq(syncRuns.id, row.id)).get()!;
      expect(after.status).toBe("running");
    });

    it("marks a stale 'running' row 'failed', with a finishedAt and an explanatory errorText", () => {
      const startedAt = new Date("2026-09-10T12:00:00Z");
      const now = new Date(startedAt.getTime() + STALE_RUNNING_THRESHOLD_MS + 1);
      const row = db.insert(syncRuns).values({ startedAt, tier: "manual", status: "running" }).returning().get();

      const result = recoverStaleSyncRuns(db, now);
      expect(result).toEqual({ recovered: 1 });

      const after = db.select().from(syncRuns).where(eq(syncRuns.id, row.id)).get()!;
      expect(after.status).toBe("failed");
      expect(after.finishedAt).toEqual(now);
      expect(after.errorText).toMatch(/restarted|recovery/i);
    });

    it("recovers multiple stale rows in one call and leaves fresh ones alone", () => {
      const staleStart = new Date("2026-09-10T11:00:00Z");
      const now = new Date(staleStart.getTime() + STALE_RUNNING_THRESHOLD_MS + 1);
      const stale1 = db.insert(syncRuns).values({ startedAt: staleStart, tier: "hourly", status: "running" }).returning().get();
      const stale2 = db.insert(syncRuns).values({ startedAt: staleStart, tier: "daily", status: "running" }).returning().get();
      const fresh = db.insert(syncRuns).values({ startedAt: now, tier: "live", status: "running" }).returning().get();

      expect(recoverStaleSyncRuns(db, now)).toEqual({ recovered: 2 });

      expect(db.select().from(syncRuns).where(eq(syncRuns.id, stale1.id)).get()!.status).toBe("failed");
      expect(db.select().from(syncRuns).where(eq(syncRuns.id, stale2.id)).get()!.status).toBe("failed");
      expect(db.select().from(syncRuns).where(eq(syncRuns.id, fresh.id)).get()!.status).toBe("running");
    });

    it("recovering a stale row unblocks isAnySyncRunning immediately (recovery + guard agree)", () => {
      const startedAt = new Date("2026-09-10T12:00:00Z");
      const now = new Date(startedAt.getTime() + STALE_RUNNING_THRESHOLD_MS + 1);
      db.insert(syncRuns).values({ startedAt, tier: "manual", status: "running" }).run();

      recoverStaleSyncRuns(db, now);
      expect(isAnySyncRunning(db, now)).toBe(false);
    });
  });
});
