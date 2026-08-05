import { describe, expect, it } from "vitest";
import {
  FLEX_TRAP_GREEDY_SCORE,
  FLEX_TRAP_OPTIMAL_SCORE,
  FLEX_TRAP_PLAYERS,
  FLEX_TRAP_SLOT_COUNTS,
  SUPERFLEX_CHAIN_OPTIMAL_SCORE,
  SUPERFLEX_CHAIN_PLAYERS,
  SUPERFLEX_CHAIN_SLOT_COUNTS,
} from "../__fixtures__/optimalLineup";
import { optimalLineup } from "../optimalLineup";

describe("optimalLineup", () => {
  it("beats the greedy FLEX trap (RB/FLEX contention)", () => {
    const result = optimalLineup(FLEX_TRAP_PLAYERS, FLEX_TRAP_SLOT_COUNTS);

    expect(result.optimalScore).toBe(FLEX_TRAP_OPTIMAL_SCORE);
    expect(result.optimalScore).toBeGreaterThan(FLEX_TRAP_GREEDY_SCORE);
    expect(result.usedFallback).toBe(false);

    const bySlot = Object.fromEntries(result.assignments.map((a) => [a.slot, a.playerId]));
    expect(bySlot.RB).toBe("RB_A");
    expect(bySlot.FLEX).toBe("WR_B");
  });

  it("solves a superflex (OP) chain: reserves QB for one QB-eligible player so the OP-only player isn't stranded", () => {
    const result = optimalLineup(SUPERFLEX_CHAIN_PLAYERS, SUPERFLEX_CHAIN_SLOT_COUNTS);

    expect(result.optimalScore).toBe(SUPERFLEX_CHAIN_OPTIMAL_SCORE);
    const bySlot = Object.fromEntries(result.assignments.map((a) => [a.slot, a.playerId]));
    expect(bySlot.QB).toBe("QB_A");
    expect(bySlot.OP).toBe("RB_B");
  });

  it("treats a null-points player as 0 and never prefers them over a scoring alternative", () => {
    const result = optimalLineup(
      [
        { id: "RB_A", points: 12, eligibleSlots: ["RB"] },
        { id: "RB_NULL", points: null, eligibleSlots: ["RB"] },
      ],
      { RB: 1 },
    );

    expect(result.optimalScore).toBe(12);
    expect(result.assignments).toEqual([{ slot: "RB", playerId: "RB_A", points: 12 }]);
  });

  it("a null-points player only fills a slot when they are the sole eligible option", () => {
    const result = optimalLineup([{ id: "K_NULL", points: null, eligibleSlots: ["K"] }], { K: 1 });

    expect(result.optimalScore).toBe(0);
    expect(result.assignments).toEqual([{ slot: "K", playerId: "K_NULL", points: 0 }]);
  });

  it("leaves a slot unfilled when no roster player is eligible for it", () => {
    const result = optimalLineup([{ id: "K_A", points: 9, eligibleSlots: ["K"] }], { K: 1, D_ST: 1 });

    expect(result.optimalScore).toBe(9);
    expect(result.assignments).toEqual([{ slot: "K", playerId: "K_A", points: 9 }]);
  });

  it("fills multiple instances of the same slot label distinctly", () => {
    const result = optimalLineup(
      [
        { id: "RB_A", points: 20, eligibleSlots: ["RB"] },
        { id: "RB_B", points: 15, eligibleSlots: ["RB"] },
        { id: "RB_C", points: 5, eligibleSlots: ["RB"] },
      ],
      { RB: 2 },
    );

    expect(result.optimalScore).toBe(35);
    const playerIds = result.assignments.map((a) => a.playerId).sort();
    expect(playerIds).toEqual(["RB_A", "RB_B"]);
  });

  it("echoes usedFallback back from options without inferring it itself", () => {
    const withFallback = optimalLineup([{ id: "P1", points: 5, eligibleSlots: ["QB"] }], { QB: 1 }, { usedFallback: true });
    expect(withFallback.usedFallback).toBe(true);

    const withoutFallback = optimalLineup([{ id: "P1", points: 5, eligibleSlots: ["QB"] }], { QB: 1 });
    expect(withoutFallback.usedFallback).toBe(false);
  });

  it("returns zero score with no assignments for an empty roster", () => {
    expect(optimalLineup([], { QB: 1 })).toEqual({ optimalScore: 0, assignments: [], usedFallback: false });
  });

  it("returns zero score with no assignments when there are no starting slots", () => {
    expect(optimalLineup([{ id: "P1", points: 20, eligibleSlots: ["QB"] }], {})).toEqual({
      optimalScore: 0,
      assignments: [],
      usedFallback: false,
    });
  });

  it("mandatory-fills a slot with the only eligible player even when their points are negative", () => {
    // Real lineups can't be left short a starter just because the best available option had a
    // bad week — the "optimal" hypothetical must respect the same mandatory-fill constraint the
    // actual lineup did, or bench_points_left/efficiency wouldn't be a fair comparison.
    const result = optimalLineup([{ id: "RB_BAD", points: -5, eligibleSlots: ["RB"] }], { RB: 1 });
    expect(result.optimalScore).toBe(-5);
    expect(result.assignments).toEqual([{ slot: "RB", playerId: "RB_BAD", points: -5 }]);
  });

  it("picks the less-bad option for a mandatory slot when every eligible candidate is negative", () => {
    const result = optimalLineup(
      [
        { id: "RB_WORSE", points: -10, eligibleSlots: ["RB"] },
        { id: "RB_BETTER", points: -2, eligibleSlots: ["RB"] },
      ],
      { RB: 1 },
    );
    expect(result.optimalScore).toBe(-2);
    expect(result.assignments).toEqual([{ slot: "RB", playerId: "RB_BETTER", points: -2 }]);
  });
});
