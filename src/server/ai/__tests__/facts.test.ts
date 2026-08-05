/**
 * `buildWeekFacts` against a seeded temp DB — proves the real Drizzle joins/where clauses run
 * against the migrated schema and produce the documented shape. The pure helpers it's built from
 * (`computeStandingsSnapshot`, `computeWeekSuperlativeIds`, `computeGamesBack`,
 * `computePlayoffPictureSentences`, `filterTransactionsByScoringPeriod`, `excludeZeroItemTrades`)
 * are unit-tested directly against plain fixture objects in the sibling `facts.pure.test.ts` —
 * same split as every other query module in this codebase (see db-integration.test.ts's docstring).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb, type Db } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import {
  allplayWeek,
  appSettings,
  contextNotes,
  franchises,
  leagues,
  matchups,
  players,
  recordEntries,
  rosterSlots,
  seasons,
  statBuilds,
  teamSeasons,
  teamWeek,
  transactionItems,
  transactions,
  weeks,
} from "@/server/db/schema";
import { buildWeekFacts, RecapIncompleteWeekError } from "../facts";

let db: Db;
let sqlite: Database.Database;
let dbPath: string;

const SEASON = 2024;
let f1: number;
let f2: number;
let f3: number;
let ts1: number;
let ts2: number;
let ts3: number;
let buildId: number;

beforeAll(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hallofblamers-facts-test-")), "test.db");
  const opened = createDb(dbPath);
  db = opened.db;
  sqlite = opened.sqlite;
  runMigrations(db);

  const league = db.insert(leagues).values({ espnLeagueId: 1, name: "Test League", firstSeason: SEASON }).returning().get();
  db.insert(seasons)
    .values({
      season: SEASON,
      leagueId: league.id,
      settingsJson: {},
      scoringJson: {},
      playoffFormatJson: { playoffTeamCount: 2 },
      teamCount: 3,
      regSeasonWeeks: 14,
      status: "active",
    })
    .run();

  f1 = db.insert(franchises).values({ canonicalName: "Gridiron Gladiators", managerName: "Zoe", joinedSeason: SEASON, active: true }).returning().get().id;
  f2 = db.insert(franchises).values({ canonicalName: "Blue Thunder", managerName: "Bob", joinedSeason: SEASON, active: true }).returning().get().id;
  f3 = db.insert(franchises).values({ canonicalName: "Red Rockets", managerName: "Cara", joinedSeason: SEASON, active: true }).returning().get().id;

  const ts = (franchiseId: number, espnTeamId: number, name: string) =>
    db
      .insert(teamSeasons)
      .values({ season: SEASON, franchiseId, espnTeamId, teamName: name, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0, finalStanding: 0, madePlayoffs: false })
      .returning()
      .get().id;
  ts1 = ts(f1, 1, "Gladiators");
  ts2 = ts(f2, 2, "Thunder");
  ts3 = ts(f3, 3, "Rockets");

  db.insert(weeks)
    .values([
      { season: SEASON, week: 1, scoringPeriodId: 1, weekType: "regular", isComplete: true },
      { season: SEASON, week: 2, scoringPeriodId: 2, weekType: "regular", isComplete: true },
      { season: SEASON, week: 3, scoringPeriodId: 3, weekType: "regular", isComplete: false },
    ])
    .run();

  // Week 1: F1 beats F2 130-100. F3 sits a bye.
  const matchupWk1 = db
    .insert(matchups)
    .values({ season: SEASON, week: 1, espnMatchupId: 1, homeTeamSeasonId: ts1, awayTeamSeasonId: ts2, homeScore: 130, awayScore: 100, isFinal: true, winner: "home" })
    .returning()
    .get();

  // Week 2: F2 beats F1 140-90 (upset) — flips the rank order and proves movement math. F3 sits a
  // bye again.
  const matchupWk2 = db
    .insert(matchups)
    .values({ season: SEASON, week: 2, espnMatchupId: 2, homeTeamSeasonId: ts2, awayTeamSeasonId: ts1, homeScore: 140, awayScore: 90, isFinal: true, winner: "home" })
    .returning()
    .get();

  buildId = db.insert(statBuilds).values({ startedAt: new Date(), inputHash: "test", status: "ok" }).returning().get().id;

  db.insert(teamWeek)
    .values([
      { buildId, season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, matchupId: matchupWk1.id, score: 130, result: "W", margin: 30, benchPointsLeft: 4, efficiency: 0.9 },
      { buildId, season: SEASON, week: 1, weekType: "regular", teamSeasonId: ts2, franchiseId: f2, opponentFranchiseId: f1, matchupId: matchupWk1.id, score: 100, result: "L", margin: -30, benchPointsLeft: 12, efficiency: 0.7 },
      { buildId, season: SEASON, week: 2, weekType: "regular", teamSeasonId: ts2, franchiseId: f2, opponentFranchiseId: f1, matchupId: matchupWk2.id, score: 140, result: "W", margin: 50, benchPointsLeft: 6, efficiency: 0.85 },
      { buildId, season: SEASON, week: 2, weekType: "regular", teamSeasonId: ts1, franchiseId: f1, opponentFranchiseId: f2, matchupId: matchupWk2.id, score: 90, result: "L", margin: -50, benchPointsLeft: 20, efficiency: 0.6 },
    ])
    .run();

  db.insert(allplayWeek)
    .values([
      { buildId, season: SEASON, week: 2, franchiseId: f2, wins: 1, losses: 1, ties: 0, luckScore: 0.42 },
      { buildId, season: SEASON, week: 2, franchiseId: f1, wins: 1, losses: 1, ties: 0, luckScore: -0.1 },
    ])
    .run();

  // Players + roster slots for week 2's matchup (top performers) and a notable-add candidate.
  db.insert(players)
    .values([
      { espnPlayerId: 101, fullName: "Marcus Vance", defaultPosition: "RB" },
      { espnPlayerId: 102, fullName: "Deion Fields", defaultPosition: "WR" },
      { espnPlayerId: 103, fullName: "Casey Waiver", defaultPosition: "WR" },
      { espnPlayerId: 104, fullName: "Sam Bench", defaultPosition: "TE" },
    ])
    .run();
  db.insert(rosterSlots)
    .values([
      { season: SEASON, week: 2, teamSeasonId: ts2, playerId: 101, lineupSlot: "RB", isStarter: true, points: 35.2, eligibleSlotsJson: ["RB"] },
      { season: SEASON, week: 2, teamSeasonId: ts1, playerId: 102, lineupSlot: "WR", isStarter: true, points: 28.1, eligibleSlotsJson: ["WR"] },
      { season: SEASON, week: 2, teamSeasonId: ts2, playerId: 103, lineupSlot: "WR", isStarter: false, points: 19.4, eligibleSlotsJson: ["WR"] },
      { season: SEASON, week: 2, teamSeasonId: ts1, playerId: 104, lineupSlot: "BE", isStarter: false, points: 3.5, eligibleSlotsJson: ["TE"] },
    ])
    .run();

  // --- transactions, week 2 (scoringPeriodId 2) ---------------------------
  // A real trade WITH items: F1 sends Deion Fields, receives Casey Waiver.
  const realTrade = db
    .insert(transactions)
    .values({ season: SEASON, espnTxId: "trade-real-1", type: "trade", status: "EXECUTED", rawJson: { scoringPeriodId: 2, type: "TRADE_ACCEPT" } })
    .returning()
    .get();
  db.insert(transactionItems)
    .values([
      { transactionId: realTrade.id, teamSeasonId: ts1, playerId: 102, action: "trade_away" },
      { transactionId: realTrade.id, teamSeasonId: ts2, playerId: 102, action: "trade_for" },
      { transactionId: realTrade.id, teamSeasonId: ts2, playerId: 103, action: "trade_away" },
      { transactionId: realTrade.id, teamSeasonId: ts1, playerId: 103, action: "trade_for" },
    ])
    .run();

  // A zero-item TRADE_UPHOLD phantom — must be excluded entirely.
  db.insert(transactions)
    .values({ season: SEASON, espnTxId: "trade-phantom-1", type: "trade", status: "EXECUTED", rawJson: { scoringPeriodId: 2, type: "TRADE_UPHOLD" } })
    .run();

  // A waiver add that scored >= 15 this week — notable add. Casey Waiver already has points via
  // roster_slots above (19.4), so re-add them under ts3 with their own roster row for a clean,
  // unambiguous notable-add case that isn't entangled with the trade.
  db.insert(rosterSlots)
    .values({ season: SEASON, week: 2, teamSeasonId: ts3, playerId: 101, lineupSlot: "BE", isStarter: false, points: 16.0, eligibleSlotsJson: ["RB"] })
    .run();
  const waiverAdd = db
    .insert(transactions)
    .values({ season: SEASON, espnTxId: "waiver-1", type: "waiver", status: "EXECUTED", rawJson: { scoringPeriodId: 2 } })
    .returning()
    .get();
  db.insert(transactionItems).values({ transactionId: waiverAdd.id, teamSeasonId: ts3, playerId: 101, action: "add" }).run();

  // A freeagent add that scored BELOW 15 — must NOT show up as a notable add.
  db.insert(rosterSlots)
    .values({ season: SEASON, week: 2, teamSeasonId: ts3, playerId: 104, lineupSlot: "BE", isStarter: false, points: 5.0, eligibleSlotsJson: ["TE"] })
    .run();
  const faAdd = db
    .insert(transactions)
    .values({ season: SEASON, espnTxId: "fa-1", type: "freeagent", status: "EXECUTED", rawJson: { scoringPeriodId: 2 } })
    .returning()
    .get();
  db.insert(transactionItems).values({ transactionId: faAdd.id, teamSeasonId: ts3, playerId: 104, action: "add" }).run();

  // A transaction from a DIFFERENT scoring period — must never leak into week 2's facts.
  db.insert(transactions).values({ season: SEASON, espnTxId: "waiver-wrong-week", type: "waiver", status: "EXECUTED", rawJson: { scoringPeriodId: 1 } }).run();

  // Record book: a rank-1 record_broken context note + a rank-2 record_entries row, both week 2.
  db.insert(contextNotes)
    .values({
      buildId,
      subjectType: "team_week",
      season: SEASON,
      week: 2,
      franchiseId: f2,
      matchupId: matchupWk2.id,
      ruleId: "record_broken",
      salience: 100,
      renderedText: "Blue Thunder set a new all-time high week score.",
    })
    .run();
  db.insert(recordEntries)
    .values({ buildId, recordKey: "highest_week_score", rank: 2, franchiseId: f1, season: SEASON, week: 1, weekType: "regular", value: 130 })
    .run();

  db.insert(appSettings).values({ key: `recap_notes_${SEASON}_2`, valueJson: "Trade deadline is next week.", updatedAt: new Date() }).run();
});

afterAll(() => {
  sqlite.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

describe("buildWeekFacts — incomplete week", () => {
  it("throws RecapIncompleteWeekError for a week whose weeks.is_complete is false", () => {
    expect(() => buildWeekFacts(db, SEASON, 3)).toThrow(RecapIncompleteWeekError);
  });

  it("throws RecapIncompleteWeekError for a week that doesn't exist at all", () => {
    expect(() => buildWeekFacts(db, SEASON, 99)).toThrow(RecapIncompleteWeekError);
  });
});

describe("buildWeekFacts — standings snapshot movement math", () => {
  it("week 1 has no prior week: every present franchise's rankMovement is null", () => {
    const facts = buildWeekFacts(db, SEASON, 1);
    const f1Row = facts.standings.find((s) => s.franchiseId === f1)!;
    const f2Row = facts.standings.find((s) => s.franchiseId === f2)!;
    expect(f1Row.rank).toBe(1);
    expect(f2Row.rank).toBe(2);
    expect(f1Row.rankMovement).toBeNull();
    expect(f2Row.rankMovement).toBeNull();
    // F3 sat a bye and has zero decided games through week 1 — absent from the ranked snapshot
    // entirely (never fabricated a 0-0 placeholder row).
    expect(facts.standings.some((s) => s.franchiseId === f3)).toBe(false);
  });

  it("week 2's upset flips the rank order: F2 moves up 1, F1 moves down 1", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    const f1Row = facts.standings.find((s) => s.franchiseId === f1)!;
    const f2Row = facts.standings.find((s) => s.franchiseId === f2)!;
    // Both 1-1 after week 2; F2's 240 points-for beats F1's 220 on the tiebreak.
    expect(f2Row.rank).toBe(1);
    expect(f1Row.rank).toBe(2);
    expect(f2Row.rankMovement).toBe(1); // priorRank 2 -> rank 1
    expect(f1Row.rankMovement).toBe(-1); // priorRank 1 -> rank 2
  });
});

describe("buildWeekFacts — zero-item TRADE_UPHOLD phantom exclusion", () => {
  it("excludes the zero-item phantom trade and keeps only the real trade with items", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    expect(facts.transactions.trades).toHaveLength(1);
    const trade = facts.transactions.trades[0]!;
    const gladiators = trade.franchises.find((f) => f.franchiseName === "Gridiron Gladiators")!;
    const thunder = trade.franchises.find((f) => f.franchiseName === "Blue Thunder")!;
    expect(gladiators.sent).toEqual(["Deion Fields"]);
    expect(gladiators.received).toEqual(["Casey Waiver"]);
    expect(thunder.sent).toEqual(["Casey Waiver"]);
    expect(thunder.received).toEqual(["Deion Fields"]);
  });

  it("scopes transactions to the target week's scoring period only", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    // "waiver-wrong-week" (scoringPeriodId 1) must never surface in week 2's facts — the only
    // waiver-type add present should be Marcus Vance (>=15 pts, notable) via ts3.
    const notableNames = facts.transactions.notableAdds.map((a) => a.playerName);
    expect(notableNames).toContain("Marcus Vance");
    expect(notableNames).not.toContain("Sam Bench"); // scored 5.0, below the 15pt threshold
  });
});

describe("buildWeekFacts — other honest-data assertions", () => {
  it("meta carries no fabricated date field", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    expect(facts.meta).toEqual({ season: SEASON, week: 2, weekType: "regular", scoringPeriodId: 2, bracket: null });
    expect("date" in facts.meta).toBe(false);
  });

  it("omits playoff_picture entirely before 5 completed weeks", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    expect(facts.playoffPicture).toBeNull();
  });

  it("surfaces the record_broken context note and the top-3 record_entries row", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    expect(facts.records.broken).toEqual([{ franchiseName: "Blue Thunder", text: "Blue Thunder set a new all-time high week score." }]);
    expect(facts.records.approached).toHaveLength(0); // the rank-2 entry is week 1, not week 2
  });

  it("reads commissioner_notes from app_settings recap_notes_<season>_<week>", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    expect(facts.commissionerNotes).toBe("Trade deadline is next week.");
    // A week with no row set gets null, never an empty-string fabrication.
    expect(buildWeekFacts(db, SEASON, 1).commissionerNotes).toBeNull();
  });

  it("computes top performers, superlatives, and belt-free matchup facts for week 2", () => {
    const facts = buildWeekFacts(db, SEASON, 2);
    const matchup = facts.matchups[0]!;
    expect(matchup.topPerformers[0]).toEqual({ playerName: "Marcus Vance", franchiseName: "Blue Thunder", points: 35.2 });
    expect(matchup.belt).toBeNull();
    expect(facts.superlatives.topScore).toEqual({ franchiseName: "Blue Thunder", value: 140 });
    expect(facts.superlatives.lowScore).toEqual({ franchiseName: "Gridiron Gladiators", value: 90 });
    expect(facts.superlatives.benchDisaster).toEqual({ franchiseName: "Gridiron Gladiators", value: 20 });
    expect(facts.superlatives.luckiestWin).toEqual({ franchiseName: "Blue Thunder", luckScore: 0.42 });
  });
});
