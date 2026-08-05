/**
 * Task 31 — requireManager() gating, per-manager write isolation, and server-enforced lock
 * enforcement for submitPicksAction, against a real seeded temp DB. Same mocking pattern as
 * src/features/polls/__tests__/vote-actions.test.ts.
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
const { appSettings, franchises, leagues, managers, matchups, pickemPicks, seasons, snapshots, teamSeasons } = await import("../../../server/db/schema");
const { createSessionToken } = await import("../../../server/auth/session");
const { SEASON_SCOPE_VIEW_KEY } = await import("../../../server/sync/espn-shapes");
const { submitPicksAction, setAiEnabledAction } = await import("../actions");

type Db = Awaited<ReturnType<typeof createDb>>["db"];

const SEASON = 2026;

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
let commissionerId: number;
let managerAId: number;
let managerBId: number;
let franchiseA: number;
let franchiseB: number;
let matchupId: number;

beforeAll(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-pickem-action-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  commissionerId = db.insert(managers).values({ name: "Commish", role: "commissioner", inviteToken: "tok-c" }).returning().get().id;
  managerAId = db.insert(managers).values({ name: "Manager A", role: "manager", inviteToken: "tok-a" }).returning().get().id;
  managerBId = db.insert(managers).values({ name: "Manager B", role: "manager", inviteToken: "tok-b" }).returning().get().id;

  const leagueId = db.insert(leagues).values({ espnLeagueId: 1690915927, name: "Test League", firstSeason: SEASON }).returning().get().id;
  db.insert(seasons).values({ season: SEASON, leagueId, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 14, status: "upcoming" }).run();

  franchiseA = db.insert(franchises).values({ canonicalName: "Alpha", managerName: "Manager A", joinedSeason: SEASON }).returning().get().id;
  franchiseB = db.insert(franchises).values({ canonicalName: "Bravo", managerName: "Manager B", joinedSeason: SEASON }).returning().get().id;
  const teamA = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: franchiseA, espnTeamId: 1, teamName: "Alpha", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
    .returning()
    .get().id;
  const teamB = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: franchiseB, espnTeamId: 2, teamName: "Bravo", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
    .returning()
    .get().id;
  matchupId = db
    .insert(matchups)
    .values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: teamA, awayTeamSeasonId: teamB, homeScore: 0, awayScore: 0, isFinal: false, winner: null })
    .returning()
    .get().id;

  // Preseason snapshot (latestScoringPeriod 0) -> isPickemLocked is always false regardless of
  // wall-clock day, matching the real verified 2026 DB state — the "picks are open" baseline every
  // test below starts from, with the one lock-enforcement test overriding it directly.
  db.insert(snapshots)
    .values({
      season: SEASON,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season",
      fetchedAt: new Date(),
      httpStatus: 200,
      payload: JSON.stringify({ status: { latestScoringPeriod: 0 } }),
      payloadHash: "test-hash",
    })
    .run();
});

afterAll(() => {
  sqlite.close();
  getSqlite().close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  delete process.env.DATABASE_PATH;
});

afterEach(() => {
  currentCookie.sessionToken = undefined;
  db.delete(pickemPicks).run();
  vi.useRealTimers();
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

function pickFormData(overrides: { season?: number; week?: number; pick?: number } = {}): FormData {
  const fd = new FormData();
  fd.set("season", String(overrides.season ?? SEASON));
  fd.set("week", String(overrides.week ?? 1));
  fd.set(`pick_${matchupId}`, String(overrides.pick ?? franchiseA));
  return fd;
}

function picksFor(mgrId: number) {
  return db.select().from(pickemPicks).where(and(eq(pickemPicks.season, SEASON), eq(pickemPicks.managerId, mgrId))).all();
}

describe("submitPicksAction — requireManager gating", () => {
  it("a plain manager-role session can submit picks", async () => {
    currentCookie.sessionToken = await createSessionToken(managerAId);
    const signal = await callAndCaptureRedirect(() => submitPicksAction(pickFormData()));
    expect(signal.url).toBe("/pickem?success=picks_saved");
    expect(picksFor(managerAId)).toHaveLength(1);
    expect(picksFor(managerAId)[0]!.pickedFranchiseId).toBe(franchiseA);
  });

  it("rejects an unauthenticated request", async () => {
    currentCookie.sessionToken = undefined;
    const signal = await callAndCaptureRedirect(() => submitPicksAction(pickFormData()));
    expect(signal.url).toBe("/login");
    expect(db.select().from(pickemPicks).all()).toEqual([]);
  });
});

describe("submitPicksAction — per-manager write isolation", () => {
  it("two different managers' picks for the SAME matchup never collide — each keeps their own row", async () => {
    currentCookie.sessionToken = await createSessionToken(managerAId);
    await callAndCaptureRedirect(() => submitPicksAction(pickFormData({ pick: franchiseA })));

    currentCookie.sessionToken = await createSessionToken(managerBId);
    await callAndCaptureRedirect(() => submitPicksAction(pickFormData({ pick: franchiseB })));

    expect(picksFor(managerAId)).toHaveLength(1);
    expect(picksFor(managerAId)[0]!.pickedFranchiseId).toBe(franchiseA);
    expect(picksFor(managerBId)).toHaveLength(1);
    expect(picksFor(managerBId)[0]!.pickedFranchiseId).toBe(franchiseB);
  });

  it("a manager can never write another manager's pick — the action ignores any client-submitted identity, always using the session's own manager.id", async () => {
    // No "managerId" field exists on the form at all (see pickFormData) — this test documents that
    // fact by asserting the write always lands under the SESSION's manager, regardless of who
    // submits, proving there is no field to spoof in the first place.
    currentCookie.sessionToken = await createSessionToken(managerAId);
    await callAndCaptureRedirect(() => submitPicksAction(pickFormData()));
    expect(picksFor(managerBId)).toEqual([]);
  });
});

describe("submitPicksAction — editable until lock", () => {
  it("resubmitting before lock replaces the manager's own prior pick (upsert), never accumulates duplicate rows", async () => {
    currentCookie.sessionToken = await createSessionToken(managerAId);
    await callAndCaptureRedirect(() => submitPicksAction(pickFormData({ pick: franchiseA })));
    await callAndCaptureRedirect(() => submitPicksAction(pickFormData({ pick: franchiseB })));

    const rows = picksFor(managerAId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pickedFranchiseId).toBe(franchiseB);
  });
});

describe("submitPicksAction — validation", () => {
  it("rejects a submission missing a pick for a pickable matchup", async () => {
    currentCookie.sessionToken = await createSessionToken(managerAId);
    const fd = new FormData();
    fd.set("season", String(SEASON));
    fd.set("week", "1");
    // No pick_<matchupId> field at all.
    const signal = await callAndCaptureRedirect(() => submitPicksAction(fd));
    expect(signal.url).toBe(`/pickem?error=${encodeURIComponent("Pick a winner for every game before submitting.")}`);
    expect(picksFor(managerAId)).toEqual([]);
  });

  it("rejects a submitted season/week that no longer matches the current pick'em week", async () => {
    currentCookie.sessionToken = await createSessionToken(managerAId);
    const signal = await callAndCaptureRedirect(() => submitPicksAction(pickFormData({ week: 2 })));
    expect(signal.url).toBe(`/pickem?error=${encodeURIComponent("This week's picks have moved on — reload the page and try again.")}`);
    expect(picksFor(managerAId)).toEqual([]);
  });
});

describe("submitPicksAction — server-enforced lock", () => {
  it("rejects a submission once the week is locked (Thursday 20:00 ET, season underway), even with a freshly-loaded form", async () => {
    // Flip the archived snapshot to "season underway" for this test only.
    db.update(snapshots).set({ payload: JSON.stringify({ status: { latestScoringPeriod: 1 } }) }).where(eq(snapshots.view, SEASON_SCOPE_VIEW_KEY)).run();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T20:05:00-04:00")); // Thursday, just after lock

    currentCookie.sessionToken = await createSessionToken(managerAId);
    const signal = await callAndCaptureRedirect(() => submitPicksAction(pickFormData()));
    expect(signal.url).toBe(`/pickem?error=${encodeURIComponent("Picks for this week are locked.")}`);
    expect(picksFor(managerAId)).toEqual([]);

    // Restore preseason state for any later test in this file.
    db.update(snapshots).set({ payload: JSON.stringify({ status: { latestScoringPeriod: 0 } }) }).where(eq(snapshots.view, SEASON_SCOPE_VIEW_KEY)).run();
  });
});

describe("setAiEnabledAction — requireCommissioner gating", () => {
  // Ordered deliberately: the rejection case runs FIRST so it can assert the app_settings row
  // doesn't exist yet at all — the commissioner-success case below is what actually creates it.

  it("a plain manager CANNOT enable the toggle: redirects home, never writes app_settings", async () => {
    currentCookie.sessionToken = await createSessionToken(managerAId);
    const fd = new FormData();
    fd.set("aiEnabled", "on");
    const signal = await callAndCaptureRedirect(() => setAiEnabledAction(fd));
    expect(signal.url).toBe("/");
    const row = db.select().from(appSettings).where(eq(appSettings.key, "pickem_ai_enabled")).get();
    expect(row).toBeUndefined();
  });

  it("a commissioner can enable the toggle", async () => {
    currentCookie.sessionToken = await createSessionToken(commissionerId);
    const fd = new FormData();
    fd.set("aiEnabled", "on");
    const signal = await callAndCaptureRedirect(() => setAiEnabledAction(fd));
    expect(signal.url).toBe("/pickem?success=ai_toggle");
    const row = db.select().from(appSettings).where(eq(appSettings.key, "pickem_ai_enabled")).get();
    expect(row?.valueJson).toBe(true);
  });
});
