import { describe, expect, it } from "vitest";
import { analyzeTrade } from "../tradeAnalytics";

describe("analyzeTrade", () => {
  it("keeps every side of a recovered multi-team transaction and declines to invent a winner", () => {
    const result = analyzeTrade(
      [
        { transactionId: 700, espnTxId: "recovered-700", season: 2023, week: 5, teamSeasonId: 11, franchiseId: 1, playerId: 101, source: "inferred" },
        { transactionId: 700, espnTxId: "recovered-700", season: 2023, week: 5, teamSeasonId: 22, franchiseId: 2, playerId: 202, source: "inferred" },
        { transactionId: 700, espnTxId: "recovered-700", season: 2023, week: 5, teamSeasonId: 33, franchiseId: 3, playerId: 303, source: "inferred" },
      ],
      [],
      [
        { teamSeasonId: 11, playerId: 101, week: 5, isStarter: true, points: 10 },
        { teamSeasonId: 22, playerId: 202, week: 5, isStarter: true, points: 20 },
        { teamSeasonId: 33, playerId: 303, week: 5, isStarter: true, points: 30 },
      ],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ transactionId: 700, winnerFranchiseId: null, marginPoints: null, dataQuality: "recovered_incomplete" });
    expect(result[0]?.sides.map((side) => side.franchiseId)).toEqual([1, 2, 3]);
  });

  it("is empty-safe", () => {
    expect(analyzeTrade([], [], [])).toEqual([]);
  });
});
