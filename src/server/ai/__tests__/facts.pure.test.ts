import { describe, expect, it } from "vitest";
import {
  computeGamesBack,
  computePlayoffPictureSentences,
  computeStandingsSnapshot,
  computeWeekSuperlativeIds,
  excludeZeroItemTrades,
  filterTransactionsByScoringPeriod,
  type PlayoffCutlineEntry,
  type StandingsSnapshotSourceRow,
  type SuperlativeAllplayLike,
  type SuperlativeTeamWeekLike,
  type TransactionLike,
} from "../facts";

describe("computeStandingsSnapshot", () => {
  it("week 1: no prior week exists, so every present franchise's movement is null", () => {
    const rows: StandingsSnapshotSourceRow[] = [
      { franchiseId: 1, week: 1, result: "W", score: 100 },
      { franchiseId: 2, week: 1, result: "L", score: 80 },
    ];
    const snapshot = computeStandingsSnapshot(rows, 1);
    expect(snapshot.find((s) => s.franchiseId === 1)).toMatchObject({ rank: 1, rankMovement: null });
    expect(snapshot.find((s) => s.franchiseId === 2)).toMatchObject({ rank: 2, rankMovement: null });
  });

  it("computes movement as priorRank - currentRank", () => {
    const rows: StandingsSnapshotSourceRow[] = [
      { franchiseId: 1, week: 1, result: "W", score: 130 },
      { franchiseId: 2, week: 1, result: "L", score: 100 },
      { franchiseId: 1, week: 2, result: "L", score: 90 },
      { franchiseId: 2, week: 2, result: "W", score: 140 },
    ];
    const snapshot = computeStandingsSnapshot(rows, 2);
    // Both 1-1 after week 2, tiebreak on points-for: franchise 2 (240) > franchise 1 (220).
    expect(snapshot.find((s) => s.franchiseId === 2)).toMatchObject({ rank: 1, rankMovement: 1 });
    expect(snapshot.find((s) => s.franchiseId === 1)).toMatchObject({ rank: 2, rankMovement: -1 });
  });

  it("a franchise with zero decided games through a given week is absent, never a fabricated row", () => {
    const rows: StandingsSnapshotSourceRow[] = [
      { franchiseId: 1, week: 1, result: "W", score: 100 },
      { franchiseId: 2, week: 1, result: "L", score: 80 },
      // franchise 3 sat a bye in week 1 and hasn't played yet.
      { franchiseId: 3, week: 2, result: "W", score: 90 },
    ];
    const week1 = computeStandingsSnapshot(rows, 1);
    expect(week1.some((s) => s.franchiseId === 3)).toBe(false);
  });

  it("bye-week rows (result null) never count toward wins/losses/points", () => {
    const rows: StandingsSnapshotSourceRow[] = [
      { franchiseId: 1, week: 1, result: "W", score: 100 },
      { franchiseId: 1, week: 2, result: null, score: 999 }, // bye — must be ignored entirely
    ];
    const snapshot = computeStandingsSnapshot(rows, 2);
    expect(snapshot.find((s) => s.franchiseId === 1)).toMatchObject({ wins: 1, losses: 0, pointsFor: 100 });
  });

  it("deterministic tiebreak: equal win% and equal points-for resolves by franchiseId ascending", () => {
    const rows: StandingsSnapshotSourceRow[] = [
      { franchiseId: 5, week: 1, result: "W", score: 100 },
      { franchiseId: 2, week: 1, result: "W", score: 100 },
    ];
    const snapshot = computeStandingsSnapshot(rows, 1);
    expect(snapshot.find((s) => s.franchiseId === 2)!.rank).toBe(1);
    expect(snapshot.find((s) => s.franchiseId === 5)!.rank).toBe(2);
  });
});

describe("computeWeekSuperlativeIds", () => {
  const base: SuperlativeTeamWeekLike[] = [
    { franchiseId: 1, opponentFranchiseId: 2, score: 130, margin: 30, result: "W", benchPointsLeft: 4, efficiency: 0.9 },
    { franchiseId: 2, opponentFranchiseId: 1, score: 100, margin: -30, result: "L", benchPointsLeft: 25, efficiency: 0.5 },
    { franchiseId: 3, opponentFranchiseId: 4, score: 95, margin: 2, result: "W", benchPointsLeft: 1, efficiency: 0.95 },
    { franchiseId: 4, opponentFranchiseId: 3, score: 93, margin: -2, result: "L", benchPointsLeft: 10, efficiency: 0.6 },
  ];
  const allplay: SuperlativeAllplayLike[] = [
    { franchiseId: 1, luckScore: -0.2 },
    { franchiseId: 3, luckScore: 0.8 },
  ];

  it("finds top/low score across the week", () => {
    const ids = computeWeekSuperlativeIds(base, allplay);
    expect(ids.topScore).toEqual({ franchiseId: 1, value: 130 });
    expect(ids.lowScore).toEqual({ franchiseId: 4, value: 93 });
  });

  it("finds the biggest blowout and closest game among decided wins", () => {
    const ids = computeWeekSuperlativeIds(base, allplay);
    expect(ids.blowout).toEqual({ winnerFranchiseId: 1, loserFranchiseId: 2, margin: 30 });
    expect(ids.closest).toEqual({ franchiseIdA: 3, franchiseIdB: 4, margin: 2 });
  });

  it("Task 17 — finds 'Beatdown of the Week': the largest losing margin (most negative), loser-attributed", () => {
    const ids = computeWeekSuperlativeIds(base, allplay);
    // franchise 2's -30 loss is worse than franchise 4's -2 loss.
    expect(ids.beatdown).toEqual({ franchiseId: 2, opponentFranchiseId: 1, margin: -30 });
  });

  it("bench disaster is the max benchPointsLeft across the week", () => {
    const ids = computeWeekSuperlativeIds(base, allplay);
    expect(ids.benchDisaster).toEqual({ franchiseId: 2, value: 25 });
  });

  it("luckiest win is the highest luckScore among franchises that WON", () => {
    const ids = computeWeekSuperlativeIds(base, allplay);
    // Franchise 3 won and has the higher luckScore (0.8) among winners (1 and 3).
    expect(ids.luckiestWin).toEqual({ franchiseId: 3, luckScore: 0.8 });
  });

  it("best efficiency is the max efficiency across the week", () => {
    const ids = computeWeekSuperlativeIds(base, allplay);
    expect(ids.bestEfficiency).toEqual({ franchiseId: 3, value: 0.95 });
  });

  it("returns all-null for an empty week", () => {
    const ids = computeWeekSuperlativeIds([], []);
    expect(ids).toEqual({ topScore: null, lowScore: null, closest: null, blowout: null, beatdown: null, benchDisaster: null, luckiestWin: null, bestEfficiency: null });
  });
});

describe("filterTransactionsByScoringPeriod", () => {
  it("keeps only rows whose rawJson.scoringPeriodId matches", () => {
    const txs: TransactionLike[] = [
      { id: 1, type: "waiver", rawJson: { scoringPeriodId: 2 } },
      { id: 2, type: "trade", rawJson: { scoringPeriodId: 3 } },
      { id: 3, type: "freeagent", rawJson: { scoringPeriodId: 2 } },
      { id: 4, type: "drop", rawJson: {} }, // no scoringPeriodId at all
    ];
    expect(filterTransactionsByScoringPeriod(txs, 2).map((t) => t.id)).toEqual([1, 3]);
  });
});

describe("excludeZeroItemTrades", () => {
  it("drops trade-typed rows with zero items, keeps everything else", () => {
    const txs: TransactionLike[] = [
      { id: 1, type: "trade", rawJson: {} }, // real trade, has items
      { id: 2, type: "trade", rawJson: {} }, // phantom TRADE_UPHOLD, zero items
      { id: 3, type: "waiver", rawJson: {} }, // never a trade — passes through regardless
    ];
    const itemCounts = new Map([
      [1, 4],
      [3, 1],
    ]);
    expect(excludeZeroItemTrades(txs, itemCounts).map((t) => t.id)).toEqual([1, 3]);
  });
});

describe("computeGamesBack", () => {
  it("is 0 for identical records", () => {
    expect(computeGamesBack({ wins: 5, losses: 3, ties: 0 }, { wins: 5, losses: 3, ties: 0 })).toBe(0);
  });

  it("is positive when the team trails the anchor by whole games", () => {
    expect(computeGamesBack({ wins: 6, losses: 2, ties: 0 }, { wins: 4, losses: 4, ties: 0 })).toBe(2);
  });

  it("is negative when the team leads the anchor", () => {
    expect(computeGamesBack({ wins: 4, losses: 4, ties: 0 }, { wins: 6, losses: 2, ties: 0 })).toBe(-2);
  });

  it("treats a tie as half a win and half a loss", () => {
    expect(computeGamesBack({ wins: 5, losses: 3, ties: 0 }, { wins: 4, losses: 3, ties: 1 })).toBe(0.5);
  });
});

describe("computePlayoffPictureSentences", () => {
  const standings: PlayoffCutlineEntry[] = [
    { franchiseId: 1, franchiseName: "Alpha", wins: 8, losses: 2, ties: 0, rank: 1 },
    { franchiseId: 2, franchiseName: "Bravo", wins: 6, losses: 4, ties: 0, rank: 2 },
    { franchiseId: 3, franchiseName: "Charlie", wins: 5, losses: 5, ties: 0, rank: 3 },
    { franchiseId: 4, franchiseName: "Delta", wins: 1, losses: 9, ties: 0, rank: 4 },
  ];

  it("includes teams within 1 game of the cutline on both sides, excludes the rest", () => {
    const sentences = computePlayoffPictureSentences(standings, 2);
    expect(sentences).toHaveLength(2); // Bravo (the cut team itself) + Charlie (1 game back); Alpha and Delta are both >1 game away
    expect(sentences.some((s) => s.includes("Bravo"))).toBe(true);
    expect(sentences.some((s) => s.includes("Charlie"))).toBe(true);
    expect(sentences.some((s) => s.includes("Delta"))).toBe(false);
    expect(sentences.some((s) => s.includes("Alpha"))).toBe(false);
  });

  it("returns [] when playoffTeamCount doesn't carve a real boundary out of the field", () => {
    expect(computePlayoffPictureSentences(standings, 0)).toEqual([]);
    expect(computePlayoffPictureSentences(standings, 4)).toEqual([]);
    expect(computePlayoffPictureSentences(standings, 10)).toEqual([]);
  });
});
