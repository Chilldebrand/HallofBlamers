import { describe, expect, it } from "vitest";
import { diffTradeRosters } from "../tradeRosterDiff";

describe("diffTradeRosters", () => {
  it("recovers both directions of a two-team roster swap", () => {
    const result = diffTradeRosters(
      [
        { teamSeasonId: 11, playerId: 101 },
        { teamSeasonId: 22, playerId: 202 },
      ],
      [
        { teamSeasonId: 11, playerId: 202 },
        { teamSeasonId: 22, playerId: 101 },
      ],
    );

    expect(result).toEqual([
      { playerId: 101, fromTeamSeasonId: 11, toTeamSeasonId: 22 },
      { playerId: 202, fromTeamSeasonId: 22, toTeamSeasonId: 11 },
    ]);
  });

  it("is empty-safe", () => {
    expect(diffTradeRosters([], [])).toEqual([]);
  });
});
