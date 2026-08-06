import { describe, expect, it } from "vitest";
import { buildRosterPossession } from "../rosterPossession";

describe("buildRosterPossession", () => {
  it("counts points scored after a claimed player joins the starting lineup", () => {
    const result = buildRosterPossession(
      [{ kind: "acquire", teamSeasonId: 11, playerId: 101, week: 3, acquisitionType: "waiver", transactionId: 91, espnTxId: "claim-91" }],
      [
        { teamSeasonId: 11, playerId: 101, week: 3, isStarter: false, points: 4 },
        { teamSeasonId: 11, playerId: 101, week: 4, isStarter: true, points: 18 },
      ],
    );

    expect(result).toEqual([
      {
        teamSeasonId: 11,
        playerId: 101,
        acquisitionType: "waiver",
        transactionId: 91,
        espnTxId: "claim-91",
        startWeek: 3,
        endWeekExclusive: null,
        stillRostered: true,
        weeksRostered: 2,
        startsMade: 1,
        starterPoints: 18,
      },
    ]);
  });

  it("is stable for an empty archive", () => {
    expect(buildRosterPossession([], [])).toEqual([]);
  });
});
