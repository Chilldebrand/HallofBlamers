import type { SlotScoringCalibration, WinProbabilityTeamState } from "../winProbability";

/**
 * A plausible calibration table shaped like real 2018-2025 `roster_slots` history (mean/variance
 * in fantasy points, not tuned to any specific real build's numbers — just realistic enough to
 * exercise the model's math). QB scores highest/tightest; D/ST and K are low-mean, low-variance;
 * FLEX/RB/WR sit in between. `ALL` is the pooled fallback the build stage guarantees.
 */
export const SAMPLE_CALIBRATION: SlotScoringCalibration = {
  QB: { mean: 18, variance: 36 },
  RB: { mean: 11, variance: 49 },
  WR: { mean: 10, variance: 42 },
  TE: { mean: 7, variance: 25 },
  FLEX: { mean: 10, variance: 45 },
  "D/ST": { mean: 6, variance: 16 },
  K: { mean: 8, variance: 9 },
  ALL: { mean: 10, variance: 40 },
};

/** A typical 9-starter lineup shape: 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, 1 D/ST, 1 K. */
export const FULL_LINEUP_REMAINING: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  "D/ST": 1,
  K: 1,
};

export const EVEN_ELO_HOME: WinProbabilityTeamState = {
  score: 0,
  eloPre: 1500,
  startersPlayed: 0,
  remainingBySlot: FULL_LINEUP_REMAINING,
};

export const EVEN_ELO_AWAY: WinProbabilityTeamState = {
  score: 0,
  eloPre: 1500,
  startersPlayed: 0,
  remainingBySlot: FULL_LINEUP_REMAINING,
};

/** Home is a big pre-game Elo favorite (200-point gap ~ eloExpected(1700,1500) ≈ 0.76). */
export const ELO_FAVORITE_HOME: WinProbabilityTeamState = {
  ...EVEN_ELO_HOME,
  eloPre: 1700,
};

export const ELO_UNDERDOG_AWAY: WinProbabilityTeamState = {
  ...EVEN_ELO_AWAY,
  eloPre: 1500,
};

/** Both sides fully resolved: nobody remaining, home leads by a real margin. */
export const HOME_LEADS_FINAL_HOME: WinProbabilityTeamState = {
  score: 120,
  eloPre: 1500,
  startersPlayed: 9,
  remainingBySlot: {},
};

export const AWAY_TRAILS_FINAL_AWAY: WinProbabilityTeamState = {
  score: 100,
  eloPre: 1500,
  startersPlayed: 9,
  remainingBySlot: {},
};

/** Both sides fully resolved, exact tie. */
export const HOME_TIED_FINAL_HOME: WinProbabilityTeamState = {
  score: 110,
  eloPre: 1500,
  startersPlayed: 9,
  remainingBySlot: {},
};

export const AWAY_TIED_FINAL_AWAY: WinProbabilityTeamState = {
  score: 110,
  eloPre: 1500,
  startersPlayed: 9,
  remainingBySlot: {},
};

/** Mid-week: home already up big with a couple of starters left; away has more left to play. */
export const MID_WEEK_HOME: WinProbabilityTeamState = {
  score: 80,
  eloPre: 1550,
  startersPlayed: 7,
  remainingBySlot: { FLEX: 1, K: 1 },
};

export const MID_WEEK_AWAY: WinProbabilityTeamState = {
  score: 60,
  eloPre: 1450,
  startersPlayed: 5,
  remainingBySlot: { RB: 1, WR: 1, "D/ST": 1, K: 1 },
};
