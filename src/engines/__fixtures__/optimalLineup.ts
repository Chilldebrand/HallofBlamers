import type { OptimalLineupPlayerInput } from "../optimalLineup";

/**
 * The canonical FLEX trap (from the task brief). A "most-constrained-last"
 * greedy — fill the widest-eligibility slot (FLEX) first with the best
 * overall player, then whatever's left fills the narrow slot (RB) — grabs
 * RB_A for FLEX (it's the highest scorer and IS FLEX-eligible), then fills
 * RB with RB_C, stranding WR_B (FLEX-only-eligible among these three) with
 * nowhere to go: 20 + 15 = 35.
 *
 * The exact optimum recognizes RB_A is needed to unlock WR_B's only slot:
 * RB_A -> RB, WR_B -> FLEX = 20 + 18 = 38.
 */
export const FLEX_TRAP_SLOT_COUNTS: Record<string, number> = { RB: 1, FLEX: 1 };

export const FLEX_TRAP_PLAYERS: OptimalLineupPlayerInput[] = [
  { id: "RB_A", points: 20, eligibleSlots: ["RB", "FLEX"] },
  { id: "WR_B", points: 18, eligibleSlots: ["FLEX"] },
  { id: "RB_C", points: 15, eligibleSlots: ["RB", "FLEX"] },
];

export const FLEX_TRAP_OPTIMAL_SCORE = 38;
export const FLEX_TRAP_GREEDY_SCORE = 35; // what a most-constrained-last greedy would return

/**
 * Same trap shape, transplanted onto QB/OP (superflex) — the exact optimum
 * again requires reserving the narrow QB slot for one of the two
 * QB-eligible players so the OP-only player isn't stranded.
 */
export const SUPERFLEX_CHAIN_SLOT_COUNTS: Record<string, number> = { QB: 1, OP: 1 };

export const SUPERFLEX_CHAIN_PLAYERS: OptimalLineupPlayerInput[] = [
  { id: "QB_A", points: 24, eligibleSlots: ["QB", "OP"] },
  { id: "RB_B", points: 20, eligibleSlots: ["OP"] },
  { id: "QB_C", points: 16, eligibleSlots: ["QB", "OP"] },
];

export const SUPERFLEX_CHAIN_OPTIMAL_SCORE = 44; // QB_A@QB + RB_B@OP
