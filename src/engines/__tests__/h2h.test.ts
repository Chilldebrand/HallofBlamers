import { describe, expect, it } from "vitest";
import { buildH2HPairs, type H2HMatchupInput } from "../h2h";

function m(over: Partial<H2HMatchupInput> & { matchupId: number; season: number; week: number }): H2HMatchupInput {
  return {
    weekType: "regular",
    homeFranchiseId: 1,
    awayFranchiseId: 2,
    homeScore: 100,
    awayScore: 90,
    winner: "home",
    ...over,
  };
}

describe("buildH2HPairs", () => {
  it("normalizes to franchiseA < franchiseB regardless of home/away order", () => {
    const pairs = buildH2HPairs([m({ matchupId: 1, season: 2024, week: 1, homeFranchiseId: 5, awayFranchiseId: 2 })]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ franchiseA: 2, franchiseB: 5 });
  });

  it("tallies regular and playoff W-L-T separately, from franchiseA's perspective", () => {
    const pairs = buildH2HPairs([
      m({ matchupId: 1, season: 2024, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }), // A(1) beats B(2), regular
      m({ matchupId: 2, season: 2024, week: 2, homeFranchiseId: 2, awayFranchiseId: 1, winner: "home" }), // B(2) beats A(1), regular
      m({ matchupId: 3, season: 2024, week: 15, weekType: "playoff", homeFranchiseId: 1, awayFranchiseId: 2, winner: "tie" }),
    ]);
    const pair = pairs.find((p) => p.franchiseA === 1 && p.franchiseB === 2)!;
    expect(pair).toMatchObject({ regularW: 1, regularL: 1, regularT: 0, playoffW: 0, playoffL: 0, playoffT: 1 });
  });

  it("excludes consolation games entirely — not counted in either bucket, points, margin, or streak", () => {
    const pairs = buildH2HPairs([
      m({ matchupId: 1, season: 2024, week: 15, weekType: "consolation", homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 200, awayScore: 10, winner: "home" }),
    ]);
    expect(pairs).toEqual([]);
  });

  it("computes total/avg points for each side and avg margin", () => {
    const pairs = buildH2HPairs([
      m({ matchupId: 1, season: 2024, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 100, awayScore: 90, winner: "home" }), // margin 10
      m({ matchupId: 2, season: 2024, week: 2, homeFranchiseId: 2, awayFranchiseId: 1, homeScore: 80, awayScore: 100, winner: "away" }), // A=100,B=80, margin 20
    ]);
    const pair = pairs.find((p) => p.franchiseA === 1 && p.franchiseB === 2)!;
    expect(pair.pointsA).toBe(200); // 100 + 100
    expect(pair.pointsB).toBe(170); // 90 + 80
    expect(pair.avgMargin).toBeCloseTo((10 + 20) / 2, 9);
  });

  it("current streak reflects the H2H series only, direction flips correctly, and a tie clears it", () => {
    const pairs = buildH2HPairs([
      m({ matchupId: 1, season: 2024, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }), // A wins
      m({ matchupId: 2, season: 2024, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }), // A wins again -> streak 2
      m({ matchupId: 3, season: 2024, week: 3, homeFranchiseId: 1, awayFranchiseId: 2, winner: "away" }), // B wins -> streak resets to B,1
    ]);
    const pair = pairs.find((p) => p.franchiseA === 1 && p.franchiseB === 2)!;
    expect(pair.streakHolder).toBe(2);
    expect(pair.streakLen).toBe(1);
  });

  it("a tie clears the streak to null/0", () => {
    const pairs = buildH2HPairs([
      m({ matchupId: 1, season: 2024, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }),
      m({ matchupId: 2, season: 2024, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, winner: "tie", homeScore: 100, awayScore: 100 }),
    ]);
    const pair = pairs.find((p) => p.franchiseA === 1 && p.franchiseB === 2)!;
    expect(pair.streakHolder).toBeNull();
    expect(pair.streakLen).toBe(0);
  });

  it("largest win / closest game / last meeting are tracked correctly", () => {
    const pairs = buildH2HPairs([
      m({ matchupId: 1, season: 2024, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 150, awayScore: 90, winner: "home" }), // margin 60
      m({ matchupId: 2, season: 2024, week: 5, homeFranchiseId: 2, awayFranchiseId: 1, homeScore: 100, awayScore: 99, winner: "home" }), // margin 1, B wins
      m({ matchupId: 3, season: 2025, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 100, awayScore: 95, winner: "home" }),
    ]);
    const pair = pairs.find((p) => p.franchiseA === 1 && p.franchiseB === 2)!;
    expect(pair.largestWin).toMatchObject({ winnerFranchiseId: 1, value: 60, season: 2024, week: 1 });
    expect(pair.closestGame).toMatchObject({ season: 2024, week: 5, margin: 1 });
    expect(pair.lastMeeting).toEqual({ season: 2025, week: 1 });
  });

  it("returns one row per distinct pair, sorted by (franchiseA, franchiseB)", () => {
    const pairs = buildH2HPairs([
      m({ matchupId: 1, season: 2024, week: 1, homeFranchiseId: 3, awayFranchiseId: 5 }),
      m({ matchupId: 2, season: 2024, week: 1, homeFranchiseId: 1, awayFranchiseId: 2 }),
    ]);
    expect(pairs.map((p) => [p.franchiseA, p.franchiseB])).toEqual([
      [1, 2],
      [3, 5],
    ]);
  });

  it("returns an empty array for no matchups", () => {
    expect(buildH2HPairs([])).toEqual([]);
  });
});
