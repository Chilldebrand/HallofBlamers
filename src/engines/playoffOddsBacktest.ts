/**
 * Backtest evaluation math for `./playoffOdds` — the HONESTY CORE this task's brief requires before
 * anything ships: the Monte Carlo model's predicted P(playoffs) must beat a naive
 * "current-standings-hold-forever" baseline, or nothing miscalibrated ships to the league (build
 * stage + UI skipped, engine + this report shipped `DONE_WITH_CONCERNS`).
 *
 * Pure per AGENTS.md: no DB, no IO. Deliberately thin — it reuses `./winProbabilityBacktest`'s
 * `computeBrierScore`/`computeCalibrationBuckets` EXACTLY (Task 36's precedent), rather than
 * reimplementing the same Brier-score/calibration-bucket math a second time under new names. Those
 * two functions are generic over "a predicted probability in [0,1] vs. a 0/0.5/1 actual outcome" —
 * nothing about their math is specific to win probability — so this module just supplies the
 * playoff-odds-flavored field names (`predictedPlayoffProbability`/`actualMadePlayoffs`) and maps
 * them onto that existing shape at the call boundary. The DB-facing side that assembles real
 * historical (season, week-boundary, franchise) samples into these outcomes — including the
 * leave-one-season-out calibration refit — lives in
 * `src/server/stats/playoffOddsBacktest-cli.ts` (`npm run playoffodds:backtest`).
 */
import { computeBrierScore, computeCalibrationBuckets, type BacktestOutcome, type CalibrationBucket } from "./winProbabilityBacktest";

export interface PlayoffOddsBacktestOutcome {
  predictedPlayoffProbability: number;
  /** 1 = this franchise actually made the playoffs that season, 0 = it didn't. Never a fraction —
   * real playoff eligibility is always a hard yes/no, unlike a game outcome's occasional tie. */
  actualMadePlayoffs: 0 | 1;
}

function toBacktestOutcome(o: PlayoffOddsBacktestOutcome): BacktestOutcome {
  return { predictedHomeWinProbability: o.predictedPlayoffProbability, actualHomeResult: o.actualMadePlayoffs };
}

/** Brier score of a set of P(playoffs) predictions against real outcomes — see
 * `computeBrierScore`'s own docstring for the scale (0 = perfect, 0.25 = an always-50% baseline's
 * score against a 50/50-split ground truth). `NaN` for an empty input, never fabricated as 0. */
export function computePlayoffOddsBrierScore(outcomes: readonly PlayoffOddsBacktestOutcome[]): number {
  return computeBrierScore(outcomes.map(toBacktestOutcome));
}

/** Calibration buckets (predicted vs. actual playoff rate) for a set of P(playoffs) predictions —
 * see `computeCalibrationBuckets`'s own docstring for the bucketing rule. */
export function computePlayoffOddsCalibrationBuckets(outcomes: readonly PlayoffOddsBacktestOutcome[], bucketWidth = 0.1): CalibrationBucket[] {
  return computeCalibrationBuckets(outcomes.map(toBacktestOutcome), bucketWidth);
}

export interface PlayoffOddsGateResult {
  mcBrierScore: number;
  naiveBrierScore: number;
  /** THE GATE (this task's brief): the Monte Carlo model's Brier score must be strictly lower than
   * the naive "current-standings-hold-forever" baseline's, or this feature does not ship a build
   * stage/UI — see `src/server/stats/playoffOddsBacktest-cli.ts`'s printed report and this task's
   * report for the real numbers. */
  gatePass: boolean;
}

/**
 * The gate check itself: compares the Monte Carlo model's Brier score against the naive baseline's
 * over the SAME set of (season, week-boundary, franchise) evaluation points — `mcOutcomes[i]` and
 * `naiveOutcomes[i]` must be the same sample in the same order (the CLI's assembly guarantees this;
 * not re-validated here since this module has no way to identify "the same sample" without a DB
 * join key, which would break its pure/no-IO contract).
 */
export function evaluatePlayoffOddsGate(
  mcOutcomes: readonly PlayoffOddsBacktestOutcome[],
  naiveOutcomes: readonly PlayoffOddsBacktestOutcome[],
): PlayoffOddsGateResult {
  const mcBrierScore = computePlayoffOddsBrierScore(mcOutcomes);
  const naiveBrierScore = computePlayoffOddsBrierScore(naiveOutcomes);
  return { mcBrierScore, naiveBrierScore, gatePass: mcBrierScore < naiveBrierScore };
}
