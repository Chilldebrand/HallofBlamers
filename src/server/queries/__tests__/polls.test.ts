/**
 * Seeded-temp-DB tests for the polls query layer — schema constraints (the UNIQUE index actually
 * enforced by SQLite) and the DB-facing wrappers (getOpenPollCount, getPollResults's anonymous
 * gating, getMyVotedOptionIds). Same pattern as db-integration.test.ts: points the db/client.ts
 * singleton at a temp file since every function here calls getDb() internally.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb, getSqlite, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { managers, pollOptions, pollVotes, polls } from "@/server/db/schema";
import { getMyVotedOptionIds, getOpenPollCount, getPollResults } from "../polls";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

let m1: number;
let m2: number;
let m3: number;
let openPollId: number;
let anonPollId: number;
let opt1: number;
let opt2: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-polls-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  m1 = db.insert(managers).values({ name: "Alice", role: "commissioner", inviteToken: "tok-1" }).returning().get().id;
  m2 = db.insert(managers).values({ name: "Bob", role: "manager", inviteToken: "tok-2" }).returning().get().id;
  m3 = db.insert(managers).values({ name: "Cara", role: "manager", inviteToken: "tok-3" }).returning().get().id;

  openPollId = db
    .insert(polls)
    .values({ question: "Draft day?", kind: "single", status: "open", anonymous: false, allowWriteIn: false, createdBy: m1 })
    .returning()
    .get().id;
  opt1 = db.insert(pollOptions).values({ pollId: openPollId, label: "Saturday", sort: 0, isWriteIn: false }).returning().get().id;
  opt2 = db.insert(pollOptions).values({ pollId: openPollId, label: "Sunday", sort: 1, isWriteIn: false }).returning().get().id;
  db.insert(pollVotes).values({ pollId: openPollId, optionId: opt1, managerId: m1 }).run();
  db.insert(pollVotes).values({ pollId: openPollId, optionId: opt2, managerId: m2 }).run();

  const draftPollId = db
    .insert(polls)
    .values({ question: "Draft-only poll", kind: "single", status: "draft", anonymous: false, allowWriteIn: false, createdBy: m1 })
    .returning()
    .get().id;
  void draftPollId;

  anonPollId = db
    .insert(polls)
    .values({ question: "Buy-in amount?", kind: "single", status: "open", anonymous: true, allowWriteIn: false, createdBy: m1 })
    .returning()
    .get().id;
  const anonOpt = db.insert(pollOptions).values({ pollId: anonPollId, label: "$50", sort: 0, isWriteIn: false }).returning().get().id;
  db.insert(pollVotes).values({ pollId: anonPollId, optionId: anonOpt, managerId: m1 }).run();
});

afterAll(() => {
  sqlite.close();
  // Every query function above goes through db/client.ts's separate lazy singleton connection
  // (same file, second handle) — has to be closed too or Windows holds a lock on the temp dir.
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

describe("schema constraints", () => {
  it("UNIQUE(poll_id, option_id, manager_id) rejects a duplicate vote row", () => {
    expect(() => db.insert(pollVotes).values({ pollId: openPollId, optionId: opt1, managerId: m1 }).run()).toThrow();
  });

  it("a different option for the same (poll, manager) is allowed at the schema level (multi-choice; single-choice enforces 'one vote only' via the action, not a schema constraint)", () => {
    expect(() => db.insert(pollVotes).values({ pollId: openPollId, optionId: opt2, managerId: m1 }).run()).not.toThrow();
    // Clean up immediately — this row only exists to prove the schema allows it; leaving it in
    // place would give m1 two votes in a single-choice poll and pollute the assertions below.
    db.delete(pollVotes).where(and(eq(pollVotes.pollId, openPollId), eq(pollVotes.optionId, opt2), eq(pollVotes.managerId, m1))).run();
  });
});

describe("getOpenPollCount", () => {
  it("counts only status='open' polls — a cheap COUNT query, ignores draft/closed", () => {
    expect(getOpenPollCount()).toBe(2); // openPollId + anonPollId; draftPollId excluded
  });
});

describe("getMyVotedOptionIds", () => {
  it("returns the option ids a manager has voted for in a poll", () => {
    expect(getMyVotedOptionIds(openPollId, m1)).toEqual(expect.arrayContaining([opt1]));
    expect(getMyVotedOptionIds(openPollId, m3)).toEqual([]);
  });
});

describe("getPollResults — anonymous gating", () => {
  it("perVoterBreakdown is populated for a non-anonymous poll", () => {
    const results = getPollResults(openPollId);
    expect(results).not.toBeNull();
    expect(results!.perVoterBreakdown).not.toBeNull();
    expect(results!.perVoterBreakdown!.some((v) => v.name === "Alice")).toBe(true);
  });

  it("perVoterBreakdown is null for an anonymous poll — never exposed to ANY caller, member or commissioner", () => {
    const results = getPollResults(anonPollId);
    expect(results).not.toBeNull();
    expect(results!.perVoterBreakdown).toBeNull();
    // Totals are still shown even when anonymous.
    expect(results!.totalVoters).toBe(1);
  });

  it("non-voters are always listed regardless of anonymity", () => {
    const results = getPollResults(openPollId);
    expect(results!.nonVoters.some((n) => n.name === "Cara")).toBe(true);
  });

  it("returns null for a poll id that doesn't exist", () => {
    expect(getPollResults(999999)).toBeNull();
  });
});
