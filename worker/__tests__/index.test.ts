import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Cron } from "croner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../../src/server/db/client";
import { runMigrations } from "../../src/server/db/migrate";
import { franchises, leagues, matchups, seasons, syncRuns, teamSeasons, type NewMatchup } from "../../src/server/db/schema";
import { SEASON_SCOPE_VIEW_KEY } from "../../src/server/sync/espn-shapes";
import { getManualSyncRequestState, requestManualSync } from "../../src/server/sync/manual-sync";
import { storeSnapshot } from "../../src/server/sync/snapshots";
import type { BackfillEspnClient } from "../../src/server/espn/backfill";
import type { EspnLogger, FetchLeagueResult } from "../../src/server/espn/types";
import {
  LIVE_SYNC_CRON_MONDAY,
  LIVE_SYNC_CRON_SUNDAY,
  LIVE_SYNC_CRON_SUNDAY_EARLY,
  LIVE_SYNC_CRON_THURSDAY,
  LIVE_SYNC_CRONS,
  MANUAL_SYNC_POLL_CRON,
  runDailyTick,
  runHourlyTick,
  runLiveTick,
  runManualSyncTick,
  WORKER_TIMEZONE,
  type WorkerDeps,
} from "../index";

// 2024-11-07 is a real Thursday, 2024-11-06 a real Wednesday (America/New_York) — confirmed via
// Intl weekday lookup, not assumed. November is EST (UTC-5) in both years.
const THURSDAY_IN_WINDOW = new Date("2024-11-07T20:10:00-05:00");
const WEDNESDAY_OUT_OF_WINDOW = new Date("2024-11-06T20:10:00-05:00");

function neverCalledClient(): BackfillEspnClient {
  return {
    fetchLeague: vi.fn((): Promise<FetchLeagueResult> => {
      throw new Error("fetchLeague should never be called when any live-tick gate fails");
    }),
  };
}

/** Succeeds unconditionally with a minimal (schema-incomplete, deliberately) payload — this
 * suite only cares whether `runLiveTick` actually reaches `runSyncTier` at all (i.e. whether it
 * calls the ESPN client), not whether a full normalize succeeds against hand-inserted layer-2
 * rows with no matching season-scope team/schedule data. */
function alwaysSucceedsClient(): BackfillEspnClient {
  return {
    fetchLeague: vi.fn(
      async (): Promise<FetchLeagueResult> => ({
        payload: JSON.stringify({}),
        json: {},
        url: "https://example.com/period",
        status: 200,
      }),
    ),
  };
}

function testLogger(): EspnLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("runLiveTick", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-worker-live-tick-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Layer-2 fixture only (franchises/team_seasons/one matchup) — deliberately separate from
   * `seedSeasonScopeSnapshot` below, since the two are independent gates (`hasScheduledNonFinalMatchup`
   * reads the matchups table; `isSeasonUnderway` reads the snapshots table) and fix round 1 exists
   * specifically because a real season can have ONE of these true without the other. */
  function seedTeamsAndMatchup(season: number, matchupOverrides: Partial<NewMatchup> = {}): void {
    const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: season }).returning().get();
    db.insert(seasons)
      .values({ season, leagueId: league.id, settingsJson: {}, scoringJson: {}, playoffFormatJson: {}, teamCount: 2, regSeasonWeeks: 1, status: "active" })
      .run();
    const f1 = db.insert(franchises).values({ canonicalName: "F1", managerName: "M1", joinedSeason: season, active: true }).returning().get().id;
    const f2 = db.insert(franchises).values({ canonicalName: "F2", managerName: "M2", joinedSeason: season, active: true }).returning().get().id;
    const ts1 = db
      .insert(teamSeasons)
      .values({ season, franchiseId: f1, espnTeamId: 1, teamName: "T1", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
    const ts2 = db
      .insert(teamSeasons)
      .values({ season, franchiseId: f2, espnTeamId: 2, teamName: "T2", wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, madePlayoffs: false })
      .returning()
      .get().id;
    db.insert(matchups)
      .values({
        season,
        week: 1,
        espnMatchupId: 1,
        homeTeamSeasonId: ts1,
        awayTeamSeasonId: ts2,
        homeScore: 10,
        awayScore: 7,
        isFinal: false,
        winner: null,
        ...matchupOverrides,
      })
      .run();
  }

  /** Archives a season-scope snapshot with the given `status.latestScoringPeriod` — the exact
   * signal `isSeasonUnderway` reads. `latestScoringPeriod: 0` reproduces the FIX ROUND 1 bug
   * scenario verbatim: ESPN has generated the season's full schedule (real 2026: 84 matchup rows)
   * MONTHS before week 1 actually starts, and `status.latestScoringPeriod` stays 0 the whole time. */
  function seedSeasonScopeSnapshot(season: number, latestScoringPeriod: number): void {
    storeSnapshot(db, {
      season,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season-scope",
      httpStatus: 200,
      payload: JSON.stringify({ status: { latestScoringPeriod, finalScoringPeriod: 17, currentMatchupPeriod: Math.max(latestScoringPeriod, 1) } }),
    });
  }

  it("does nothing at all outside a live window, even with a genuinely underway season in the DB", async () => {
    seedTeamsAndMatchup(2024);
    seedSeasonScopeSnapshot(2024, 1); // genuinely underway
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runLiveTick(deps, WEDNESDAY_OUT_OF_WINDOW);

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    expect(db.select().from(syncRuns).all()).toHaveLength(0);
  });

  it("FIX ROUND 1 — does nothing during a live window when the season's schedule exists but hasn't started (real 2026 bug: latestScoringPeriod is 0)", async () => {
    seedTeamsAndMatchup(2024); // the schedule/matchup shells exist, all non-final — exactly like real 2026
    seedSeasonScopeSnapshot(2024, 0); // ESPN's own signal: week 1 has NOT kicked off yet
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runLiveTick(deps, THURSDAY_IN_WINDOW);

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    expect(db.select().from(syncRuns).all()).toHaveLength(0);
  });

  it("does nothing during a live window when no season-scope snapshot has ever been archived (even earlier than any ESPN status is known)", async () => {
    seedTeamsAndMatchup(2024); // matchup shells exist, but zero snapshots archived at all
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runLiveTick(deps, THURSDAY_IN_WINDOW);

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    expect(db.select().from(syncRuns).all()).toHaveLength(0);
  });

  it("does nothing during a live window once a genuinely-underway season is fully complete (every matchup final)", async () => {
    seedTeamsAndMatchup(2024, { isFinal: true, winner: "home", homeScore: 30, awayScore: 20 });
    seedSeasonScopeSnapshot(2024, 17); // the season DID start and run its course
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runLiveTick(deps, THURSDAY_IN_WINDOW);

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    expect(db.select().from(syncRuns).all()).toHaveLength(0);
  });

  it("runs a live sync_runs row (tier 'live') when all three gates pass", async () => {
    seedTeamsAndMatchup(2024);
    seedSeasonScopeSnapshot(2024, 1); // genuinely underway, non-final matchup exists, inside window
    const client = alwaysSucceedsClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runLiveTick(deps, THURSDAY_IN_WINDOW);

    expect(result).not.toBeNull();
    // The live tier fetches exactly ONE view (the current period's), since a season-scope
    // snapshot already exists to read the period from.
    expect(client.fetchLeague).toHaveBeenCalledTimes(1);
    const rows = db.select().from(syncRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("live");
    expect(rows[0]!.finishedAt).not.toBeNull();
    expect(result!.status).not.toBe("auth_failed");
  });

  it("does not double-count sync_runs across repeated calls that each correctly no-op", async () => {
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };
    await runLiveTick(deps, WEDNESDAY_OUT_OF_WINDOW);
    await runLiveTick(deps, WEDNESDAY_OUT_OF_WINDOW);
    expect(db.select().from(syncRuns).all()).toHaveLength(0);
  });

  it("fix round 1, finding 2 — skips (4th gate) when another sync is already running, even though all three other gates pass", async () => {
    seedTeamsAndMatchup(2024);
    seedSeasonScopeSnapshot(2024, 1); // genuinely underway, non-final matchup exists, inside window
    db.insert(syncRuns).values({ startedAt: THURSDAY_IN_WINDOW, tier: "manual", status: "running" }).run();
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runLiveTick(deps, THURSDAY_IN_WINDOW);

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    // Still just the one (already-running) row — the live tier never started a second one.
    expect(db.select().from(syncRuns).all()).toHaveLength(1);
  });
});

describe("runHourlyTick / runDailyTick (fix round 1, finding 2 — symmetric guard)", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-worker-hourly-daily-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runHourlyTick runs a sync_runs row tagged tier 'hourly' when nothing else is running", async () => {
    const client = alwaysSucceedsClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runHourlyTick(deps, new Date("2026-09-10T12:00:00Z"));

    expect(result).not.toBeNull();
    const rows = db.select().from(syncRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("hourly");
  });

  it("runHourlyTick skips (no sync_runs row, no ESPN call) when another sync is already running", async () => {
    db.insert(syncRuns).values({ startedAt: new Date("2026-09-10T12:00:00Z"), tier: "manual", status: "running" }).run();
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runHourlyTick(deps, new Date("2026-09-10T12:00:05Z"));

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    expect(db.select().from(syncRuns).all()).toHaveLength(1); // still just the one running row
  });

  it("runDailyTick runs a sync_runs row tagged tier 'daily' when nothing else is running", async () => {
    const client = alwaysSucceedsClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runDailyTick(deps, new Date("2026-09-10T09:00:00Z"));

    expect(result).not.toBeNull();
    const rows = db.select().from(syncRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("daily");
  });

  it("runDailyTick skips (no sync_runs row, no ESPN call) when another sync is already running", async () => {
    db.insert(syncRuns).values({ startedAt: new Date("2026-09-10T09:00:00Z"), tier: "live", status: "running" }).run();
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runDailyTick(deps, new Date("2026-09-10T09:00:05Z"));

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    expect(db.select().from(syncRuns).all()).toHaveLength(1);
  });

  it("a STALE 'running' row (older than the threshold) does not block a new hourly tick", async () => {
    // Same self-healing guarantee `manual-sync.test.ts` proves directly — this confirms the real
    // tick entry points actually get the benefit, not just the underlying helper function.
    db.insert(syncRuns).values({ startedAt: new Date("2026-09-10T11:00:00Z"), tier: "hourly", status: "running" }).run();
    const client = alwaysSucceedsClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    // 16 minutes later — past STALE_RUNNING_THRESHOLD_MS (15 min).
    const result = await runHourlyTick(deps, new Date("2026-09-10T11:16:00Z"));

    expect(result).not.toBeNull();
    expect(client.fetchLeague).toHaveBeenCalled();
  });
});

describe("runManualSyncTick", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-worker-manual-sync-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does nothing (and records no sync_runs row) when nothing was requested", async () => {
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runManualSyncTick(deps);

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    expect(db.select().from(syncRuns).all()).toHaveLength(0);
  });

  it("runs a sync_runs row tagged tier 'manual' when a request is pending", async () => {
    requestManualSync(db, new Date("2026-09-10T12:00:00Z"));
    const client = alwaysSucceedsClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runManualSyncTick(deps, new Date("2026-09-10T12:00:30Z"));

    expect(result).not.toBeNull();
    const rows = db.select().from(syncRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tier).toBe("manual");
  });

  it("clears the request flag once the run finishes, so it never replays on the next poll", async () => {
    requestManualSync(db, new Date("2026-09-10T12:00:00Z"));
    const client = alwaysSucceedsClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    await runManualSyncTick(deps, new Date("2026-09-10T12:00:30Z"));
    expect(getManualSyncRequestState(db).requestedAt).toBeNull();

    // A second poll with nothing newly requested does nothing further.
    const second = await runManualSyncTick(deps, new Date("2026-09-10T12:01:30Z"));
    expect(second).toBeNull();
    expect(db.select().from(syncRuns).all()).toHaveLength(1);
  });

  it("leaves the request queued (no sync_runs row) when another sync starts running AFTER the request was made", async () => {
    // Ordering matters: requestManualSync itself would refuse a request made WHILE something is
    // already running (see manual-sync.test.ts) — this covers the other race, where the request
    // was accepted first and an automatic hourly/daily/live tick starts before the worker's next
    // manual-sync poll picks it up.
    requestManualSync(db, new Date("2026-09-10T12:00:00Z"));
    db.insert(syncRuns).values({ startedAt: new Date(), tier: "hourly", status: "running" }).run();
    const client = neverCalledClient();
    const deps: WorkerDeps = { db, client, sleep: async () => {}, logger: testLogger() };

    const result = await runManualSyncTick(deps);

    expect(result).toBeNull();
    expect(client.fetchLeague).not.toHaveBeenCalled();
    // Still just the one (running) row from the OTHER tier — the manual request never ran.
    expect(db.select().from(syncRuns).all()).toHaveLength(1);
    expect(getManualSyncRequestState(db).requestedAt).not.toBeNull(); // still queued for next poll
  });
});

describe("manual sync poll cron registration", () => {
  it("polls every minute", () => {
    expect(MANUAL_SYNC_POLL_CRON.trim().split(/\s+/)).toHaveLength(5);
    const next = new Cron(MANUAL_SYNC_POLL_CRON, { timezone: WORKER_TIMEZONE }).nextRun(new Date("2026-09-10T12:00:30Z"));
    expect(next).toEqual(new Date("2026-09-10T12:01:00Z"));
  });
});

describe("live tier cron registrations", () => {
  it("declares four cron expressions covering the three named windows (Sunday needs two)", () => {
    expect(LIVE_SYNC_CRONS).toHaveLength(4);
    // Every entry parses as a plausible 5-field cron string (minute hour day month dow).
    for (const expr of LIVE_SYNC_CRONS) {
      expect(expr.trim().split(/\s+/)).toHaveLength(5);
    }
  });

  /** The earliest of the four registrations' own `nextRun()` — i.e. what a real worker running
   * all four `Cron` jobs from `worker/index.ts`'s `main()` would actually do next from `from`. */
  function nextLiveTickFrom(from: Date): Date | null {
    const nexts = LIVE_SYNC_CRONS.map((expr) => new Cron(expr, { timezone: WORKER_TIMEZONE }).nextRun(from)).filter(
      (d): d is Date => d !== null,
    );
    return nexts.length === 0 ? null : nexts.reduce((earliest, d) => (d < earliest ? d : earliest));
  }

  // FIX ROUND 1 (reviewer finding 2): the previous version of this suite only asserted the
  // 5-field SHAPE of these cron strings, never their actual fire-time semantics — a regression
  // (e.g. a wrong hour range, a typo'd day-of-week digit) would have passed silently. These tests
  // assert real fire times via croner's own `nextRun()`, not hand-rolled date math.

  it("from a Wednesday, the next live tick is Thursday 20:00 ET (the window's opening minute)", () => {
    // 2026-09-02 is a real Wednesday (America/New_York), confirmed via Intl weekday lookup in
    // live-window.test.ts's own reference week.
    const from = new Date("2026-09-02T12:00:00-04:00");
    const next = nextLiveTickFrom(from);
    expect(next).toEqual(new Date("2026-09-03T20:00:00-04:00"));
  });

  it("from Sunday 12:00 ET, the next live tick is 12:55 ET the SAME day (the early-open registration), not 13:00", () => {
    // 2026-09-06 is a real Sunday — same reference week as live-window.test.ts.
    const from = new Date("2026-09-06T12:00:00-04:00");
    const next = nextLiveTickFrom(from);
    expect(next).toEqual(new Date("2026-09-06T12:55:00-04:00"));
  });

  it("from a Monday, the next live tick is 20:00 ET that SAME Monday (not bleeding in from Sunday's window)", () => {
    // 2026-09-07 is a real Monday — same reference week.
    const from = new Date("2026-09-07T12:00:00-04:00");
    const next = nextLiveTickFrom(from);
    expect(next).toEqual(new Date("2026-09-07T20:00:00-04:00"));
  });

  it("is correct across the fall DST transition — EST (UTC-5), not a stale EDT offset", () => {
    // 2026-11-04 is a real Wednesday, confirmed the same way as live-window.test.ts's DST test:
    // DST 2026 ends Nov 1, so early November is EST (UTC-5), unlike the EDT (UTC-4) reference
    // week above. Expressed as a UTC instant (not an explicit -05:00 literal) specifically to
    // prove croner resolves the IANA zone itself rather than reusing a cached EDT offset.
    const from = new Date("2026-11-04T17:00:00Z"); // == 2026-11-04T12:00:00-05:00
    const next = nextLiveTickFrom(from);
    expect(next).toEqual(new Date("2026-11-05T20:00:00-05:00")); // Thursday 20:00 EST
  });

  it("each individual cron constant's own nextRun matches its documented window independently", () => {
    // Cross-checks each of the four registrations in isolation (not just their combined minimum
    // above), so a bug confined to exactly one of them can't hide behind the other three.
    const from = new Date("2026-09-02T00:00:00-04:00"); // Wednesday midnight
    expect(new Cron(LIVE_SYNC_CRON_THURSDAY, { timezone: WORKER_TIMEZONE }).nextRun(from)).toEqual(new Date("2026-09-03T20:00:00-04:00"));
    expect(new Cron(LIVE_SYNC_CRON_SUNDAY_EARLY, { timezone: WORKER_TIMEZONE }).nextRun(from)).toEqual(new Date("2026-09-06T12:55:00-04:00"));
    expect(new Cron(LIVE_SYNC_CRON_SUNDAY, { timezone: WORKER_TIMEZONE }).nextRun(from)).toEqual(new Date("2026-09-06T13:00:00-04:00"));
    expect(new Cron(LIVE_SYNC_CRON_MONDAY, { timezone: WORKER_TIMEZONE }).nextRun(from)).toEqual(new Date("2026-09-07T20:00:00-04:00"));
  });
});
