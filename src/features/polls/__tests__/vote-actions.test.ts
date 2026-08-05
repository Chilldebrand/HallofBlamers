/**
 * requireManager() end-to-end for the member vote action — proves a plain manager CAN vote
 * (unlike the commissioner-only admin actions in ./actions.test.ts) while an unauthenticated
 * request is still rejected, and exercises the revote-replace (single-choice) / toggle
 * (multi-choice) / write-in-dedupe semantics against a real seeded temp DB. Same mocking pattern
 * as actions.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const currentCookie: { sessionToken: string | undefined } = { sessionToken: undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "wbb_session" && currentCookie.sessionToken ? { value: currentCookie.sessionToken } : undefined),
    set: vi.fn(),
  }),
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string): never => {
    throw new RedirectSignal(url);
  },
}));

const { createDb, getSqlite } = await import("../../../server/db/client");
const { runMigrations } = await import("../../../server/db/migrate");
const { managers, pollOptions, pollVotes, polls } = await import("../../../server/db/schema");
const { createSessionToken } = await import("../../../server/auth/session");
const { submitVoteAction } = await import("../vote-actions");

type Db = Awaited<ReturnType<typeof createDb>>["db"];

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
let commissionerId: number;
let managerId: number;

beforeAll(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-polls-vote-action-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  commissionerId = db.insert(managers).values({ name: "Commish", role: "commissioner", inviteToken: "tok-c" }).returning().get().id;
  managerId = db.insert(managers).values({ name: "Manager", role: "manager", inviteToken: "tok-m" }).returning().get().id;
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

afterEach(() => {
  currentCookie.sessionToken = undefined;
});

async function callAndCaptureRedirect(fn: () => Promise<void>): Promise<RedirectSignal> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof RedirectSignal) return e;
    throw e;
  }
  throw new Error("expected a redirect, but the action returned normally");
}

function seedOpenPoll(kind: "single" | "multi", opts: { allowWriteIn?: boolean } = {}): { pollId: number; opt1: number; opt2: number; opt3: number } {
  const poll = db
    .insert(polls)
    .values({ question: `Q-${Date.now()}-${Math.random()}`, kind, status: "open", anonymous: false, allowWriteIn: opts.allowWriteIn ?? false, createdBy: commissionerId })
    .returning()
    .get();
  const opt1 = db.insert(pollOptions).values({ pollId: poll.id, label: "Alpha", sort: 0, isWriteIn: false }).returning().get().id;
  const opt2 = db.insert(pollOptions).values({ pollId: poll.id, label: "Bravo", sort: 1, isWriteIn: false }).returning().get().id;
  const opt3 = db.insert(pollOptions).values({ pollId: poll.id, label: "Charlie", sort: 2, isWriteIn: false }).returning().get().id;
  return { pollId: poll.id, opt1, opt2, opt3 };
}

function votesFor(pollId: number, mgrId: number): number[] {
  return db
    .select({ optionId: pollVotes.optionId })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.managerId, mgrId)))
    .all()
    .map((r) => r.optionId)
    .sort((a, b) => a - b);
}

describe("submitVoteAction — requireManager gating (manager CAN vote, unlike admin actions)", () => {
  it("a plain manager-role session can vote", async () => {
    const { pollId, opt1 } = seedOpenPoll("single");
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    fd.append("optionId", String(opt1));
    const signal = await callAndCaptureRedirect(() => submitVoteAction(fd));
    expect(signal.url).toBe(`/polls/${pollId}?success=voted`);
    expect(votesFor(pollId, managerId)).toEqual([opt1]);
  });

  it("a commissioner-role session can ALSO vote — commissioner can both administer and vote", async () => {
    const { pollId, opt2 } = seedOpenPoll("single");
    currentCookie.sessionToken = await createSessionToken(commissionerId);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    fd.append("optionId", String(opt2));
    const signal = await callAndCaptureRedirect(() => submitVoteAction(fd));
    expect(signal.url).toBe(`/polls/${pollId}?success=voted`);
    expect(votesFor(pollId, commissionerId)).toEqual([opt2]);
  });

  it("rejects an unauthenticated request", async () => {
    const { pollId, opt1 } = seedOpenPoll("single");
    currentCookie.sessionToken = undefined;

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    fd.append("optionId", String(opt1));
    const signal = await callAndCaptureRedirect(() => submitVoteAction(fd));
    expect(signal.url).toBe("/login");
    expect(db.select().from(pollVotes).where(eq(pollVotes.pollId, pollId)).all()).toEqual([]);
  });

  it("rejects voting on a poll that isn't open (draft or closed)", async () => {
    const draftPoll = db.insert(polls).values({ question: "Still a draft", kind: "single", status: "draft", anonymous: false, allowWriteIn: false, createdBy: commissionerId }).returning().get();
    const opt = db.insert(pollOptions).values({ pollId: draftPoll.id, label: "X", sort: 0, isWriteIn: false }).returning().get().id;
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd = new FormData();
    fd.set("pollId", String(draftPoll.id));
    fd.append("optionId", String(opt));
    const signal = await callAndCaptureRedirect(() => submitVoteAction(fd));
    expect(signal.url).toBe(`/polls/${draftPoll.id}?error=This%20poll%20isn't%20open%20for%20voting.`);
  });
});

describe("submitVoteAction — single-choice revote replaces, never accumulates", () => {
  it("voting a second time deletes the prior vote and inserts exactly the new one", async () => {
    const { pollId, opt1, opt2 } = seedOpenPoll("single");
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd1 = new FormData();
    fd1.set("pollId", String(pollId));
    fd1.append("optionId", String(opt1));
    await callAndCaptureRedirect(() => submitVoteAction(fd1));
    expect(votesFor(pollId, managerId)).toEqual([opt1]);

    const fd2 = new FormData();
    fd2.set("pollId", String(pollId));
    fd2.append("optionId", String(opt2));
    await callAndCaptureRedirect(() => submitVoteAction(fd2));
    expect(votesFor(pollId, managerId)).toEqual([opt2]); // opt1's row is gone, not accumulated

    const totalRows = db.select().from(pollVotes).where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.managerId, managerId))).all();
    expect(totalRows).toHaveLength(1);
  });

  it("rejects submitting more than one option to a single-choice poll", async () => {
    const { pollId, opt1, opt2 } = seedOpenPoll("single");
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    fd.append("optionId", String(opt1));
    fd.append("optionId", String(opt2));
    const signal = await callAndCaptureRedirect(() => submitVoteAction(fd));
    expect(signal.url).toBe(`/polls/${pollId}?error=This%20poll%20only%20accepts%20one%20choice.`);
    expect(votesFor(pollId, managerId)).toEqual([]); // the whole transaction rolled back
  });
});

describe("submitVoteAction — multi-choice toggles per option", () => {
  it("the submitted checkbox set becomes the manager's new full selection: adds new, removes unchecked, leaves unchanged alone", async () => {
    const { pollId, opt1, opt2, opt3 } = seedOpenPoll("multi");
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd1 = new FormData();
    fd1.set("pollId", String(pollId));
    fd1.append("optionId", String(opt1));
    fd1.append("optionId", String(opt2));
    await callAndCaptureRedirect(() => submitVoteAction(fd1));
    expect(votesFor(pollId, managerId)).toEqual([opt1, opt2].sort((a, b) => a - b));

    // Second submission: uncheck opt1, keep opt2, add opt3.
    const fd2 = new FormData();
    fd2.set("pollId", String(pollId));
    fd2.append("optionId", String(opt2));
    fd2.append("optionId", String(opt3));
    await callAndCaptureRedirect(() => submitVoteAction(fd2));
    expect(votesFor(pollId, managerId)).toEqual([opt2, opt3].sort((a, b) => a - b));
  });

  it("submitting zero options is rejected — must pick at least one", async () => {
    const { pollId, opt1 } = seedOpenPoll("multi");
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd1 = new FormData();
    fd1.set("pollId", String(pollId));
    fd1.append("optionId", String(opt1));
    await callAndCaptureRedirect(() => submitVoteAction(fd1));

    const fd2 = new FormData();
    fd2.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => submitVoteAction(fd2));
    expect(signal.url).toBe(`/polls/${pollId}?error=Pick%20at%20least%20one%20option.`);
    // Prior vote is untouched since the transaction never committed.
    expect(votesFor(pollId, managerId)).toEqual([opt1]);
  });
});

describe("submitVoteAction — write-in dedupe", () => {
  it("a write-in matching an existing option case-insensitively votes for the EXISTING option, no duplicate created", async () => {
    const { pollId, opt1 } = seedOpenPoll("single", { allowWriteIn: true }); // opt1 label is "Alpha"
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    fd.set("writeInLabel", "  alpha  ");
    await callAndCaptureRedirect(() => submitVoteAction(fd));

    expect(votesFor(pollId, managerId)).toEqual([opt1]);
    const optionCount = db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all().length;
    expect(optionCount).toBe(3); // no new option created — still Alpha/Bravo/Charlie
  });

  it("a genuinely new write-in label creates a new is_write_in option and votes for it", async () => {
    const { pollId } = seedOpenPoll("single", { allowWriteIn: true });
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    fd.set("writeInLabel", "Delta");
    await callAndCaptureRedirect(() => submitVoteAction(fd));

    const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
    const delta = options.find((o) => o.label === "Delta");
    expect(delta).toBeDefined();
    expect(delta!.isWriteIn).toBe(true);
    expect(votesFor(pollId, managerId)).toEqual([delta!.id]);
  });

  it("two different managers writing in the SAME new label both vote for ONE shared option, not two", async () => {
    const { pollId } = seedOpenPoll("multi", { allowWriteIn: true });

    currentCookie.sessionToken = await createSessionToken(managerId);
    const fd1 = new FormData();
    fd1.set("pollId", String(pollId));
    fd1.set("writeInLabel", "Echo");
    await callAndCaptureRedirect(() => submitVoteAction(fd1));

    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const fd2 = new FormData();
    fd2.set("pollId", String(pollId));
    fd2.set("writeInLabel", "ECHO");
    await callAndCaptureRedirect(() => submitVoteAction(fd2));

    const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
    const echoOptions = options.filter((o) => o.label.toLowerCase() === "echo");
    expect(echoOptions).toHaveLength(1);
    expect(votesFor(pollId, managerId)).toEqual([echoOptions[0]!.id]);
    expect(votesFor(pollId, commissionerId)).toEqual([echoOptions[0]!.id]);
  });

  it("write-in is silently ignored when the poll doesn't allow write-ins", async () => {
    const { pollId, opt1 } = seedOpenPoll("single", { allowWriteIn: false });
    currentCookie.sessionToken = await createSessionToken(managerId);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    fd.append("optionId", String(opt1));
    fd.set("writeInLabel", "Should not be created");
    await callAndCaptureRedirect(() => submitVoteAction(fd));

    const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all();
    expect(options.some((o) => o.label === "Should not be created")).toBe(false);
    expect(votesFor(pollId, managerId)).toEqual([opt1]);
  });
});
