import { describe, expect, it } from "vitest";
import { allPlayWeek } from "../allPlay";

describe("allPlayWeek", () => {
  it("computes exact W/L/T against every other team, including a tie pair", () => {
    const result = allPlayWeek([
      { franchiseId: 1, score: 120 },
      { franchiseId: 2, score: 100 },
      { franchiseId: 3, score: 90 },
      { franchiseId: 4, score: 100 }, // ties franchise 2
    ]);

    const byId = Object.fromEntries(result.map((r) => [r.franchiseId, r]));
    expect(byId[1]).toEqual({ franchiseId: 1, wins: 3, losses: 0, ties: 0 });
    expect(byId[2]).toEqual({ franchiseId: 2, wins: 1, losses: 1, ties: 1 });
    expect(byId[3]).toEqual({ franchiseId: 3, wins: 0, losses: 3, ties: 0 });
    expect(byId[4]).toEqual({ franchiseId: 4, wins: 1, losses: 1, ties: 1 });
  });

  it("returns 0/0/0 for a single team (nobody to play)", () => {
    expect(allPlayWeek([{ franchiseId: 1, score: 88.5 }])).toEqual([{ franchiseId: 1, wins: 0, losses: 0, ties: 0 }]);
  });

  it("returns an empty array for no teams", () => {
    expect(allPlayWeek([])).toEqual([]);
  });

  it("returns results in input order", () => {
    const result = allPlayWeek([
      { franchiseId: 9, score: 50 },
      { franchiseId: 3, score: 60 },
    ]);
    expect(result.map((r) => r.franchiseId)).toEqual([9, 3]);
  });
});
