/**
 * requireCommissioner() end-to-end for every recaps admin action — same pattern as
 * src/features/admin/__tests__/actions.test.ts (mocks next/headers/next/navigation, points the
 * db/client singleton at a seeded temp DB, since these Server Actions call getDb() internally
 * rather than taking an injected db).
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
const { franchises, leagues, managers, matchups, recapExemplars, recaps, seasons, statBuilds, teamSeasons, teamWeek, weeks } = await import("../../../server/db/schema");
const { createSessionToken } = await import("../../../server/auth/session");
const { generateRecapAction, publishRecapAction, saveRecapEditAction, switchToFallbackAction } = await import("../actions");

type Db = Awaited<ReturnType<typeof createDb>>["db"];

let db: Db;
let sqlite: Database.Database;
let dbPath: string;
const SEASON = 2024;
let existingRecapId: number;

beforeAll(() => {
  process.env.SESSION_SECRET = "a".repeat(32);
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-recaps-action-test-")), "test.db");
  process.env.DATABASE_PATH = dbPath;
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: SEASON }).returning().get();
  db.insert(seasons)
    .values({ season: SEASON, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 14, status: "active" })
    .run();
  const f1 = db.insert(franchises).values({ canonicalName: "Gridiron Gladiators", managerName: "Zoe", joinedSeason: SEASON, active: true }).returning().get().id;
  const f2 = db.insert(franchises).values({ canonicalName: "Blue Thunder", managerName: "Bob", joinedSeason: SEASON, active: true }).returning().get().id;
  const ts1 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f1, espnTeamId: 1, teamName: "Gladiators", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, finalStanding: 0, madePlayoffs: false })
    .returning()
    .get().id;
  const ts2 = db
    .insert(teamSeasons)
    .values({ season: SEASON, franchiseId: f2, espnTeamId: 2, teamName: "Thunder", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, finalStanding: 0, madePlayoffs: false })
    .returning()
    .get().id;
  db.insert(weeks).values({ season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true }).run();
  db.insert(matchups)
    .values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 130, awayScore: 100, isFinal: true, winner: "home" })
    .run();
  const buildId = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get().id;
  db.insert(teamWeek)
    .values({ buildId, season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, score: 130, result: "W", margin: 30 })
    .run();

  existingRecapId = db
    .insert(recaps)
    .values({
      season: SEASON,
      week: 1,
      style: "dry-coach",
      status: "draft",
      factsJson: { meta: { season: SEASON, week: 1, weekType: "regular", scoringPeriodId: 1 } },
      markdownDraft: "# Week 1 Recap\n\nSomething happened.",
    })
    .returning()
    .get().id;
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

describe("generateRecapAction — requireCommissioner gating", () => {
  it("rejects a manager-role session: redirects home, never inserts a recap row", async () => {
    const manager = db.insert(managers).values({ name: "Manager", role: "manager", inviteToken: "tok-gen-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const before = db.select().from(recaps).all().length;
    const formData = new FormData();
    formData.set("seasonWeek", `${SEASON}-1`);
    formData.set("styleId", "dry-coach");

    const signal = await callAndCaptureRedirect(() => generateRecapAction(formData));
    expect(signal.url).toBe("/");

    const after = db.select().from(recaps).all().length;
    expect(after).toBe(before);
  });

  it("rejects an unauthenticated request", async () => {
    currentCookie.sessionToken = undefined;
    const formData = new FormData();
    formData.set("seasonWeek", `${SEASON}-1`);
    formData.set("styleId", "dry-coach");

    const signal = await callAndCaptureRedirect(() => generateRecapAction(formData));
    expect(signal.url).toBe("/login");
  });
});

describe("switchToFallbackAction — requireCommissioner gating", () => {
  it("rejects a manager-role session and never mutates recaps", async () => {
    const manager = db.insert(managers).values({ name: "Manager2", role: "manager", inviteToken: "tok-fallback-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const before = db.select().from(recaps).all().length;
    const formData = new FormData();
    formData.set("recapId", String(existingRecapId));

    const signal = await callAndCaptureRedirect(() => switchToFallbackAction(formData));
    expect(signal.url).toBe("/");
    expect(db.select().from(recaps).all().length).toBe(before);
  });
});

describe("saveRecapEditAction — requireCommissioner gating", () => {
  it("rejects a manager-role session and never changes the row", async () => {
    const manager = db.insert(managers).values({ name: "Manager3", role: "manager", inviteToken: "tok-save-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("recapId", String(existingRecapId));
    formData.set("markdown", "# Tampered");

    const signal = await callAndCaptureRedirect(() => saveRecapEditAction(formData));
    expect(signal.url).toBe("/");

    const row = db.select().from(recaps).where(eq(recaps.id, existingRecapId)).get();
    expect(row?.status).toBe("draft");
    expect(row?.markdownDraft).not.toBe("# Tampered");
  });

  it("accepts a commissioner-role session: sets status 'edited'", async () => {
    const manager = db.insert(managers).values({ name: "Commish", role: "commissioner", inviteToken: "tok-save-accept" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("recapId", String(existingRecapId));
    formData.set("markdown", "# Edited By Commissioner");

    const signal = await callAndCaptureRedirect(() => saveRecapEditAction(formData));
    expect(signal.url).toBe(`/admin/recaps/${existingRecapId}?success=saved`);

    const row = db.select().from(recaps).where(eq(recaps.id, existingRecapId)).get();
    expect(row?.status).toBe("edited");
    expect(row?.markdownDraft).toBe("# Edited By Commissioner");
  });
});

describe("publishRecapAction — requireCommissioner gating", () => {
  it("rejects a manager-role session and never publishes", async () => {
    const manager = db.insert(managers).values({ name: "Manager4", role: "manager", inviteToken: "tok-publish-reject" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("recapId", String(existingRecapId));

    const signal = await callAndCaptureRedirect(() => publishRecapAction(formData));
    expect(signal.url).toBe("/");

    const row = db.select().from(recaps).where(eq(recaps.id, existingRecapId)).get();
    expect(row?.status).not.toBe("published");
    expect(row?.markdownFinal).toBeNull();
  });

  it("accepts a commissioner-role session: freezes markdownFinal and sets status 'published'", async () => {
    const manager = db.insert(managers).values({ name: "Commish2", role: "commissioner", inviteToken: "tok-publish-accept" }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);

    const formData = new FormData();
    formData.set("recapId", String(existingRecapId));

    const signal = await callAndCaptureRedirect(() => publishRecapAction(formData));
    expect(signal.url).toBe(`/admin/recaps/${existingRecapId}?success=published`);

    const row = db.select().from(recaps).where(eq(recaps.id, existingRecapId)).get();
    expect(row?.status).toBe("published");
    expect(row?.markdownFinal).toBe(row?.markdownDraft);
  });
});

/**
 * Task 16 — capture-on-publish, exercised through the real publishRecapAction (not voice.ts
 * directly) so this covers the actual wiring: existingRecapId above was seeded WITHOUT
 * markdownGenerated (pre-Task-16 shape) and its earlier publish in the block above must not have
 * produced an exemplar — asserted here first as the "legacy row" case, alongside the three cases
 * the brief calls out explicitly: diff -> row, no-diff -> nothing, republish -> update in place.
 */
describe("publishRecapAction — Task 16 exemplar capture", () => {
  async function asCommissioner(name: string, tokenSuffix: string): Promise<void> {
    const manager = db.insert(managers).values({ name, role: "commissioner", inviteToken: `tok-voice-${tokenSuffix}` }).returning().get();
    currentCookie.sessionToken = await createSessionToken(manager.id);
  }

  it("the pre-Task-16 legacy row (no markdownGenerated) captured nothing when it was published above", () => {
    const row = db.select().from(recapExemplars).where(eq(recapExemplars.recapId, existingRecapId)).get();
    expect(row).toBeUndefined();
  });

  it("publishing a revised draft (markdownGenerated != markdownDraft) creates an exemplar row", async () => {
    await asCommissioner("Commish-Voice-1", "voice1");
    const recapId = db
      .insert(recaps)
      .values({
        season: SEASON,
        week: 2,
        style: "trash-talk",
        status: "edited",
        factsJson: { meta: { season: SEASON, week: 2 } },
        markdownDraft: "The commissioner's edited version.",
        markdownGenerated: "The AI's original draft.",
      })
      .returning()
      .get().id;

    const formData = new FormData();
    formData.set("recapId", String(recapId));
    await callAndCaptureRedirect(() => publishRecapAction(formData));

    const exemplar = db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recapId)).get();
    expect(exemplar?.draftMd).toBe("The AI's original draft.");
    expect(exemplar?.publishedMd).toBe("The commissioner's edited version.");
    expect(exemplar?.style).toBe("trash-talk");
  });

  it("publishing an UNCHANGED draft (markdownGenerated == markdownDraft) creates nothing", async () => {
    await asCommissioner("Commish-Voice-2", "voice2");
    const recapId = db
      .insert(recaps)
      .values({
        season: SEASON,
        week: 3,
        style: "dry-coach",
        status: "draft",
        factsJson: { meta: { season: SEASON, week: 3 } },
        markdownDraft: "Never touched.",
        markdownGenerated: "Never touched.",
      })
      .returning()
      .get().id;

    const formData = new FormData();
    formData.set("recapId", String(recapId));
    await callAndCaptureRedirect(() => publishRecapAction(formData));

    expect(db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recapId)).get()).toBeUndefined();
  });

  it("re-publishing the SAME recap after another edit UPDATES its exemplar, never duplicates", async () => {
    await asCommissioner("Commish-Voice-3", "voice3");
    const recapId = db
      .insert(recaps)
      .values({
        season: SEASON,
        week: 4,
        style: "dry-coach",
        status: "edited",
        factsJson: { meta: { season: SEASON, week: 4 } },
        markdownDraft: "First edit.",
        markdownGenerated: "AI original.",
      })
      .returning()
      .get().id;

    const publishOnce = new FormData();
    publishOnce.set("recapId", String(recapId));
    await callAndCaptureRedirect(() => publishRecapAction(publishOnce));
    const countAfterFirst = db.select().from(recapExemplars).all().length;

    // Commissioner keeps editing the SAME row and republishes it again.
    db.update(recaps).set({ markdownDraft: "Second, further-edited version.", status: "edited" }).where(eq(recaps.id, recapId)).run();
    const publishAgain = new FormData();
    publishAgain.set("recapId", String(recapId));
    await callAndCaptureRedirect(() => publishRecapAction(publishAgain));
    const countAfterSecond = db.select().from(recapExemplars).all().length;

    expect(countAfterSecond).toBe(countAfterFirst); // no new row
    const exemplar = db.select().from(recapExemplars).where(eq(recapExemplars.recapId, recapId)).get();
    expect(exemplar?.publishedMd).toBe("Second, further-edited version.");
  });
});
