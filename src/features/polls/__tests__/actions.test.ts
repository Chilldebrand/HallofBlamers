/**
 * requireCommissioner() end-to-end for every polls admin action — same pattern as
 * src/features/admin/__tests__/actions.test.ts and src/features/recaps/__tests__/actions.test.ts
 * (mocks next/headers/next/navigation, points the db/client.ts singleton at a seeded temp DB,
 * since these Server Actions call getDb() internally rather than taking an injected db).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
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
const { managers, pollOptions, polls } = await import("../../../server/db/schema");
const { createSessionToken } = await import("../../../server/auth/session");
const { closePollAction, createPollAction, deletePollAction, openPollAction, updatePollAction } = await import("../actions");

type Db = Awaited<ReturnType<typeof createDb>>["db"];

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
let commissionerId: number;

beforeAll(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-polls-admin-action-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  commissionerId = db.insert(managers).values({ name: "Commish", role: "commissioner", inviteToken: "tok-commish" }).returning().get().id;
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

function createDraftForm(overrides: Partial<Record<string, string>> = {}): FormData {
  const fd = new FormData();
  fd.set("question", overrides.question ?? "Draft date?");
  fd.set("description", overrides.description ?? "");
  fd.set("kind", overrides.kind ?? "single");
  fd.set("closesAt", overrides.closesAt ?? "");
  fd.append("option", "Saturday");
  fd.append("option", "Sunday");
  return fd;
}

describe("createPollAction — requireCommissioner gating", () => {
  it("rejects a manager-role session: redirects home, never inserts a poll", async () => {
    const manager = db.insert(managers).values({ name: "Manager", role: "manager", inviteToken: "tok-create-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const before = db.select().from(polls).all().length;
    const signal = await callAndCaptureRedirect(() => createPollAction(createDraftForm()));
    expect(signal.url).toBe("/");
    expect(db.select().from(polls).all().length).toBe(before);
  });

  it("rejects an unauthenticated request", async () => {
    currentCookie.sessionToken = undefined;
    const signal = await callAndCaptureRedirect(() => createPollAction(createDraftForm()));
    expect(signal.url).toBe("/login");
  });

  it("accepts a commissioner-role session: creates a draft poll with its options", async () => {
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const signal = await callAndCaptureRedirect(() => createPollAction(createDraftForm({ question: "Buy-in?" })));
    expect(signal.url).toMatch(/^\/admin\/polls\/\d+\?success=created$/);

    const poll = db.select().from(polls).where(eq(polls.question, "Buy-in?")).get();
    expect(poll?.status).toBe("draft");
    expect(poll?.createdBy).toBe(commissionerId);
    const options = db.select().from(pollOptions).where(eq(pollOptions.pollId, poll!.id)).all();
    expect(options.map((o) => o.label).sort()).toEqual(["Saturday", "Sunday"]);
  });

  it("rejects fewer than 2 options when write-ins are not allowed", async () => {
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const fd = new FormData();
    fd.set("question", "Too few options");
    fd.set("kind", "single");
    fd.append("option", "Only one");
    const signal = await callAndCaptureRedirect(() => createPollAction(fd));
    expect(signal.url).toBe("/admin/polls?error=Add%20at%20least%202%20options%2C%20or%20enable%20write-ins.");
  });
});

describe("updatePollAction / openPollAction / closePollAction / deletePollAction — same guard, same rejection", () => {
  async function seedDraftPoll(): Promise<number> {
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const signal = await callAndCaptureRedirect(() => createPollAction(createDraftForm({ question: `Poll ${Date.now()}-${Math.random()}` })));
    const match = /^\/admin\/polls\/(\d+)/.exec(signal.url);
    currentCookie.sessionToken = undefined;
    return Number(match![1]);
  }

  it("updatePollAction rejects a manager-role session and never changes the poll", async () => {
    const pollId = await seedDraftPoll();
    const before = db.select().from(polls).where(eq(polls.id, pollId)).get()!;

    const manager = db.insert(managers).values({ name: "Manager2", role: "manager", inviteToken: "tok-update-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const fd = createDraftForm({ question: "Tampered question" });
    fd.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => updatePollAction(fd));
    expect(signal.url).toBe("/");

    const after = db.select().from(polls).where(eq(polls.id, pollId)).get()!;
    expect(after.question).toBe(before.question);
  });

  it("openPollAction rejects a manager-role session and never opens the poll", async () => {
    const pollId = await seedDraftPoll();
    const manager = db.insert(managers).values({ name: "Manager3", role: "manager", inviteToken: "tok-open-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => openPollAction(fd));
    expect(signal.url).toBe("/");
    expect(db.select().from(polls).where(eq(polls.id, pollId)).get()!.status).toBe("draft");
  });

  it("openPollAction (commissioner) transitions draft -> open", async () => {
    const pollId = await seedDraftPoll();
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const fd = new FormData();
    fd.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => openPollAction(fd));
    expect(signal.url).toBe(`/admin/polls/${pollId}?success=opened`);
    expect(db.select().from(polls).where(eq(polls.id, pollId)).get()!.status).toBe("open");
  });

  it("closePollAction rejects a manager-role session and never closes the poll", async () => {
    const pollId = await seedDraftPoll();
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    await callAndCaptureRedirect(() => openPollAction((() => { const fd = new FormData(); fd.set("pollId", String(pollId)); return fd; })()));

    const manager = db.insert(managers).values({ name: "Manager4", role: "manager", inviteToken: "tok-close-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);
    const fd = new FormData();
    fd.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => closePollAction(fd));
    expect(signal.url).toBe("/");
    expect(db.select().from(polls).where(eq(polls.id, pollId)).get()!.status).toBe("open");
  });

  it("deletePollAction rejects a manager-role session and never deletes the draft", async () => {
    const pollId = await seedDraftPoll();
    const manager = db.insert(managers).values({ name: "Manager5", role: "manager", inviteToken: "tok-delete-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const fd = new FormData();
    fd.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => deletePollAction(fd));
    expect(signal.url).toBe("/");
    expect(db.select().from(polls).where(eq(polls.id, pollId)).get()).toBeDefined();
  });

  it("deletePollAction (commissioner) refuses to delete an OPEN poll (draft-only)", async () => {
    const pollId = await seedDraftPoll();
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const openFd = new FormData();
    openFd.set("pollId", String(pollId));
    await callAndCaptureRedirect(() => openPollAction(openFd));

    const deleteFd = new FormData();
    deleteFd.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => deletePollAction(deleteFd));
    expect(signal.url).toBe(`/admin/polls/${pollId}?error=Only%20a%20draft%20poll%20can%20be%20deleted.`);
    expect(db.select().from(polls).where(eq(polls.id, pollId)).get()).toBeDefined();
  });

  it("deletePollAction (commissioner) deletes a draft poll and its options", async () => {
    const pollId = await seedDraftPoll();
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const fd = new FormData();
    fd.set("pollId", String(pollId));
    const signal = await callAndCaptureRedirect(() => deletePollAction(fd));
    expect(signal.url).toBe("/admin/polls?success=deleted");
    expect(db.select().from(polls).where(eq(polls.id, pollId)).get()).toBeUndefined();
    expect(db.select().from(pollOptions).where(eq(pollOptions.pollId, pollId)).all()).toEqual([]);
  });

  it("rejects an unauthenticated request for every action", async () => {
    const pollId = await seedDraftPoll();
    currentCookie.sessionToken = undefined;

    const mkFd = () => {
      const fd = new FormData();
      fd.set("pollId", String(pollId));
      return fd;
    };
    expect((await callAndCaptureRedirect(() => updatePollAction(mkFd()))).url).toBe("/login");
    expect((await callAndCaptureRedirect(() => openPollAction(mkFd()))).url).toBe("/login");
    expect((await callAndCaptureRedirect(() => closePollAction(mkFd()))).url).toBe("/login");
    expect((await callAndCaptureRedirect(() => deletePollAction(mkFd()))).url).toBe("/login");
  });
});
