import type { AchievementsTeamWeekInput } from "../achievements";

/**
 * A single fully-settled week (season 2024, week 1) across 4 franchises, shaped to exercise
 * several achievement rules at once:
 *  - F1: efficiency exactly 1.0 (perfect_lineup), scores the week's top (weekly_high, tied
 *    with F4), wins by a wide margin (not narrow_escape).
 *  - F2: loses by 40, efficiency null (pre-2018 shape — proves perfect_lineup/bench_disaster
 *    never fire without optimal data, even on a big loss).
 *  - F3: loses to F4 by 0.5 (heartbreaker — under the 2.0 threshold), efficiency null.
 *  - F4: ties F1 for weekly_high; wins by 0.5 (narrow_escape, under the 2.0 threshold).
 */
export const BASIC_WEEK_TEAM_WEEKS: AchievementsTeamWeekInput[] = [
  {
    franchiseId: 1,
    season: 2024,
    week: 1,
    score: 120,
    result: "W",
    margin: 40,
    opponentFranchiseId: 2,
    optimalScore: 120,
    efficiency: 1,
  },
  {
    franchiseId: 2,
    season: 2024,
    week: 1,
    score: 80,
    result: "L",
    margin: -40,
    opponentFranchiseId: 1,
    optimalScore: null,
    efficiency: null,
  },
  {
    franchiseId: 3,
    season: 2024,
    week: 1,
    score: 99.5,
    result: "L",
    margin: -0.5,
    opponentFranchiseId: 4,
    optimalScore: null,
    efficiency: null,
  },
  {
    franchiseId: 4,
    season: 2024,
    week: 1,
    score: 120, // ties F1 for weekly_high
    result: "W",
    margin: 0.5,
    opponentFranchiseId: 3,
    optimalScore: 125,
    efficiency: 120 / 125,
  },
];

/**
 * A `bench_disaster` case: F5 loses 90-95 but its optimal lineup (110) would have beaten F6's
 * actual score (95) — a real "points left on bench flipped the result" scenario. Paired with a
 * non-disaster loss (F6's opponent is fine, no bench points relevant to it).
 */
export const BENCH_DISASTER_TEAM_WEEKS: AchievementsTeamWeekInput[] = [
  {
    franchiseId: 5,
    season: 2024,
    week: 2,
    score: 90,
    result: "L",
    margin: -5,
    opponentFranchiseId: 6,
    optimalScore: 110,
    efficiency: 90 / 110,
  },
  {
    franchiseId: 6,
    season: 2024,
    week: 2,
    score: 95,
    result: "W",
    margin: 5,
    opponentFranchiseId: 5,
    optimalScore: 100,
    efficiency: 0.95,
  },
];

/** `finalWeeks` keys matching BASIC_WEEK_TEAM_WEEKS / BENCH_DISASTER_TEAM_WEEKS. */
export const BASIC_WEEK_FINAL_WEEKS = new Set(["2024:1", "2024:2"]);
