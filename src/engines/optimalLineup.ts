/**
 * Exact "best possible lineup" solver — max-weight assignment of a
 * team-week's roster onto a fixed set of starting-slot instances. Greedy
 * point-order assignment is WRONG whenever a wide-eligibility slot (FLEX,
 * OP) and a narrow-eligibility slot (RB, QB, ...) compete for the same
 * players: filling the wide slot first with the best overall player can
 * strand a player who is ONLY eligible for that wide slot, losing points
 * that an exact solver would have kept. See `src/engines/__fixtures__/optimalLineup.ts`
 * for the canonical trap.
 *
 * Pure per AGENTS.md: no DB, no IO, no knowledge of ESPN slot ids — callers
 * translate lineup-slot ids to labels and resolve eligibility fallbacks
 * before calling in.
 */

export interface OptimalLineupPlayerInput {
  id: string | number;
  points: number | null;
  eligibleSlots: string[];
}

export interface OptimalLineupAssignment {
  slot: string;
  playerId: string | number;
  points: number;
}

export interface OptimalLineupOptions {
  /**
   * Set by the caller when it already substituted a player's own
   * `lineup_slot` label for a missing/empty `eligibleSlots` list (see the
   * deliverable's fallback rule). The engine doesn't know or care why — it
   * just echoes this back on the result so downstream code can flag the
   * team-week as `eligibility_fallback`. Keeps the engine dumb about ESPN.
   */
  usedFallback?: boolean;
}

export interface OptimalLineupResult {
  optimalScore: number;
  assignments: OptimalLineupAssignment[];
  usedFallback: boolean;
}

/**
 * `slotCounts`: starting-slot label -> count (STARTING slots only; caller
 * must have already dropped bench/IR counts). `players`: the full team-week
 * roster (starters + bench; caller excludes IR-slotted players). Missing/
 * null `points` is treated as 0.
 *
 * Solved by backtracking over slot INSTANCES (a slot with count 2 becomes
 * two instances), most-constrained slot first (ascending eligible-player
 * count — a good branch-ordering heuristic), with branch-and-bound pruning
 * on an admissible upper bound (sum of each remaining slot's best
 * still-available eligible player, ignoring cross-slot conflicts — this can
 * only overestimate the true achievable remainder, so pruning on it never
 * discards the true optimum). Roster <= 20, slots <= 11 in every real league
 * configuration, so this is exact and fast without a general-purpose
 * assignment-problem dependency.
 *
 * Fill is MANDATORY whenever an eligible unused player exists for a slot
 * instance — matching a real fantasy lineup, where you can't voluntarily
 * bench a starting slot just because your best remaining option scored
 * negative; you still have to start someone. A slot instance is left empty
 * only when literally no eligible player remains for it.
 */
export function optimalLineup(
  players: OptimalLineupPlayerInput[],
  slotCounts: Record<string, number>,
  options?: OptimalLineupOptions,
): OptimalLineupResult {
  const usedFallback = options?.usedFallback ?? false;

  const pool = players.map((p) => ({
    id: p.id,
    points: p.points ?? 0,
    eligible: new Set(p.eligibleSlots),
  }));

  const slotInstances: string[] = [];
  for (const [label, count] of Object.entries(slotCounts)) {
    for (let i = 0; i < count; i++) slotInstances.push(label);
  }

  if (slotInstances.length === 0 || pool.length === 0) {
    return { optimalScore: 0, assignments: [], usedFallback };
  }

  const eligiblePlayersForSlot: number[][] = slotInstances.map((label) =>
    pool.reduce<number[]>((acc, p, idx) => {
      if (p.eligible.has(label)) acc.push(idx);
      return acc;
    }, []),
  );

  // Most-constrained slot instance first — keeps branching low for every
  // realistic roster shape (see module docstring).
  const order = slotInstances
    .map((_, i) => i)
    .sort((a, b) => eligiblePlayersForSlot[a]!.length - eligiblePlayersForSlot[b]!.length);

  let bestScore = Number.NEGATIVE_INFINITY;
  let bestAssignment = new Map<number, number>(); // slotInstanceIdx -> pool idx

  const used = new Set<number>();
  const current = new Map<number, number>();

  function upperBoundFrom(orderPos: number): number {
    let sum = 0;
    for (let i = orderPos; i < order.length; i++) {
      const slotIdx = order[i]!;
      let max = 0; // "no eligible player left" contributes 0, same as the forced-empty case
      for (const pIdx of eligiblePlayersForSlot[slotIdx]!) {
        if (used.has(pIdx)) continue;
        const pts = pool[pIdx]!.points;
        if (pts > max) max = pts;
      }
      sum += max;
    }
    return sum;
  }

  function backtrack(orderPos: number, currentScore: number): void {
    if (orderPos === order.length) {
      if (currentScore > bestScore) {
        bestScore = currentScore;
        bestAssignment = new Map(current);
      }
      return;
    }
    // Upper bound is admissible even under mandatory fill: a forced-empty
    // slot contributes 0 to both the bound and any real completion, so
    // pruning on it never discards the true optimum.
    if (currentScore + upperBoundFrom(orderPos) <= bestScore) return;

    const slotIdx = order[orderPos]!;
    const candidates = eligiblePlayersForSlot[slotIdx]!
      .filter((pIdx) => !used.has(pIdx))
      .sort((a, b) => pool[b]!.points - pool[a]!.points);

    if (candidates.length === 0) {
      backtrack(orderPos + 1, currentScore); // forced empty — no eligible player left, not a choice
      return;
    }

    for (const pIdx of candidates) {
      used.add(pIdx);
      current.set(slotIdx, pIdx);
      backtrack(orderPos + 1, currentScore + pool[pIdx]!.points);
      current.delete(slotIdx);
      used.delete(pIdx);
    }
  }

  backtrack(0, 0);
  if (bestScore === Number.NEGATIVE_INFINITY) bestScore = 0; // no slots to fill

  const assignments: OptimalLineupAssignment[] = [...bestAssignment.entries()]
    .map(([slotIdx, pIdx]) => ({
      slot: slotInstances[slotIdx]!,
      playerId: pool[pIdx]!.id,
      points: pool[pIdx]!.points,
    }))
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));

  return { optimalScore: bestScore, assignments, usedFallback };
}
