/**
 * Backtest evaluation math for `src/engines/winProbability.ts` — Brier score and calibration
 * buckets over a set of (predicted probability, actual outcome) pairs. Pure per AGENTS.md: no DB,
 * no IO.
 *
 * The DB-facing side that assembles real historical matchups into `BacktestOutcome[]` — and the
 * full honesty note on why only the PRE-GAME model can ever be backtested against real data —
 * lives in `src/server/stats/backtest-cli.ts` (`npm run winprob:backtest`). See that file and
 * `winProbability.ts`'s own module docstring before reading anything into these numbers.
 */

export interface BacktestOutcome {
  predictedHomeWinProbability: number;
  /** 1 = home won, 0 = away won, 0.5 = tie. */
  actualHomeResult: 0 | 0.5 | 1;
}

/**
 * Mean squared error between predicted probability and actual outcome — lower is better, 0 is
 * perfect. An always-0.5 coin-flip baseline scores exactly 0.25 against any 50/50 real win/loss
 * split (worse than 0.25 is possible against a set that ISN'T 50/50 — home teams winning more or
 * less often than half the time would still surprise a naive coin flip).
 *
 * `NaN` for an empty input — there is nothing to score, never fabricated as 0 ("perfect").
 */
export function computeBrierScore(outcomes: BacktestOutcome[]): number {
  if (outcomes.length === 0) return NaN;
  const sumSquaredError = outcomes.reduce((sum, o) => sum + (o.predictedHomeWinProbability - o.actualHomeResult) ** 2, 0);
  return sumSquaredError / outcomes.length;
}

export interface CalibrationBucket {
  /** e.g. "40-50%". Half-open [low, high) except the LAST bucket, which also accepts a predicted
   * probability of exactly 1 (see `computeCalibrationBuckets`'s clamp). */
  label: string;
  low: number;
  high: number;
  n: number;
  /** `NaN` when `n === 0` — never fabricated as 0, which would misleadingly read as "predicted
   * exactly 0% in this bucket." */
  meanPredicted: number;
  /** `NaN` when `n === 0`, same reasoning as `meanPredicted`. */
  actualWinRate: number;
}

/**
 * Buckets `outcomes` by predicted probability into `bucketWidth`-wide bins (default 10 buckets of
 * width 0.1, i.e. 0-10%, 10-20%, ..., 90-100%) and reports, per bucket: how many games landed
 * there, the average PREDICTED probability, and the average ACTUAL outcome (win rate). A
 * well-calibrated model has `meanPredicted` and `actualWinRate` close together in every bucket
 * that has enough games in it to be meaningful — the caller decides what "enough" means (small-n
 * buckets are still returned, honestly, rather than silently dropped or smoothed).
 *
 * Every bucket in [0, 1) is always present in the output, even with `n: 0` — a gap in the
 * predicted-probability distribution (e.g. this model rarely predicts a 90%+ home favorite) is
 * itself something the caller should be able to see, not something that quietly disappears from
 * the table.
 */
export function computeCalibrationBuckets(outcomes: BacktestOutcome[], bucketWidth = 0.1): CalibrationBucket[] {
  const bucketCount = Math.round(1 / bucketWidth);
  const buckets: { predicted: number[]; actual: number[] }[] = Array.from({ length: bucketCount }, () => ({ predicted: [], actual: [] }));

  for (const o of outcomes) {
    const clamped = Math.min(Math.max(o.predictedHomeWinProbability, 0), 1);
    let idx = Math.floor(clamped / bucketWidth);
    if (idx >= bucketCount) idx = bucketCount - 1; // predicted === 1 (the top edge) lands in the last bucket, not off the end
    buckets[idx]!.predicted.push(o.predictedHomeWinProbability);
    buckets[idx]!.actual.push(o.actualHomeResult);
  }

  // Rounded to 9 decimal places — floating-point multiplication (e.g. 6 * 0.1) can otherwise land
  // a hair off the clean boundary (0.6000000000000001), which is harmless for bucketing itself
  // (idx is computed by floor/division above, not from these values) but would leak an ugly
  // near-boundary value into the OUTPUT `low`/`high` fields a caller might display directly.
  const round = (x: number) => Math.round(x * 1e9) / 1e9;

  return buckets.map((b, i) => {
    const low = round(i * bucketWidth);
    const high = round((i + 1) * bucketWidth);
    const label = `${Math.round(low * 100)}-${Math.round(high * 100)}%`;
    const n = b.predicted.length;
    const meanPredicted = n > 0 ? b.predicted.reduce((a, x) => a + x, 0) / n : NaN;
    const actualWinRate = n > 0 ? b.actual.reduce((a, x) => a + x, 0) / n : NaN;
    return { label, low, high, n, meanPredicted, actualWinRate };
  });
}
