import { describe, expect, it } from "vitest";
import { computeWaiverRoi } from "../waiverROI";

describe("computeWaiverRoi", () => {
  it("returns the claimed player's literal starter value and FAAB efficiency", () => {
    const [result] = computeWaiverRoi(
      [{ teamSeasonId: 11, franchiseId: 7, playerId: 101, week: 3, type: "waiver", bidAmount: 6, transactionId: 91, espnTxId: "claim-91" }],
      [],
      [
        { teamSeasonId: 11, playerId: 101, week: 3, isStarter: true, points: 12 },
        { teamSeasonId: 11, playerId: 101, week: 4, isStarter: true, points: 18 },
      ],
    );

    expect(result).toMatchObject({ franchiseId: 7, starterPoints: 30, startsMade: 2, pointsPerStart: 15, pointsPerFaab: 5 });
  });

  it("is empty-safe", () => {
    expect(computeWaiverRoi([], [], [])).toEqual([]);
  });
});
