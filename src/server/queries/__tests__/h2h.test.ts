import { describe, expect, it } from "vitest";
import { buildActiveMatrix, computeAdvantage, computeH2HGameLog, flipH2HPair, type H2HGameLike, type H2HPairLike } from "../h2h";

function pair(overrides: Partial<H2HPairLike>): H2HPairLike {
  return {
    franchiseA: 1,
    franchiseB: 2,
    regW: 5,
    regL: 3,
    regT: 0,
    playoffW: 1,
    playoffL: 0,
    playoffT: 0,
    pointsA: 1000,
    pointsB: 900,
    avgMargin: 12.5,
    streakHolder: 1,
    streakLen: 3,
    ...overrides,
  };
}

const nameOf = (id: number) => (id === 1 ? "Franchise One" : id === 2 ? "Franchise Two" : `Franchise ${id}`);

describe("flipH2HPair", () => {
  it("returns franchise_a's own W/L/T unflipped when queried as franchise_a", () => {
    const p = pair({ franchiseA: 1, franchiseB: 2, regW: 5, regL: 3, playoffW: 1, playoffL: 0 });
    const result = flipH2HPair(p, 1, nameOf);
    expect(result.opponentId).toBe(2);
    expect(result.wins).toBe(6); // 5 reg + 1 playoff
    expect(result.losses).toBe(3);
    expect(result.pointsFor).toBe(p.pointsA);
    expect(result.pointsAgainst).toBe(p.pointsB);
    expect(result.avgMargin).toBe(p.avgMargin);
  });

  it("mirrors W/L, points, and margin sign when queried as franchise_b", () => {
    const p = pair({ franchiseA: 1, franchiseB: 2, regW: 5, regL: 3, playoffW: 1, playoffL: 0, pointsA: 1000, pointsB: 900, avgMargin: 12.5 });
    const result = flipH2HPair(p, 2, nameOf);
    expect(result.opponentId).toBe(1);
    expect(result.wins).toBe(3); // franchise_a's losses become franchise_b's wins
    expect(result.losses).toBe(6);
    expect(result.pointsFor).toBe(900);
    expect(result.pointsAgainst).toBe(1000);
    expect(result.avgMargin).toBe(-12.5); // sign flips
  });

  it("computes games as the sum of wins+losses+ties from either perspective", () => {
    const p = pair({ regW: 5, regL: 3, regT: 1, playoffW: 1, playoffL: 0, playoffT: 0 });
    const asA = flipH2HPair(p, 1, nameOf);
    const asB = flipH2HPair(p, 2, nameOf);
    expect(asA.games).toBe(10);
    expect(asB.games).toBe(10);
  });

  it("labels the streak 'W' for the holder and 'L' for the other side", () => {
    const p = pair({ streakHolder: 1, streakLen: 4 });
    expect(flipH2HPair(p, 1, nameOf).streakText).toBe("W4");
    expect(flipH2HPair(p, 2, nameOf).streakText).toBe("L4");
  });

  it("returns a null streakText when there's no recorded streak", () => {
    const p = pair({ streakHolder: null, streakLen: 0 });
    expect(flipH2HPair(p, 1, nameOf).streakText).toBeNull();
  });
});

describe("computeAdvantage", () => {
  it("returns leading/trailing/even correctly", () => {
    expect(computeAdvantage(6, 3)).toBe("leading");
    expect(computeAdvantage(3, 6)).toBe("trailing");
    expect(computeAdvantage(4, 4)).toBe("even");
  });
});

describe("buildActiveMatrix", () => {
  const franchisesList = [
    { id: 1, name: "Franchise One" },
    { id: 2, name: "Franchise Two" },
    { id: 3, name: "Franchise Three" },
  ];

  it("produces mirrored cells for both sides of a pair", () => {
    const matrix = buildActiveMatrix(franchisesList, [pair({ franchiseA: 1, franchiseB: 2, regW: 6, regL: 2, playoffW: 0, playoffL: 0 })]);
    const row1 = matrix.rows.find((r) => r.franchiseId === 1)!;
    const row2 = matrix.rows.find((r) => r.franchiseId === 2)!;
    expect(row1.cells[2]).toMatchObject({ wins: 6, losses: 2, advantage: "leading" });
    expect(row2.cells[1]).toMatchObject({ wins: 2, losses: 6, advantage: "trailing" });
  });

  it("excludes a pair where either side is not in the given franchise list", () => {
    const matrix = buildActiveMatrix(
      [{ id: 1, name: "Franchise One" }, { id: 2, name: "Franchise Two" }],
      [pair({ franchiseA: 1, franchiseB: 3 })], // 3 is not active/included
    );
    const row1 = matrix.rows.find((r) => r.franchiseId === 1)!;
    expect(row1.cells[3]).toBeUndefined();
  });

  it("leaves a franchise with no games against another as an absent cell, not a fabricated 0-0", () => {
    const matrix = buildActiveMatrix(franchisesList, [pair({ franchiseA: 1, franchiseB: 2 })]);
    const row1 = matrix.rows.find((r) => r.franchiseId === 1)!;
    expect(row1.cells[3]).toBeUndefined();
  });
});

function game(overrides: Partial<H2HGameLike>): H2HGameLike {
  return { season: 2020, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home", ...overrides };
}

describe("computeH2HGameLog", () => {
  it("reads a win/loss from the requested franchise's own perspective, not franchise_a's", () => {
    const games = [game({ homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" })];
    expect(computeH2HGameLog(games, 1)).toEqual(["W"]);
    expect(computeH2HGameLog(games, 2)).toEqual(["L"]);
  });

  it("flips correctly when the requested franchise was the away side", () => {
    const games = [game({ homeFranchiseId: 2, awayFranchiseId: 1, winner: "away" })];
    expect(computeH2HGameLog(games, 1)).toEqual(["W"]);
    expect(computeH2HGameLog(games, 2)).toEqual(["L"]);
  });

  it("renders a tie the same for both sides", () => {
    const games = [game({ winner: "tie" })];
    expect(computeH2HGameLog(games, 1)).toEqual(["T"]);
    expect(computeH2HGameLog(games, 2)).toEqual(["T"]);
  });

  it("preserves input order — caller is responsible for chronological sorting", () => {
    const games = [game({ week: 2, winner: "away" }), game({ week: 1, winner: "home" })];
    expect(computeH2HGameLog(games, 1)).toEqual(["L", "W"]);
  });

  it("returns an empty array for no games", () => {
    expect(computeH2HGameLog([], 1)).toEqual([]);
  });
});
