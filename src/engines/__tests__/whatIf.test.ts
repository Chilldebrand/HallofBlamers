import { describe, expect, it } from "vitest";
import {
  HEAD_TO_HEAD_WEEK_RULE,
  PRE_OPTIMAL_LINEUP_DATA_REASON,
  bestWorstSchedule,
  optimalLineupSeason,
  scheduleSwap,
  type WhatIfWeekInput,
} from "../whatIf";

// ---------------------------------------------------------------------------
// Fixture: 4 franchises, 3 weeks. A and B play each other in week 3 (the H2H
// week). Weeks 1-2 pair A/B against C/D so swapping actually rearranges
// something. Week 2 is engineered so A's swapped opponent (C) ties A's own
// score — covers the tie branch through the swap path.
//
//   wk1: A vs C (100-95, A wins) | B vs D (90-85, B wins)
//   wk2: A vs D (110-108, A wins) | B vs C (105-110, B loses)   <- C's 110 == A's wk2 score
//   wk3: A vs B (95-100, A loses) — the H2H week
// ---------------------------------------------------------------------------

const FRANCHISE_A = 1;
const FRANCHISE_B = 2;
const FRANCHISE_C = 3;
const FRANCHISE_D = 4;

const WEEKS_A: WhatIfWeekInput[] = [
  { week: 1, ownScore: 100, opponentFranchiseId: FRANCHISE_C, opponentScore: 95 },
  { week: 2, ownScore: 110, opponentFranchiseId: FRANCHISE_D, opponentScore: 108 },
  { week: 3, ownScore: 95, opponentFranchiseId: FRANCHISE_B, opponentScore: 100 },
];

const WEEKS_B: WhatIfWeekInput[] = [
  { week: 1, ownScore: 90, opponentFranchiseId: FRANCHISE_D, opponentScore: 85 },
  { week: 2, ownScore: 105, opponentFranchiseId: FRANCHISE_C, opponentScore: 110 },
  { week: 3, ownScore: 100, opponentFranchiseId: FRANCHISE_A, opponentScore: 95 },
];

const WEEKS_C: WhatIfWeekInput[] = [
  { week: 1, ownScore: 95, opponentFranchiseId: FRANCHISE_A, opponentScore: 100 },
  { week: 2, ownScore: 110, opponentFranchiseId: FRANCHISE_B, opponentScore: 105 },
  { week: 3, ownScore: 75, opponentFranchiseId: FRANCHISE_D, opponentScore: 70 },
];

const WEEKS_D: WhatIfWeekInput[] = [
  { week: 1, ownScore: 85, opponentFranchiseId: FRANCHISE_B, opponentScore: 90 },
  { week: 2, ownScore: 108, opponentFranchiseId: FRANCHISE_A, opponentScore: 110 },
  { week: 3, ownScore: 70, opponentFranchiseId: FRANCHISE_C, opponentScore: 75 },
];

describe("scheduleSwap", () => {
  it("A adopts B's weekly opponents (and vice versa) using real scores, unchanged own scores", () => {
    const result = scheduleSwap(2024, FRANCHISE_A, WEEKS_A, FRANCHISE_B, WEEKS_B);

    // A's own scores never change; A now faces D (wk1, B's real wk1 opponent) and C (wk2, B's
    // real wk2 opponent) instead of its real C/D order.
    expect(result.franchiseA.record.weeks[0]).toEqual({
      week: 1,
      ownScore: 100,
      opponentFranchiseId: FRANCHISE_D,
      opponentScore: 85,
      result: "W",
    });
    expect(result.franchiseA.record.weeks[1]).toEqual({
      week: 2,
      ownScore: 110,
      opponentFranchiseId: FRANCHISE_C,
      opponentScore: 110,
      result: "T", // covers the tie branch
    });
  });

  it("carries each franchise's real (regular-season) record alongside the swapped one, for an apples-to-apples 'vs. actual' verdict", () => {
    const result = scheduleSwap(2024, FRANCHISE_A, WEEKS_A, FRANCHISE_B, WEEKS_B);
    // Real A: wk1 W (100-95), wk2 W (110-108), wk3 L (95-100) => 2-1-0.
    expect(result.franchiseA.actual.wins).toBe(2);
    expect(result.franchiseA.actual.losses).toBe(1);
    expect(result.franchiseA.actual.ties).toBe(0);
    expect(result.franchiseA.actual.pointsFor).toBe(100 + 110 + 95);
    expect(result.franchiseA.actual.pointsAgainst).toBe(95 + 108 + 100);
    expect(result.franchiseA.actual.weeks.map((w) => w.opponentFranchiseId)).toEqual([FRANCHISE_C, FRANCHISE_D, FRANCHISE_B]);
  });

  it("discloses the head-to-head week rule on every result", () => {
    const result = scheduleSwap(2024, FRANCHISE_A, WEEKS_A, FRANCHISE_B, WEEKS_B);
    expect(result.headToHeadRule).toBe(HEAD_TO_HEAD_WEEK_RULE);
  });

  it("H2H WEEK RULE: the week A and B actually played each other keeps the real result for both, unswapped", () => {
    const result = scheduleSwap(2024, FRANCHISE_A, WEEKS_A, FRANCHISE_B, WEEKS_B);

    expect(result.franchiseA.record.weeks[2]).toEqual({
      week: 3,
      ownScore: 95,
      opponentFranchiseId: FRANCHISE_B,
      opponentScore: 100,
      result: "L", // A really lost to B in week 3
    });
    expect(result.franchiseB.record.weeks[2]).toEqual({
      week: 3,
      ownScore: 100,
      opponentFranchiseId: FRANCHISE_A,
      opponentScore: 95,
      result: "W", // B really beat A in week 3
    });
  });

  it("is symmetric under argument order: swap(A,B).franchiseA === swap(B,A).franchiseB", () => {
    const ab = scheduleSwap(2024, FRANCHISE_A, WEEKS_A, FRANCHISE_B, WEEKS_B);
    const ba = scheduleSwap(2024, FRANCHISE_B, WEEKS_B, FRANCHISE_A, WEEKS_A);

    expect(ab.franchiseA).toEqual(ba.franchiseB);
    expect(ab.franchiseB).toEqual(ba.franchiseA);
  });

  it("SWAP SYMMETRY: swapping A and B twice is the identity — reapplying scheduleSwap to the swapped weeks recovers the real records", () => {
    const swapped = scheduleSwap(2024, FRANCHISE_A, WEEKS_A, FRANCHISE_B, WEEKS_B);

    // Feed the post-swap weekly breakdown back in as fresh input and swap again.
    const reSwappedInputA: WhatIfWeekInput[] = swapped.franchiseA.record.weeks.map((w) => ({
      week: w.week,
      ownScore: w.ownScore,
      opponentFranchiseId: w.opponentFranchiseId,
      opponentScore: w.opponentScore,
    }));
    const reSwappedInputB: WhatIfWeekInput[] = swapped.franchiseB.record.weeks.map((w) => ({
      week: w.week,
      ownScore: w.ownScore,
      opponentFranchiseId: w.opponentFranchiseId,
      opponentScore: w.opponentScore,
    }));

    const doubleSwapped = scheduleSwap(2024, FRANCHISE_A, reSwappedInputA, FRANCHISE_B, reSwappedInputB);

    // The real (never-swapped) records, computed via the same engine (self-schedule = no-op).
    const real = scheduleSwap(2024, FRANCHISE_A, WEEKS_A, FRANCHISE_A, WEEKS_A);
    const realB = scheduleSwap(2024, FRANCHISE_B, WEEKS_B, FRANCHISE_B, WEEKS_B);

    expect(doubleSwapped.franchiseA.record).toEqual(real.franchiseA.record);
    expect(doubleSwapped.franchiseB.record).toEqual(realB.franchiseA.record);
  });

  it("a bye inherited from the schedule source excludes that week from the record", () => {
    const weeksWithBye: WhatIfWeekInput[] = [{ week: 1, ownScore: 50, opponentFranchiseId: null, opponentScore: null }];
    const otherWeeks: WhatIfWeekInput[] = [{ week: 1, ownScore: 77, opponentFranchiseId: 9, opponentScore: 66 }];

    const result = scheduleSwap(2024, FRANCHISE_A, otherWeeks, FRANCHISE_B, weeksWithBye);

    // A adopts B's bye — A's week 1 has no opponent under the swap, excluded from the record.
    expect(result.franchiseA.record.weeks[0]).toEqual({ week: 1, ownScore: 77, opponentFranchiseId: null, opponentScore: null, result: null });
    expect(result.franchiseA.record.wins + result.franchiseA.record.losses + result.franchiseA.record.ties).toBe(0);
    expect(result.franchiseA.record.pointsFor).toBe(0);
  });
});

describe("bestWorstSchedule", () => {
  it("replays the target under every OTHER franchise's schedule and ranks best/worst by win% then wins then points-for", () => {
    const result = bestWorstSchedule(2024, FRANCHISE_A, WEEKS_A, [
      { franchiseId: FRANCHISE_B, weeks: WEEKS_B },
      { franchiseId: FRANCHISE_C, weeks: WEEKS_C },
      { franchiseId: FRANCHISE_D, weeks: WEEKS_D },
    ]);

    expect(result.schedules).toHaveLength(3);
    // Every OTHER franchise appears exactly once (no self-entry), order aside.
    expect(new Set(result.schedules.map((s) => s.scheduleSourceFranchiseId))).toEqual(new Set([FRANCHISE_B, FRANCHISE_C, FRANCHISE_D]));

    expect(result.best).not.toBeNull();
    expect(result.worst).not.toBeNull();
    // best must never rank worse than worst under the same comparator.
    const bestGames = result.best!.record.wins + result.best!.record.losses + result.best!.record.ties;
    const worstGames = result.worst!.record.wins + result.worst!.record.losses + result.worst!.record.ties;
    const bestPct = bestGames > 0 ? (result.best!.record.wins + 0.5 * result.best!.record.ties) / bestGames : 0;
    const worstPct = worstGames > 0 ? (result.worst!.record.wins + 0.5 * result.worst!.record.ties) / worstGames : 0;
    expect(bestPct).toBeGreaterThanOrEqual(worstPct);
  });

  it("the 'actual' baseline (self-schedule) reproduces the franchise's real record", () => {
    const result = bestWorstSchedule(2024, FRANCHISE_A, WEEKS_A, [{ franchiseId: FRANCHISE_B, weeks: WEEKS_B }]);
    // Real A record from WEEKS_A: wk1 W (100-95), wk2 W (110-108), wk3 L (95-100) => 2-1-0.
    expect(result.actual.wins).toBe(2);
    expect(result.actual.losses).toBe(1);
    expect(result.actual.ties).toBe(0);
    expect(result.actual.pointsFor).toBe(100 + 110 + 95);
    expect(result.actual.pointsAgainst).toBe(95 + 108 + 100);
    expect(result.actual.weeks.map((w) => w.result)).toEqual(["W", "W", "L"]);
  });

  it("no other franchises to compare against: best/worst are null, schedules is empty", () => {
    const result = bestWorstSchedule(2024, FRANCHISE_A, WEEKS_A, []);
    expect(result.schedules).toEqual([]);
    expect(result.best).toBeNull();
    expect(result.worst).toBeNull();
  });
});

describe("optimalLineupSeason", () => {
  it("computes a full season record from optimalScore vs the opponent's real actual score", () => {
    const result = optimalLineupSeason(2019, FRANCHISE_A, [
      { week: 1, optimalScore: 130, opponentFranchiseId: FRANCHISE_C, opponentScore: 95 },
      { week: 2, optimalScore: 100, opponentFranchiseId: FRANCHISE_D, opponentScore: 108 }, // optimal still loses
      { week: 3, optimalScore: 100, opponentFranchiseId: FRANCHISE_B, opponentScore: 100 }, // tie
    ]);

    expect(result.available).toBe(true);
    expect(result.unavailableReason).toBeNull();
    expect(result.record).not.toBeNull();
    expect(result.record!.wins).toBe(1);
    expect(result.record!.losses).toBe(1);
    expect(result.record!.ties).toBe(1);
    expect(result.record!.pointsFor).toBe(130 + 100 + 100);
  });

  it("HONEST NULL-EFFICIENCY HANDLING: a season with any decided week missing optimalScore (pre-2018) is refused wholesale, not partially computed", () => {
    const result = optimalLineupSeason(2016, FRANCHISE_A, [
      { week: 1, optimalScore: null, opponentFranchiseId: FRANCHISE_C, opponentScore: 95 },
      { week: 2, optimalScore: 140, opponentFranchiseId: FRANCHISE_D, opponentScore: 108 }, // has data, but season is still refused
    ]);

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe(PRE_OPTIMAL_LINEUP_DATA_REASON);
    expect(result.record).toBeNull();
  });

  it("a bye week (null optimalScore is fine there) neither blocks availability nor appears in the record", () => {
    const result = optimalLineupSeason(2019, FRANCHISE_A, [
      { week: 1, optimalScore: 130, opponentFranchiseId: FRANCHISE_C, opponentScore: 95 },
      { week: 2, optimalScore: null, opponentFranchiseId: null, opponentScore: null }, // bye — no roster-slot concern
    ]);

    expect(result.available).toBe(true);
    expect(result.record!.weeks).toHaveLength(1);
    expect(result.record!.wins).toBe(1);
  });
});
