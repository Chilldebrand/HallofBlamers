/**
 * requireManager() end-to-end for savePredictionsAction — same mocking pattern as
 * src/features/polls/__tests__/vote-actions.test.ts (mocked next/headers cookie + next/navigation
 * redirect, real seeded temp DB). Covers the Task 30 brief's write-side test requirements:
 * per-manager write isolation, lock enforcement (fixtured via a direct snapshot insert, same
 * technique as run-tier.test.ts), category validation end-to-end, and edit-in-place (not
 * accumulate) semantics.
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
const { franchises, leagues, managers, predictions, seasons, snapshots } = await import("../../../server/db/schema");
const { SEASON_SCOPE_VIEW_KEY } = await import("../../../server/sync/espn-shapes");
const { createSessionToken } = await import("../../../server/auth/session");
const { savePredictionsAction } = await import("../actions");

type Db = Awaited<ReturnType<typeof createDb>>["db"];

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

let franchiseA: number;
let franchiseB: number;

let managerA: number; // has franchiseA
let managerB: number; // has franchiseB
let managerNoFranchise: number;

const SEASON = 2026;

beforeAll(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-predictions-action-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: 2015 }).returning().get();
  db.insert(seasons)
    .values({ season: SEASON, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 14, status: "upcoming" })
    .run();

  franchiseA = db.insert(franchises).values({ canonicalName: "Franchise A", managerName: "A", joinedSeason: 2015, active: true }).returning().get().id;
  franchiseB = db.insert(franchises).values({ canonicalName: "Franchise B", managerName: "B", joinedSeason: 2015, active: true }).returning().get().id;

  managerA = db.insert(managers).values({ name: "Manager A", role: "manager", franchiseId: franchiseA, inviteToken: "tok-a" }).returning().get().id;
  managerB = db.insert(managers).values({ name: "Manager B", role: "manager", franchiseId: franchiseB, inviteToken: "tok-b" }).returning().get().id;
  managerNoFranchise = db.insert(managers).values({ name: "No Franchise", role: "manager", franchiseId: null, inviteToken: "tok-c" }).returning().get().id;
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

afterEach(() => {
  currentCookie.sessionToken = undefined;
  db.delete(predictions).run();
  db.delete(snapshots).run();
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

function myRows(managerId: number): { category: string; subject: string }[] {
  return db
    .select({ category: predictions.category, subject: predictions.subject })
    .from(predictions)
    .where(and(eq(predictions.managerId, managerId), eq(predictions.season, SEASON)))
    .all()
    .sort((a, b) => a.category.localeCompare(b.category));
}

function wellFormedForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("champion", String(franchiseA));
  fd.set("sacko", String(franchiseB));
  fd.set("topScorer", String(franchiseA));
  fd.set("winTotal", "9");
  fd.set("boldTake", "The league gets weirder every year.");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

/** Same fixture technique as run-tier.test.ts / predictions.test.ts — a direct snapshot insert,
 * not a real ESPN fetch. */
function lockTheSeason(): void {
  db.insert(snapshots)
    .values({
      season: SEASON,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season",
      fetchedAt: new Date(),
      httpStatus: 200,
      payload: JSON.stringify({ status: { latestScoringPeriod: 1, finalScoringPeriod: 14 } }),
      payloadHash: "test-hash",
    })
    .run();
}

describe("savePredictionsAction — auth gating", () => {
  it("rejects an unauthenticated request and writes nothing", async () => {
    currentCookie.sessionToken = undefined;
    const signal = await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm()));
    expect(signal.url).toBe("/login");
    expect(myRows(managerA)).toEqual([]);
  });

  it("a plain manager can save their own predictions", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    const signal = await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm()));
    expect(signal.url).toBe("/predictions?success=saved");
    expect(myRows(managerA).length).toBeGreaterThan(0);
  });
});

describe("savePredictionsAction — per-manager write isolation", () => {
  it("writes are always attributed to the SESSION manager — there is no managerId form field to spoof another manager's rows", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    // No "managerId" field exists on the form at all; even attempting to smuggle one in must have
    // zero effect, since the action never reads it.
    const fd = wellFormedForm();
    fd.set("managerId", String(managerB));
    await callAndCaptureRedirect(() => savePredictionsAction(fd));

    expect(myRows(managerA).length).toBeGreaterThan(0);
    expect(myRows(managerB)).toEqual([]); // B's rows were never touched by A's submission
  });

  it("manager B's own submission never overwrites or is visible through manager A's rows", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ boldTake: "A's take" })));

    currentCookie.sessionToken = await createSessionToken(managerB);
    await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ boldTake: "B's take" })));

    const aBoldTake = myRows(managerA).find((r) => r.category === "bold_take");
    const bBoldTake = myRows(managerB).find((r) => r.category === "bold_take");
    expect(aBoldTake?.subject).toBe("A's take");
    expect(bBoldTake?.subject).toBe("B's take");
  });
});

describe("savePredictionsAction — edit in place, never accumulates", () => {
  it("submitting twice updates the existing rows rather than inserting duplicates", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ winTotal: "3" })));
    expect(myRows(managerA).find((r) => r.category === "win_total")?.subject).toBe("3");

    await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ winTotal: "11" })));
    const winTotalRows = myRows(managerA).filter((r) => r.category === "win_total");
    expect(winTotalRows).toHaveLength(1);
    expect(winTotalRows[0]!.subject).toBe("11");
  });
});

describe("savePredictionsAction — a manager with no franchise skips win_total, never fabricates one", () => {
  it("saves champion/sacko/top_scorer/bold_take but writes no win_total row at all", async () => {
    currentCookie.sessionToken = await createSessionToken(managerNoFranchise);
    const fd = wellFormedForm();
    fd.delete("winTotal"); // the page never renders this input for a franchise-less manager
    await callAndCaptureRedirect(() => savePredictionsAction(fd));

    const rows = myRows(managerNoFranchise);
    expect(rows.some((r) => r.category === "win_total")).toBe(false);
    expect(rows.some((r) => r.category === "bold_take")).toBe(true);
  });
});

describe("savePredictionsAction — category validation end-to-end", () => {
  it("rejects a win total outside the season's range and writes nothing", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    const signal = await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ winTotal: "15" })));
    expect(signal.url).toBe(`/predictions?error=${encodeURIComponent("Win total has to be a whole number between 0 and 14.")}`);
    expect(myRows(managerA)).toEqual([]);
  });

  it("rejects a champion pick that isn't a real franchise id and writes nothing", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    const signal = await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ champion: "999999" })));
    expect(signal.url).toBe(`/predictions?error=${encodeURIComponent("That's not a real franchise for champion.")}`);
    expect(myRows(managerA)).toEqual([]);
  });

  it("the whole submission is rejected together — a bad win_total doesn't leave champion/sacko/etc partially saved", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ winTotal: "-1" })));
    expect(myRows(managerA)).toEqual([]);
  });
});

describe("savePredictionsAction — lock enforcement", () => {
  it("rejects a write once the season is underway and writes nothing", async () => {
    lockTheSeason();
    currentCookie.sessionToken = await createSessionToken(managerA);
    const signal = await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm()));
    expect(signal.url).toBe(`/predictions?error=${encodeURIComponent("Too late — the season's underway. Predictions are locked.")}`);
    expect(myRows(managerA)).toEqual([]);
  });

  it("a manager who already predicted pre-lock cannot edit their own set once locked either", async () => {
    currentCookie.sessionToken = await createSessionToken(managerA);
    await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ boldTake: "before lock" })));
    expect(myRows(managerA).find((r) => r.category === "bold_take")?.subject).toBe("before lock");

    lockTheSeason();
    const signal = await callAndCaptureRedirect(() => savePredictionsAction(wellFormedForm({ boldTake: "after lock — should be rejected" })));
    expect(signal.url).toBe(`/predictions?error=${encodeURIComponent("Too late — the season's underway. Predictions are locked.")}`);
    expect(myRows(managerA).find((r) => r.category === "bold_take")?.subject).toBe("before lock"); // untouched
  });
});
