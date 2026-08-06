import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/client";
import { runMigrations } from "../../db/migrate";
import {
  draftPicks,
  leagues,
  matchups,
  players,
  rosterSlots,
  seasons,
  teamSeasons,
  transactionItems,
  transactions,
  weeks,
} from "../../db/schema";
import {
  buildDraftTypeTransaction,
  buildFranchiseSeed,
  buildFreeAgentTransaction,
  buildFutureRosterTransaction,
  buildLeagueHistoryWrappedPayload,
  buildRosterDropTransaction,
  buildSeasonScopePayload,
  buildTradeTransaction,
  buildTransactionsPeriodPayload,
  buildUnexecutedTradeProposal,
  buildWaiverTransaction,
  buildWeekScopePayload,
  FIXTURE_LEAGUE_ID,
  FIXTURE_SEASON,
} from "../__fixtures__/season-2024";
import { loadSeedCorrections } from "../corrections";
import {
  normalizeAll,
  normalizeSeason,
  SEASON_SCOPE_VIEW_KEY,
  TRANSACTIONS_VIEW_KEY,
  WEEK_SCOPE_VIEW_KEY,
} from "../normalize";
import { stableStringify } from "../parse-utils";
import { storeSnapshot } from "../snapshots";
import { runStatBuild } from "../../stats/build";

function seedStandardSnapshots(db: Db, season = FIXTURE_SEASON, seasonScopePayload: unknown = buildSeasonScopePayload()): void {
  storeSnapshot(db, {
    season,
    scoringPeriod: null,
    view: SEASON_SCOPE_VIEW_KEY,
    url: "https://example.com/season",
    httpStatus: 200,
    payload: JSON.stringify(seasonScopePayload),
  });
  storeSnapshot(db, {
    season,
    scoringPeriod: 1,
    view: WEEK_SCOPE_VIEW_KEY,
    url: "https://example.com/week1",
    httpStatus: 200,
    payload: JSON.stringify(buildWeekScopePayload(1)),
  });
  storeSnapshot(db, {
    season,
    scoringPeriod: 2,
    view: WEEK_SCOPE_VIEW_KEY,
    url: "https://example.com/week2",
    httpStatus: 200,
    payload: JSON.stringify(buildWeekScopePayload(2)),
  });
}

/** Row content hash excluding autoincrement `id` — used to assert idempotence across rebuilds. */
function contentHash<T extends { id?: unknown }>(rows: T[]): string {
  const stripped = rows.map((r) => {
    const rest: Record<string, unknown> = { ...r };
    delete rest.id;
    return rest;
  });
  stripped.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
  return stableStringify(stripped);
}

/**
 * Replaces churning autoincrement FK values (e.g. `matchups.homeTeamSeasonId`, which points at
 * `team_seasons.id` — a fresh id every rebuild) with a stable business-key lookup, so two
 * rebuilds' rows can be content-compared meaningfully instead of always mismatching on FK ints
 * that legitimately differ between runs even though they reference the "same" logical row.
 */
function translateChurningIds<T extends Record<string, unknown>>(
  rows: T[],
  translations: { field: keyof T & string; map: Map<number, unknown> }[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const { field, map } of translations) {
      const raw = out[field];
      if (raw !== null && raw !== undefined) {
        out[field] = map.has(raw as number) ? map.get(raw as number) : `MISSING(${String(raw)})`;
      }
    }
    return out;
  });
}

/** Captures every layer-2 table this normalizer writes, with churning FKs translated to stable business keys. */
function captureNormalizedSnapshot(db: Db) {
  const teamSeasonRows = db.select().from(teamSeasons).all();
  const teamSeasonIdToEspnId = new Map(teamSeasonRows.map((r) => [r.id, r.espnTeamId] as const));
  const txRows = db.select().from(transactions).all();
  const txIdToEspnTxId = new Map(txRows.map((r) => [r.id, r.espnTxId] as const));

  return {
    seasons: db.select().from(seasons).all(),
    teamSeasons: teamSeasonRows,
    weeks: db.select().from(weeks).all(),
    matchups: translateChurningIds(db.select().from(matchups).all(), [
      { field: "homeTeamSeasonId", map: teamSeasonIdToEspnId },
      { field: "awayTeamSeasonId", map: teamSeasonIdToEspnId },
    ]),
    players: db.select().from(players).all(),
    rosterSlots: translateChurningIds(db.select().from(rosterSlots).all(), [
      { field: "teamSeasonId", map: teamSeasonIdToEspnId },
    ]),
    transactions: txRows,
    transactionItems: translateChurningIds(db.select().from(transactionItems).all(), [
      { field: "transactionId", map: txIdToEspnTxId },
      { field: "teamSeasonId", map: teamSeasonIdToEspnId },
    ]),
    draftPicks: translateChurningIds(db.select().from(draftPicks).all(), [
      { field: "teamSeasonId", map: teamSeasonIdToEspnId },
    ]),
  };
}

describe("normalizeSeason / normalizeAll", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-normalize-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("happy path", () => {
    beforeEach(() => {
      seedStandardSnapshots(db);
    });

    it("writes every layer-2 table with the expected row counts", () => {
      const summary = normalizeSeason(db, FIXTURE_SEASON, {
        franchiseSeed: buildFranchiseSeed(),
        leagueId: FIXTURE_LEAGUE_ID,
      });

      expect(summary.season).toBe(FIXTURE_SEASON);
      expect(summary.written).toEqual({
        leagues: 1,
        seasons: 1,
        team_seasons: 4,
        weeks: 2,
        matchups: 4,
        players: 9, // real archived payloads carry no top-level transactions[] — see fixture docstring
        roster_slots: 13, // week1: 5+2+1+1=9, week2: 1+1+1+1=4
        transactions: 0,
        transaction_items: 0,
        draft_picks: 4,
      });
    });

    it("spot-checks matchup winner derivation", () => {
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const row = db
        .select()
        .from(matchups)
        .where(and(eq(matchups.season, FIXTURE_SEASON), eq(matchups.espnMatchupId, 101)))
        .get();
      expect(row?.winner).toBe("home");
      expect(row?.homeScore).toBe(120.5);
      expect(row?.awayScore).toBe(110.2);
      expect(row?.isFinal).toBe(true);

      // A bye-free schedule entry always resolves winner/isFinal from ESPN's own `winner` field.
      const away = db
        .select()
        .from(matchups)
        .where(and(eq(matchups.season, FIXTURE_SEASON), eq(matchups.espnMatchupId, 102)))
        .get();
      expect(away?.winner).toBe("away");
    });

    it("spot-checks roster_slots is_starter derivation (BE/IR are the only non-starter slots)", () => {
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const team1 = db
        .select()
        .from(teamSeasons)
        .where(and(eq(teamSeasons.season, FIXTURE_SEASON), eq(teamSeasons.espnTeamId, 1)))
        .get()!;

      const rows = db
        .select()
        .from(rosterSlots)
        .where(and(eq(rosterSlots.season, FIXTURE_SEASON), eq(rosterSlots.week, 1), eq(rosterSlots.teamSeasonId, team1.id)))
        .all();
      const byPlayer = new Map(rows.map((r) => [r.playerId, r]));

      expect(byPlayer.get(5001)).toMatchObject({ lineupSlot: "QB", isStarter: true, projectedPoints: 22.0 });
      expect(byPlayer.get(5004)).toMatchObject({ lineupSlot: "BE", isStarter: false });
      expect(byPlayer.get(5005)).toMatchObject({ lineupSlot: "IR", isStarter: false });
      expect(byPlayer.get(5003)).toMatchObject({ lineupSlot: "FLEX", isStarter: true, projectedPoints: null });
      expect(byPlayer.get(5001)?.eligibleSlotsJson).toEqual(["QB", "OP"]);
    });

    it("spot-checks draft pick linkage to team_seasons and player fields", () => {
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const team1 = db
        .select()
        .from(teamSeasons)
        .where(and(eq(teamSeasons.season, FIXTURE_SEASON), eq(teamSeasons.espnTeamId, 1)))
        .get()!;

      const pick = db.select().from(draftPicks).where(eq(draftPicks.playerId, 5001)).get();
      expect(pick).toMatchObject({ teamSeasonId: team1.id, round: 1, roundPick: 1, overallPick: 1, keeper: false });

      const keeperPick = db.select().from(draftPicks).where(eq(draftPicks.playerId, 5101)).get();
      expect(keeperPick?.keeper).toBe(true);

      const auctionPick = db.select().from(draftPicks).where(eq(draftPicks.playerId, 5301)).get();
      expect(auctionPick?.auctionAmount).toBe(15);
    });

    it("spot-checks team_seasons record fields and madePlayoffs (no WINNERS_BRACKET in this fixture)", () => {
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const team1 = db
        .select()
        .from(teamSeasons)
        .where(and(eq(teamSeasons.season, FIXTURE_SEASON), eq(teamSeasons.espnTeamId, 1)))
        .get()!;

      expect(team1).toMatchObject({
        teamName: "Team One",
        abbrev: "ONE",
        wins: 2,
        losses: 0,
        ties: 0,
        pointsFor: 210.5,
        pointsAgainst: 198.2,
        finalStanding: 1,
        madePlayoffs: false,
      });
    });

    it("resolves franchises via BOTH the explicit espnTeamIds path and the ownerSwid fallback path", () => {
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const rows = db.select().from(teamSeasons).where(eq(teamSeasons.season, FIXTURE_SEASON)).all();
      const byEspnId = new Map(rows.map((r) => [r.espnTeamId, r]));

      expect(byEspnId.get(1)?.franchiseId).toBe(1); // explicit (season, espnTeamId) mapping
      expect(byEspnId.get(2)?.franchiseId).toBe(2); // explicit
      expect(byEspnId.get(3)?.franchiseId).toBe(3); // ownerSwid fallback
      expect(byEspnId.get(4)?.franchiseId).toBe(4); // ownerSwid fallback
    });

    it("writes seasons.settings_json verbatim and derives teamCount/regSeasonWeeks/status", () => {
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const row = db.select().from(seasons).where(eq(seasons.season, FIXTURE_SEASON)).get()!;
      expect(row.settingsJson).toEqual((buildSeasonScopePayload() as { settings: unknown }).settings);
      expect(row.teamCount).toBe(4);
      expect(row.regSeasonWeeks).toBe(2); // both weeks are weekType 'regular' in this fixture
      expect(row.status).toBe("complete"); // every week fully decided
    });

    it("season status: 'every currently-recorded week is complete' is NOT enough to call it 'complete' — ESPN's own finalScoringPeriod/latestScoringPeriod settles it", () => {
      // Real-shaped boundary case (confirmed against real archived 2026 pre-playoff-seeding data):
      // the regular season (both fixture weeks) is fully decided, but the league's TRUE final
      // period (5 here, standing in for real playoff weeks) hasn't been reached — ESPN doesn't
      // create schedule[] entries for playoff weeks until bracket seeding happens, so relying on
      // "every week we currently know about is complete" alone would call this season 'complete'
      // 3 weeks early.
      const payload = buildSeasonScopePayload() as Record<string, unknown>;
      payload.status = { finalScoringPeriod: 5, currentMatchupPeriod: 2, latestScoringPeriod: 2 };

      seedStandardSnapshots(db, FIXTURE_SEASON, payload);
      const summary = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const row = db.select().from(seasons).where(eq(seasons.season, FIXTURE_SEASON)).get()!;
      expect(row.status).toBe("active"); // NOT 'complete' — ESPN's own status says 3 more weeks remain
      expect(summary.warnings.some((w) => w.includes("isn't actually over yet"))).toBe(true);
    });

    it("upserts the leagues row with firstSeason = this season", () => {
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const league = db.select().from(leagues).where(eq(leagues.espnLeagueId, FIXTURE_LEAGUE_ID)).get();
      expect(league).toMatchObject({ name: "Fixture League", firstSeason: FIXTURE_SEASON });
    });
  });

  // Real transactions come from per-period `mTransactions2` snapshots (Task 7's live-probed
  // finding) — a season-scope `transactions[]` fallback is kept but is empty in every real
  // payload seen so far. `TRANSACTIONS_VIEW_KEY` is its own snapshot lineage from the weekly
  // roster one.
  describe("transactions: aggregated from per-period mTransactions2 snapshots (Task 7)", () => {
    beforeEach(() => {
      seedStandardSnapshots(db); // season-scope + week1/week2 rosters; no transactions snapshots yet
    });

    it("classifies real types/statuses, dedupes a transaction duplicated across two periods, and maps a TRADE item to trade_away/trade_for on both real teams", () => {
      const tradeTx = buildTradeTransaction();

      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 1,
        view: TRANSACTIONS_VIEW_KEY,
        url: "https://example.com/tx1",
        httpStatus: 200,
        payload: JSON.stringify(
          buildTransactionsPeriodPayload(1, [
            buildFreeAgentTransaction(),
            buildWaiverTransaction(),
            buildUnexecutedTradeProposal(),
            buildDraftTypeTransaction(),
            buildFutureRosterTransaction(),
            tradeTx,
          ]),
        ),
      });
      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 2,
        view: TRANSACTIONS_VIEW_KEY,
        url: "https://example.com/tx2",
        httpStatus: 200,
        // tradeTx appears AGAIN here (same id) — must dedupe, not throw on the unique constraint.
        payload: JSON.stringify(buildTransactionsPeriodPayload(2, [tradeTx, buildRosterDropTransaction()])),
      });

      const summary = normalizeSeason(db, FIXTURE_SEASON, {
        franchiseSeed: buildFranchiseSeed(),
        leagueId: FIXTURE_LEAGUE_ID,
      });

      // freeAgent + waiver + trade + rosterDrop = 4 (proposal/draft/future_roster excluded, trade deduped to 1).
      expect(summary.written.transactions).toBe(4);
      // freeAgent:2 + waiver:2 + trade:4 (2 TRADE items x 2 rows each) + rosterDrop:1 = 9.
      expect(summary.written.transaction_items).toBe(9);

      expect(summary.warnings.some((w) => w.includes("appeared in more than one period"))).toBe(true);
      // Aggregated into ONE line, not a warning per skipped transaction (brief: "not a warning flood").
      const skipNotes = summary.warnings.filter((w) => w.includes("not mapped into normalized rows"));
      expect(skipNotes).toHaveLength(1);
      expect(skipNotes[0]).toMatch(/DRAFT/);
      expect(skipNotes[0]).toMatch(/FUTURE_ROSTER/);
      expect(skipNotes[0]).toMatch(/not executed/);

      const tx = db.select().from(transactions).where(eq(transactions.espnTxId, "tx-trade-1")).get()!;
      expect(tx.type).toBe("trade");
      const team2 = db
        .select()
        .from(teamSeasons)
        .where(and(eq(teamSeasons.season, FIXTURE_SEASON), eq(teamSeasons.espnTeamId, 2)))
        .get()!;
      const team3 = db
        .select()
        .from(teamSeasons)
        .where(and(eq(teamSeasons.season, FIXTURE_SEASON), eq(teamSeasons.espnTeamId, 3)))
        .get()!;
      const items = db.select().from(transactionItems).where(eq(transactionItems.transactionId, tx.id)).all();
      expect(items).toContainEqual(expect.objectContaining({ playerId: 5101, teamSeasonId: team2.id, action: "trade_away" }));
      expect(items).toContainEqual(expect.objectContaining({ playerId: 5101, teamSeasonId: team3.id, action: "trade_for" }));
      expect(items).toContainEqual(expect.objectContaining({ playerId: 5201, teamSeasonId: team3.id, action: "trade_away" }));
      expect(items).toContainEqual(expect.objectContaining({ playerId: 5201, teamSeasonId: team2.id, action: "trade_for" }));

      // Placeholder players for the two id-only ADD targets (6001 from freeAgent, 6002 from waiver).
      expect(db.select().from(players).where(eq(players.espnPlayerId, 6001)).get()).toMatchObject({
        fullName: "Unknown Player 6001",
        defaultPosition: "UNK",
      });
      expect(db.select().from(players).where(eq(players.espnPlayerId, 6002)).get()).toMatchObject({
        fullName: "Unknown Player 6002",
        defaultPosition: "UNK",
      });
    });

    it("recovers an itemless trade from covered before/after rosters and marks every recovered item inferred", () => {
      const week2 = buildWeekScopePayload(2) as {
        schedule: Array<{
          matchupPeriodId: number;
          home: { teamId: number; rosterForCurrentScoringPeriod?: { entries: unknown[] } };
          away: { teamId: number; rosterForCurrentScoringPeriod?: { entries: unknown[] } };
        }>;
      };
      const sides = week2.schedule
        .filter((entry) => entry.matchupPeriodId === 2)
        .flatMap((entry) => [entry.home, entry.away]);
      const team2 = sides.find((side) => side.teamId === 2)!;
      const team3 = sides.find((side) => side.teamId === 3)!;
      const team2Entries = team2.rosterForCurrentScoringPeriod!.entries;
      team2.rosterForCurrentScoringPeriod!.entries = team3.rosterForCurrentScoringPeriod!.entries;
      team3.rosterForCurrentScoringPeriod!.entries = team2Entries;
      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 2,
        view: WEEK_SCOPE_VIEW_KEY,
        url: "https://example.com/week2-trade",
        httpStatus: 200,
        payload: JSON.stringify(week2),
      });

      const echoes = [
        { id: "echo-a", relatedTransactionId: "logical-trade", type: "TRADE_UPHOLD", status: "EXECUTED", teamId: 2, scoringPeriodId: 2 },
        { id: "echo-b", relatedTransactionId: "logical-trade", type: "TRADE_UPHOLD", status: "EXECUTED", teamId: 3, scoringPeriodId: 2 },
      ];
      for (const period of [1, 2]) {
        storeSnapshot(db, {
          season: FIXTURE_SEASON,
          scoringPeriod: period,
          view: TRANSACTIONS_VIEW_KEY,
          url: `https://example.com/tx${period}`,
          httpStatus: 200,
          payload: JSON.stringify(buildTransactionsPeriodPayload(period, echoes)),
        });
      }

      const summary = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });
      const canonical = db.select().from(transactions).where(eq(transactions.espnTxId, "echo-a")).get()!;
      const recovered = db.select().from(transactionItems).where(eq(transactionItems.transactionId, canonical.id)).all();

      expect(summary.written.transaction_items_inferred).toBe(4);
      expect(recovered).toHaveLength(4);
      expect(recovered.every((item) => item.source === "inferred")).toBe(true);
      expect(recovered).toContainEqual(expect.objectContaining({ playerId: 5101, action: "trade_away" }));
      expect(recovered).toContainEqual(expect.objectContaining({ playerId: 5101, action: "trade_for" }));
      expect(recovered).toContainEqual(expect.objectContaining({ playerId: 5201, action: "trade_away" }));
      expect(recovered).toContainEqual(expect.objectContaining({ playerId: 5201, action: "trade_for" }));
    });

    it("does not create a row for an unexecuted transaction (e.g. a pending TRADE_PROPOSAL)", () => {
      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 1,
        view: TRANSACTIONS_VIEW_KEY,
        url: "https://example.com/tx1",
        httpStatus: 200,
        payload: JSON.stringify(buildTransactionsPeriodPayload(1, [buildUnexecutedTradeProposal()])),
      });

      const summary = normalizeSeason(db, FIXTURE_SEASON, {
        franchiseSeed: buildFranchiseSeed(),
        leagueId: FIXTURE_LEAGUE_ID,
      });

      expect(summary.written.transactions).toBe(0);
      expect(db.select().from(transactions).where(eq(transactions.espnTxId, "tx-proposal-1")).get()).toBeUndefined();
    });

    it("uses the WAIVER-specific processDate field for processed_at", () => {
      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 1,
        view: TRANSACTIONS_VIEW_KEY,
        url: "https://example.com/tx1",
        httpStatus: 200,
        payload: JSON.stringify(buildTransactionsPeriodPayload(1, [buildWaiverTransaction()])),
      });

      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const row = db.select().from(transactions).where(eq(transactions.espnTxId, "tx-waiver-1")).get();
      expect(row?.processedAt).toEqual(new Date(1690003600000));
      expect(row?.bidAmount).toBe(5);
    });

    it("keeps season-scope transactions[] as a fallback source when no per-period snapshot covers it", () => {
      const payload = buildSeasonScopePayload() as Record<string, unknown>;
      payload.transactions = [buildFreeAgentTransaction({ id: "tx-fallback-1" })];

      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: null,
        view: SEASON_SCOPE_VIEW_KEY,
        url: "https://example.com/season",
        httpStatus: 200,
        payload: JSON.stringify(payload),
      });
      // No per-period transactions snapshot at all — the season-scope fallback is all there is.

      const summary = normalizeSeason(db, FIXTURE_SEASON, {
        franchiseSeed: buildFranchiseSeed(),
        leagueId: FIXTURE_LEAGUE_ID,
      });

      expect(summary.written.transactions).toBe(1);
      const row = db.select().from(transactions).where(eq(transactions.espnTxId, "tx-fallback-1")).get();
      expect(row?.type).toBe("freeagent");
    });
  });

  it("regression C1: a leagueHistory-style array-wrapped season-scope payload (real pre-2018 shape) normalizes correctly", () => {
    storeSnapshot(db, {
      season: FIXTURE_SEASON,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season",
      httpStatus: 200,
      payload: JSON.stringify(buildLeagueHistoryWrappedPayload(FIXTURE_SEASON)),
    });
    storeSnapshot(db, {
      season: FIXTURE_SEASON,
      scoringPeriod: 1,
      view: WEEK_SCOPE_VIEW_KEY,
      url: "https://example.com/week1",
      httpStatus: 200,
      payload: JSON.stringify(buildWeekScopePayload(1)),
    });
    storeSnapshot(db, {
      season: FIXTURE_SEASON,
      scoringPeriod: 2,
      view: WEEK_SCOPE_VIEW_KEY,
      url: "https://example.com/week2",
      httpStatus: 200,
      payload: JSON.stringify(buildWeekScopePayload(2)),
    });

    const summary = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

    expect(summary.written.team_seasons).toBe(4);
    expect(summary.written.matchups).toBe(4);
    const row = db.select().from(seasons).where(eq(seasons.season, FIXTURE_SEASON)).get();
    expect(row?.teamCount).toBe(4);
  });

  describe("regression C2: playoff tier data only exists on weekly snapshots, never season-scope", () => {
    it("classifies a playoff week and derives made_playoffs from weekly-sourced WINNERS_BRACKET data", () => {
      const seasonScope = buildSeasonScopePayload() as {
        schedule: { id: number; matchupPeriodId: number }[];
      };
      // A 3rd (playoff) week, added to season-scope with NO playoffTierType — matching reality.
      seasonScope.schedule.push(
        { id: 201, matchupPeriodId: 3, home: { teamId: 1, totalPoints: 130 } as never, away: { teamId: 2, totalPoints: 120 } as never, winner: "HOME" } as never,
        { id: 202, matchupPeriodId: 3, home: { teamId: 3, totalPoints: 90 } as never, away: { teamId: 4, totalPoints: 95 } as never, winner: "AWAY" } as never,
      );

      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: null,
        view: SEASON_SCOPE_VIEW_KEY,
        url: "https://example.com/season",
        httpStatus: 200,
        payload: JSON.stringify(seasonScope),
      });
      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 1,
        view: WEEK_SCOPE_VIEW_KEY,
        url: "https://example.com/week1",
        httpStatus: 200,
        payload: JSON.stringify(buildWeekScopePayload(1)),
      });
      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 2,
        view: WEEK_SCOPE_VIEW_KEY,
        url: "https://example.com/week2",
        httpStatus: 200,
        payload: JSON.stringify(buildWeekScopePayload(2)),
      });

      // Week 3's WEEKLY snapshot is the only place playoffTierType shows up: team1 vs team2 in
      // the winners bracket, team3 vs team4 in a consolation ladder.
      const week3Payload = {
        schedule: [
          { id: 101, matchupPeriodId: 1, home: { teamId: 1 }, away: { teamId: 2 }, playoffTierType: "NONE" },
          { id: 102, matchupPeriodId: 1, home: { teamId: 3 }, away: { teamId: 4 }, playoffTierType: "NONE" },
          { id: 103, matchupPeriodId: 2, home: { teamId: 1 }, away: { teamId: 4 }, playoffTierType: "NONE" },
          { id: 104, matchupPeriodId: 2, home: { teamId: 2 }, away: { teamId: 3 }, playoffTierType: "NONE" },
          { id: 201, matchupPeriodId: 3, home: { teamId: 1 }, away: { teamId: 2 }, winner: "HOME", playoffTierType: "WINNERS_BRACKET" },
          { id: 202, matchupPeriodId: 3, home: { teamId: 3 }, away: { teamId: 4 }, winner: "AWAY", playoffTierType: "LOSERS_CONSOLATION_LADDER" },
        ],
      };
      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: 3,
        view: WEEK_SCOPE_VIEW_KEY,
        url: "https://example.com/week3",
        httpStatus: 200,
        payload: JSON.stringify(week3Payload),
      });

      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const week3Row = db
        .select()
        .from(weeks)
        .where(and(eq(weeks.season, FIXTURE_SEASON), eq(weeks.week, 3)))
        .get();
      expect(week3Row?.weekType).toBe("playoff");

      const matchup201 = db
        .select()
        .from(matchups)
        .where(and(eq(matchups.season, FIXTURE_SEASON), eq(matchups.espnMatchupId, 201)))
        .get();
      expect(matchup201?.playoffTier).toBe("WINNERS_BRACKET");

      const rows = db.select().from(teamSeasons).where(eq(teamSeasons.season, FIXTURE_SEASON)).all();
      const byEspnId = new Map(rows.map((r) => [r.espnTeamId, r]));
      expect(byEspnId.get(1)?.madePlayoffs).toBe(true);
      expect(byEspnId.get(2)?.madePlayoffs).toBe(true);
      expect(byEspnId.get(3)?.madePlayoffs).toBe(false); // consolation ladder, not the winners bracket
      expect(byEspnId.get(4)?.madePlayoffs).toBe(false);
    });

    it("prefers settings.scheduleSettings.matchupPeriodCount for reg_season_weeks over the derived weekType count", () => {
      const seasonScope = buildSeasonScopePayload() as {
        settings: { scheduleSettings: { matchupPeriodCount: number } };
      };
      seasonScope.settings.scheduleSettings.matchupPeriodCount = 10; // deliberately NOT what the 2-week derived count would give

      seedStandardSnapshots(db, FIXTURE_SEASON, seasonScope);
      normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const row = db.select().from(seasons).where(eq(seasons.season, FIXTURE_SEASON)).get();
      expect(row?.regSeasonWeeks).toBe(10);
    });

    it("falls back to week > matchupPeriodCount when no weekly snapshots exist at all (real pre-2018 shape)", () => {
      const seasonScope = buildSeasonScopePayload() as {
        schedule: { id: number; matchupPeriodId: number }[];
      };
      seasonScope.schedule.push({
        id: 201,
        matchupPeriodId: 3,
        home: { teamId: 1 } as never,
        away: { teamId: 2 } as never,
        winner: "HOME",
      } as never);

      storeSnapshot(db, {
        season: FIXTURE_SEASON,
        scoringPeriod: null,
        view: SEASON_SCOPE_VIEW_KEY,
        url: "https://example.com/season",
        httpStatus: 200,
        payload: JSON.stringify(seasonScope),
      });
      // No weekly snapshots at all — pre-2018 seasons never archived them.

      const summary = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

      const week3Row = db
        .select()
        .from(weeks)
        .where(and(eq(weeks.season, FIXTURE_SEASON), eq(weeks.week, 3)))
        .get();
      expect(week3Row?.weekType).toBe("playoff"); // week 3 > matchupPeriodCount (2)
      expect(summary.warnings.some((w) => w.includes("no playoff/tier data archived") && w.includes("week 3"))).toBe(
        true,
      );

      const week1Row = db
        .select()
        .from(weeks)
        .where(and(eq(weeks.season, FIXTURE_SEASON), eq(weeks.week, 1)))
        .get();
      expect(week1Row?.weekType).toBe("regular"); // week 1 <= matchupPeriodCount (2)
    });
  });

  it("regression I5: a write-phase failure (DB constraint violation) skips just that season — normalizeAll finishes the rest", () => {
    // A duplicate schedule entry (same id + matchupPeriodId as an existing one) makes
    // insertMatchups violate matchups' UNIQUE(season, week, espn_matchup_id) constraint —
    // a genuine, unplanned write-phase failure, not something normalize.ts pre-validates against.
    const brokenPayload = buildSeasonScopePayload() as { schedule: unknown[] };
    brokenPayload.schedule = [...brokenPayload.schedule, brokenPayload.schedule[0]];
    storeSnapshot(db, {
      season: 2023,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season",
      httpStatus: 200,
      payload: JSON.stringify(brokenPayload),
    });
    storeSnapshot(db, {
      season: 2023,
      scoringPeriod: 1,
      view: WEEK_SCOPE_VIEW_KEY,
      url: "https://example.com/week1",
      httpStatus: 200,
      payload: JSON.stringify(buildWeekScopePayload(1)),
    });

    seedStandardSnapshots(db, FIXTURE_SEASON); // a normal, healthy season

    const seed = buildFranchiseSeed();
    for (const f of seed.franchises) {
      f.managers = f.managers.map((m) => ({ ...m, fromSeason: 2023 }));
      f.espnTeamIds = [...f.espnTeamIds, ...f.espnTeamIds.map((t) => ({ ...t, season: 2023 }))];
    }

    const summaries = normalizeAll(db, { franchiseSeed: seed, leagueId: FIXTURE_LEAGUE_ID });

    const broken = summaries.find((s) => s.season === 2023)!;
    expect(broken.written).toEqual({});
    expect(broken.warnings.some((w) => w.includes("write transaction failed"))).toBe(true);

    const healthy = summaries.find((s) => s.season === FIXTURE_SEASON)!;
    expect(healthy.written.team_seasons).toBe(4);
    expect(healthy.written.matchups).toBe(4);

    // The rollback actually left the DB clean — no half-written row for the broken season.
    const brokenSeasonRow = db.select().from(seasons).where(eq(seasons.season, 2023)).get();
    expect(brokenSeasonRow).toBeUndefined();
  });

  it("idempotence: running normalizeSeason twice produces identical row counts and content (ids aside)", () => {
    seedStandardSnapshots(db);
    const opts = { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID };

    const first = normalizeSeason(db, FIXTURE_SEASON, opts);
    const teamSeasonsRun1 = db.select().from(teamSeasons).all();
    const snapshot1 = captureNormalizedSnapshot(db);

    const second = normalizeSeason(db, FIXTURE_SEASON, opts);
    const teamSeasonsRun2 = db.select().from(teamSeasons).all();
    const snapshot2 = captureNormalizedSnapshot(db);

    expect(first.written).toEqual(second.written);
    for (const key of Object.keys(snapshot1) as (keyof typeof snapshot1)[]) {
      expect(snapshot1[key].length).toBe(snapshot2[key].length);
      expect(contentHash(snapshot1[key])).toBe(contentHash(snapshot2[key]));
    }

    // Prove the hash comparison is actually exercising id-churn, not trivially passing because
    // ids happened to stay the same: child-table autoincrement ids DO advance across a rebuild
    // (weeks has a composite PK with no surrogate id, so it's excluded from this check).
    expect(teamSeasonsRun2.map((r) => r.id)).not.toEqual(teamSeasonsRun1.map((r) => r.id));
  });

  it("corrections: a correction changing a matchup score is applied and survives re-normalize", () => {
    seedStandardSnapshots(db);
    const correctionsDir = path.join(tmpDir, "corrections");
    fs.mkdirSync(correctionsDir);
    fs.writeFileSync(
      path.join(correctionsDir, "matchup-fix.json"),
      JSON.stringify([
        {
          targetTable: "matchups",
          targetKey: { season: FIXTURE_SEASON, week: 1, espn_matchup_id: 101 },
          field: "home_score",
          value: 133.7,
          reason: "test correction",
          createdBy: "test",
        },
      ]),
    );

    const loadResult = loadSeedCorrections(db, correctionsDir);
    expect(loadResult).toEqual({ loaded: 1, warnings: [] });

    const opts = { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID };
    normalizeSeason(db, FIXTURE_SEASON, opts);

    const afterFirst = db
      .select()
      .from(matchups)
      .where(and(eq(matchups.season, FIXTURE_SEASON), eq(matchups.espnMatchupId, 101)))
      .get();
    expect(afterFirst?.homeScore).toBe(133.7);

    // Re-normalize (delete + rebuild from the SAME unchanged snapshot) — the correction is
    // stored in the `corrections` table, not the seed file on disk, so it reapplies every time.
    normalizeSeason(db, FIXTURE_SEASON, opts);

    const afterSecond = db
      .select()
      .from(matchups)
      .where(and(eq(matchups.season, FIXTURE_SEASON), eq(matchups.espnMatchupId, 101)))
      .get();
    expect(afterSecond?.homeScore).toBe(133.7);
  });

  it("unmapped team: season is skipped with a helpful error including ready-to-paste suggestions", () => {
    seedStandardSnapshots(db);

    const seed = buildFranchiseSeed();
    seed.franchises = seed.franchises.filter((f) => f.id !== 4); // team 4 (espnTeamId=4) can no longer resolve

    const summary = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: seed, leagueId: FIXTURE_LEAGUE_ID });

    expect(summary.written).toEqual({});
    expect(summary.warnings.some((w) => w.includes("SKIPPED"))).toBe(true);
    expect(summary.warnings.some((w) => w.includes("espnTeamId=4"))).toBe(true);

    const suggestionBlock = summary.warnings.find((w) => w.trimStart().startsWith("{"));
    expect(suggestionBlock).toBeDefined();
    const parsed = JSON.parse(suggestionBlock!) as { franchises: { espnTeamIds: { season: number; espnTeamId: number }[] }[] };
    expect(
      parsed.franchises.some((f) => f.espnTeamIds.some((t) => t.season === FIXTURE_SEASON && t.espnTeamId === 4)),
    ).toBe(true);

    // Nothing for this season was written at all — the transaction never opened.
    const rows = db.select().from(teamSeasons).where(eq(teamSeasons.season, FIXTURE_SEASON)).all();
    expect(rows).toHaveLength(0);
  });

  it("validation: an out-of-range score (999) rejects the whole season before writing anything", () => {
    const payload = buildSeasonScopePayload() as { schedule: { home: { totalPoints: number } }[] };
    payload.schedule[0]!.home.totalPoints = 999;

    storeSnapshot(db, {
      season: FIXTURE_SEASON,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season",
      httpStatus: 200,
      payload: JSON.stringify(payload),
    });

    const summary = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

    expect(summary.written).toEqual({});
    expect(summary.warnings.some((w) => w.includes("SKIPPED"))).toBe(true);
    expect(summary.warnings.some((w) => w.includes("999") && w.toLowerCase().includes("out of range"))).toBe(true);

    const row = db.select().from(seasons).where(eq(seasons.season, FIXTURE_SEASON)).get();
    expect(row).toBeUndefined();
  });

  it("normalizeSeason with no snapshot at all: skipped, no throw", () => {
    const summary = normalizeSeason(db, 1999, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });
    expect(summary.written).toEqual({});
    expect(summary.warnings.some((w) => w.includes("SKIPPED"))).toBe(true);
  });

  it("a week with no archived weekly snapshot still normalizes — just without roster_slots for that week", () => {
    storeSnapshot(db, {
      season: FIXTURE_SEASON,
      scoringPeriod: null,
      view: SEASON_SCOPE_VIEW_KEY,
      url: "https://example.com/season",
      httpStatus: 200,
      payload: JSON.stringify(buildSeasonScopePayload()),
    });
    // No weekly snapshots stored at all.

    const summary = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed: buildFranchiseSeed(), leagueId: FIXTURE_LEAGUE_ID });

    expect(summary.written.seasons).toBe(1);
    expect(summary.written.matchups).toBe(4);
    expect(summary.written.roster_slots ?? 0).toBe(0);
    expect(summary.warnings.some((w) => w.includes("no weekly snapshot archived"))).toBe(true);
  });

  it("normalizeAll: normalizes every season with an archived snapshot, ascending", () => {
    seedStandardSnapshots(db, 2023);
    seedStandardSnapshots(db, FIXTURE_SEASON);

    // Widen the fixture's franchise seed to cover 2023 too (it defaults to fromSeason/espnTeamIds
    // scoped only to FIXTURE_SEASON) so both seasons' teams resolve.
    const seed = buildFranchiseSeed();
    for (const f of seed.franchises) {
      f.managers = f.managers.map((m) => ({ ...m, fromSeason: 2023 }));
      f.espnTeamIds = [...f.espnTeamIds, ...f.espnTeamIds.map((t) => ({ ...t, season: 2023 }))];
    }

    const summaries = normalizeAll(db, { franchiseSeed: seed, leagueId: FIXTURE_LEAGUE_ID });

    expect(summaries.map((s) => s.season)).toEqual([2023, FIXTURE_SEASON]);
    for (const s of summaries) {
      expect(s.written.team_seasons).toBe(4);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 4: derived stat tables (team_week, season_stats, etc.) must never
// block a re-normalize. Production defect: normalizeSeason's per-season
// DELETE FROM team_seasons/matchups failed with "FOREIGN KEY constraint
// failed" once a stats:build run had ever produced rows referencing them —
// the exact same rebuildable-layer-2 problem AGENTS.md already documents for
// `events`. Fixed by dropping those FKs (schema.ts); this is the regression
// coverage for the loop production actually runs forever: normalize -> build
// -> normalize AGAIN (with derived rows present) -> build again -> ... .
// ---------------------------------------------------------------------------
describe("normalizeSeason + derived stats coexistence (fix round 4)", () => {
  let tmpDir: string;
  let db: Db;
  let sqlite: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-normalize-rebuild-loop-test-"));
    const opened = createDb(path.join(tmpDir, "test.db"));
    db = opened.db;
    sqlite = opened.sqlite;
    runMigrations(db);
    seedStandardSnapshots(db);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("the real production loop — normalize -> build -> normalize AGAIN (derived rows present) -> build again -> normalize a third time — never fails on a FOREIGN KEY constraint", () => {
    const franchiseSeed = buildFranchiseSeed();

    // Pass 1: normalize, then build derived stats from it.
    const summary1 = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed, leagueId: FIXTURE_LEAGUE_ID });
    expect(Object.keys(summary1.written).length).toBeGreaterThan(0); // written, not skipped
    const build1 = runStatBuild(db, { force: true });
    expect(build1.status).toBe("ok");
    expect(build1.rowCounts.teamWeek).toBeGreaterThan(0);

    // Pass 2: normalize AGAIN. team_week/season_stats/etc. from build1 are still sitting in the
    // DB, referencing team_season/matchup ROW IDS that normalizeSeason's per-season delete is
    // about to wipe and reinsert with fresh autoincrement ids. This must NOT throw.
    const summary2 = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed, leagueId: FIXTURE_LEAGUE_ID });
    expect(Object.keys(summary2.written).length).toBeGreaterThan(0); // written, NOT skipped
    expect(summary2.warnings.some((w) => w.toUpperCase().includes("FOREIGN KEY"))).toBe(false);
    expect(summary2.written.team_seasons).toBe(summary1.written.team_seasons); // same content, fresh ids

    const build2 = runStatBuild(db, { force: true });
    expect(build2.status).toBe("ok");
    expect(build2.rowCounts.teamWeek).toBe(build1.rowCounts.teamWeek); // same shape, consistent

    // Pass 3: once more, to actually exercise this as a loop, not just "twice happens to work".
    const summary3 = normalizeSeason(db, FIXTURE_SEASON, { franchiseSeed, leagueId: FIXTURE_LEAGUE_ID });
    expect(Object.keys(summary3.written).length).toBeGreaterThan(0);
    expect(summary3.warnings.some((w) => w.toUpperCase().includes("FOREIGN KEY"))).toBe(false);

    const build3 = runStatBuild(db, { force: true });
    expect(build3.status).toBe("ok");
    expect(build3.rowCounts.teamWeek).toBe(build1.rowCounts.teamWeek);
  });
});
