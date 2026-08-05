import { describe, expect, it } from "vitest";
import { buildDraftBoardGrid, computeHighestWeekBySeason, computeSeasonSuperlatives, SENTINEL_PLAYER_ID, type DraftPickCell, type TeamWeekLike } from "../seasons";

describe("computeHighestWeekBySeason", () => {
  it("picks the max-score row per season", () => {
    const map = computeHighestWeekBySeason([
      { season: 2019, week: 1, score: 100, franchiseId: 1 },
      { season: 2019, week: 15, score: 187.7, franchiseId: 4 },
      { season: 2019, week: 3, score: 150, franchiseId: 2 },
      { season: 2020, week: 1, score: 90, franchiseId: 1 },
    ]);
    expect(map.get(2019)).toMatchObject({ score: 187.7, franchiseId: 4, week: 15 });
    expect(map.get(2020)).toMatchObject({ score: 90, franchiseId: 1 });
  });

  it("returns an empty map for no rows", () => {
    expect(computeHighestWeekBySeason([]).size).toBe(0);
  });
});

describe("buildDraftBoardGrid", () => {
  function pick(overrides: Partial<DraftPickCell>): DraftPickCell {
    return { round: 1, roundPick: 1, overallPick: 1, playerId: 101, playerName: "Player", position: "RB", teamName: "Team", keeper: false, ...overrides };
  }

  it("places each pick at [round-1][roundPick-1]", () => {
    const grid = buildDraftBoardGrid(
      [pick({ round: 1, roundPick: 1, playerName: "A" }), pick({ round: 1, roundPick: 2, playerName: "B" }), pick({ round: 2, roundPick: 1, playerName: "C" })],
      2,
    );
    expect(grid.length).toBe(2); // 2 rounds
    expect(grid[0]![0]!.playerName).toBe("A");
    expect(grid[0]![1]!.playerName).toBe("B");
    expect(grid[1]![0]!.playerName).toBe("C");
    expect(grid[1]![1]).toBeNull(); // no pick 2 in round 2 — sparse, not fabricated
  });

  it("sizes every row to teamCount regardless of how many picks are present", () => {
    const grid = buildDraftBoardGrid([pick({ round: 1, roundPick: 1 })], 12);
    expect(grid[0]!.length).toBe(12);
  });

  it("returns an empty grid for teamCount 0 or no picks", () => {
    expect(buildDraftBoardGrid([pick({})], 0)).toEqual([]);
    expect(buildDraftBoardGrid([], 12)).toEqual([]);
  });

  it("ignores an out-of-range round/roundPick rather than throwing", () => {
    const grid = buildDraftBoardGrid([pick({ round: 1, roundPick: 5 })], 2);
    expect(grid[0]).toEqual([null, null]);
  });

  it("drops an individual sentinel pick (playerId -1), leaving that slot blank rather than a fabricated name — real case: a handful of unresolved picks in an otherwise real 2015-2025 draft", () => {
    const grid = buildDraftBoardGrid(
      [
        pick({ round: 1, roundPick: 1, playerId: 101, playerName: "Real Player" }),
        pick({ round: 1, roundPick: 2, playerId: SENTINEL_PLAYER_ID, playerName: "Unknown Player -1" }),
      ],
      2,
    );
    expect(grid[0]![0]!.playerName).toBe("Real Player");
    expect(grid[0]![1]).toBeNull();
  });

  it("returns an empty grid (not a board of placeholders) when EVERY pick is a sentinel — real case: 2026's 192 pre-draft rows", () => {
    const grid = buildDraftBoardGrid(
      Array.from({ length: 4 }, (_, i) => pick({ round: 1, roundPick: i + 1, playerId: SENTINEL_PLAYER_ID, playerName: "Unknown Player -1" })),
      4,
    );
    expect(grid).toEqual([]);
  });

  it("does NOT treat a real D/ST 'player' (large negative id, e.g. -16021 'Eagles D/ST') as a sentinel", () => {
    const grid = buildDraftBoardGrid([pick({ round: 1, roundPick: 1, playerId: -16021, playerName: "Eagles D/ST" })], 1);
    expect(grid[0]![0]!.playerName).toBe("Eagles D/ST");
  });
});

describe("computeSeasonSuperlatives", () => {
  function tw(overrides: Partial<TeamWeekLike>): TeamWeekLike {
    return { franchiseId: 1, opponentFranchiseId: 2, score: 100, margin: 10, result: "W", week: 1, ...overrides };
  }

  it("finds the highest-scoring played week regardless of result", () => {
    const result = computeSeasonSuperlatives([
      tw({ franchiseId: 1, score: 100, result: "W" }),
      tw({ franchiseId: 2, score: 150, result: "L", margin: -10 }),
    ]);
    expect(result.highestWeek).toMatchObject({ franchiseId: 2, value: 150 });
  });

  it("excludes unplayed/future weeks (result null) from ever winning highest week", () => {
    const result = computeSeasonSuperlatives([
      tw({ franchiseId: 1, score: 0, result: null }),
      tw({ franchiseId: 2, score: 80, result: "W", margin: 20 }),
    ]);
    expect(result.highestWeek).toMatchObject({ franchiseId: 2, value: 80 });
  });

  it("finds the biggest blowout and closest game from the winner's margin only", () => {
    const result = computeSeasonSuperlatives([
      tw({ franchiseId: 1, opponentFranchiseId: 2, result: "W", margin: 50, week: 1 }),
      tw({ franchiseId: 3, opponentFranchiseId: 4, result: "W", margin: 0.5, week: 2 }),
      tw({ franchiseId: 2, opponentFranchiseId: 1, result: "L", margin: -50, week: 1 }), // loser side, never wins blowout/closest
    ]);
    expect(result.biggestBlowout).toMatchObject({ winnerFranchiseId: 1, loserFranchiseId: 2, margin: 50 });
    expect(result.closestGame).toMatchObject({ franchiseIdA: 3, franchiseIdB: 4, margin: 0.5 });
  });

  it("Task 17 — finds 'Beatdown of the Week': the LARGEST losing margin (most negative), LOSER-attributed", () => {
    const result = computeSeasonSuperlatives([
      tw({ franchiseId: 1, opponentFranchiseId: 2, result: "L", margin: -10, week: 1 }),
      tw({ franchiseId: 2, opponentFranchiseId: 1, result: "W", margin: 10, week: 1 }),
      tw({ franchiseId: 3, opponentFranchiseId: 4, result: "L", margin: -38.4, week: 2 }),
      tw({ franchiseId: 4, opponentFranchiseId: 3, result: "W", margin: 38.4, week: 2 }),
    ]);
    expect(result.beatdown).toMatchObject({ franchiseId: 3, opponentFranchiseId: 4, margin: -38.4, week: 2 });
  });

  it("returns all-null superlatives for an empty/upcoming season", () => {
    const result = computeSeasonSuperlatives([]);
    expect(result).toEqual({ highestWeek: null, biggestBlowout: null, closestGame: null, beatdown: null });
  });

  it("excludes a bye (opponentFranchiseId null) from blowout/closest/beatdown even if somehow marked decisive", () => {
    const result = computeSeasonSuperlatives([
      tw({ result: "W", opponentFranchiseId: null, margin: 100 }),
      tw({ franchiseId: 2, result: "L", opponentFranchiseId: null, margin: -100 }),
    ]);
    expect(result.biggestBlowout).toBeNull();
    expect(result.closestGame).toBeNull();
    expect(result.beatdown).toBeNull();
  });
});
