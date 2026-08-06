import { describe, expect, it } from "vitest";
import { bestWorstSchedule, optimalLineupSeason, runWhatIfScenario, scheduleSwap, type WhatIfWeekInput } from "../whatIf";
import { calculatePlayoffOdds, runPlayoffOddsSimulation, type PlayoffOddsInput } from "../playoffOdds";

const CALIBRATION = { intercept: 0, slope: Math.log(10) / 400 };

const schedules: Record<number, WhatIfWeekInput[]> = {
  1: [
    { week: 1, ownScore: 100, opponentFranchiseId: 2, opponentScore: 90 },
    { week: 2, ownScore: 80, opponentFranchiseId: 3, opponentScore: 95 },
    { week: 3, ownScore: 110, opponentFranchiseId: 4, opponentScore: 80 },
  ],
  2: [
    { week: 1, ownScore: 90, opponentFranchiseId: 1, opponentScore: 100 },
    { week: 2, ownScore: 120, opponentFranchiseId: 4, opponentScore: 100 },
    { week: 3, ownScore: 85, opponentFranchiseId: 3, opponentScore: 115 },
  ],
  3: [
    { week: 1, ownScore: 95, opponentFranchiseId: 4, opponentScore: 70 },
    { week: 2, ownScore: 95, opponentFranchiseId: 1, opponentScore: 80 },
    { week: 3, ownScore: 115, opponentFranchiseId: 2, opponentScore: 85 },
  ],
  4: [
    { week: 1, ownScore: 70, opponentFranchiseId: 3, opponentScore: 95 },
    { week: 2, ownScore: 100, opponentFranchiseId: 2, opponentScore: 120 },
    { week: 3, ownScore: 80, opponentFranchiseId: 1, opponentScore: 110 },
  ],
};

describe("deterministic scenario analytics", () => {
  it("swaps only the selected four-team schedules while preserving every own score", () => {
    const result = scheduleSwap(2024, 1, schedules[1], 2, schedules[2]);

    expect(result.franchiseA.record.weeks.map((week) => week.ownScore)).toEqual([100, 80, 110]);
    expect(result.franchiseB.record.weeks.map((week) => week.ownScore)).toEqual([90, 120, 85]);
    expect(result.franchiseA.actual.wins).toBe(2);
    expect(result.franchiseA.record.wins).toBe(1);
    expect(result.franchiseB.actual.wins).toBe(1);
    expect(result.franchiseB.record.wins).toBe(2);
  });

  it("never lets a reported perfect lineup lower the actual score", () => {
    const result = optimalLineupSeason(2024, 1, [
      { week: 1, actualScore: 112, optimalScore: 105, opponentFranchiseId: 2, opponentScore: 108 },
    ]);

    expect(result.record?.pointsFor).toBe(112);
    expect(result.record?.wins).toBe(1);
  });

  it("returns an explicit unavailable result when there are no comparison schedules", () => {
    const result = bestWorstSchedule(2024, 1, schedules[1], []);

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toMatch(/schedule/i);
    expect(result.schedules).toEqual([]);
  });

  it("returns byte-identical odds tables for identical seeded inputs", () => {
    const input: PlayoffOddsInput = {
      standings: [
        { franchiseId: 1, wins: 2, losses: 0, ties: 0, pointsFor: 205 },
        { franchiseId: 2, wins: 1, losses: 1, ties: 0, pointsFor: 190 },
        { franchiseId: 3, wins: 1, losses: 1, ties: 0, pointsFor: 185 },
        { franchiseId: 4, wins: 0, losses: 2, ties: 0, pointsFor: 160 },
      ],
      remainingMatchups: [
        { homeFranchiseId: 1, awayFranchiseId: 4 },
        { homeFranchiseId: 2, awayFranchiseId: 3 },
      ],
      eloByFranchise: new Map([
        [1, 1650],
        [2, 1525],
        [3, 1475],
        [4, 1350],
      ]),
      eloCalibration: CALIBRATION,
      format: { teamCount: 4, playoffTeamCount: 2 },
    };

    expect(runPlayoffOddsSimulation(input, 1690915927, 2_000)).toEqual(
      runPlayoffOddsSimulation(input, 1690915927, 2_000),
    );
    expect(calculatePlayoffOdds(input, 1690915927, 2_000)).toEqual(
      runPlayoffOddsSimulation(input, 1690915927, 2_000),
    );
  });

  it("exposes a typed scenario adapter with explicit availability and the actual-score floor", () => {
    const missing = runWhatIfScenario({
      mode: "best-worst",
      season: 2024,
      franchiseId: 1,
      ownWeeks: schedules[1],
      otherFranchises: [],
    });
    expect(missing.available).toBe(false);
    expect(missing.unavailableReason).toMatch(/schedule/i);

    const lineup = runWhatIfScenario({
      mode: "perfect-lineup",
      season: 2024,
      franchiseId: 1,
      weeks: [{ week: 1, actualScore: 112, optimalScore: 105, opponentFranchiseId: 2, opponentScore: 108 }],
    });
    expect(lineup.available).toBe(true);
    expect(lineup.result?.record?.pointsFor).toBe(112);
  });
});
