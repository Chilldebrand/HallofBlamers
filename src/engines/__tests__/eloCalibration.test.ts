import { describe, expect, it } from "vitest";
import {
  calibratedEloProbability,
  fitEloCalibration,
  IDENTITY_ELO_CALIBRATION,
  type EloCalibration,
  type EloCalibrationSample,
} from "../eloCalibration";
import { eloExpected } from "../replay";
import { computeBrierScore, type BacktestOutcome } from "../winProbabilityBacktest";

describe("IDENTITY_ELO_CALIBRATION", () => {
  it("reproduces eloExpected's raw formula exactly across a wide range of elo pairs", () => {
    const pairs: [number, number][] = [
      [1500, 1500],
      [1700, 1500],
      [1500, 1700],
      [1200, 1800],
      [1900, 1100],
      [1501, 1499],
    ];
    for (const [a, b] of pairs) {
      expect(calibratedEloProbability(a - b, IDENTITY_ELO_CALIBRATION)).toBeCloseTo(eloExpected(a, b), 12);
    }
  });
});

describe("calibratedEloProbability", () => {
  it("is exactly 0.5 at eloDiff=0 when intercept is 0", () => {
    expect(calibratedEloProbability(0, { intercept: 0, slope: 0.01 })).toBeCloseTo(0.5, 12);
  });

  it("is monotonically increasing in eloDiff for a positive slope", () => {
    const calibration: EloCalibration = { intercept: 0.2, slope: 0.003 };
    let prev = -Infinity;
    for (let diff = -800; diff <= 800; diff += 25) {
      const p = calibratedEloProbability(diff, calibration);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it("stays finite and in [0,1] at extreme eloDiff/slope combinations (no NaN/Infinity leak)", () => {
    const extreme: EloCalibration = { intercept: 0, slope: 5 };
    for (const diff of [-1e6, -1000, 1000, 1e6]) {
      const p = calibratedEloProbability(diff, extreme);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe("fitEloCalibration — degenerate inputs", () => {
  it("returns IDENTITY_ELO_CALIBRATION verbatim for an empty sample set", () => {
    expect(fitEloCalibration([])).toBe(IDENTITY_ELO_CALIBRATION);
  });

  it("a single sample (unidentifiable slope) does not throw and returns finite numbers", () => {
    const fitted = fitEloCalibration([{ eloDiff: 200, result: 1 }]);
    expect(Number.isFinite(fitted.intercept)).toBe(true);
    expect(Number.isFinite(fitted.slope)).toBe(true);
  });

  it("every sample sharing the same eloDiff (singular Hessian) does not throw and returns finite numbers", () => {
    const samples: EloCalibrationSample[] = [
      { eloDiff: 150, result: 1 },
      { eloDiff: 150, result: 0 },
      { eloDiff: 150, result: 1 },
    ];
    const fitted = fitEloCalibration(samples);
    expect(Number.isFinite(fitted.intercept)).toBe(true);
    expect(Number.isFinite(fitted.slope)).toBe(true);
  });

  it("a perfectly-separable discrete dataset (quasi-complete separation) does not throw/NaN and recovers the correct SIGN of the relationship", () => {
    const samples: EloCalibrationSample[] = [
      { eloDiff: -500, result: 0 },
      { eloDiff: -300, result: 0 },
      { eloDiff: -100, result: 0 },
      { eloDiff: 100, result: 1 },
      { eloDiff: 300, result: 1 },
      { eloDiff: 500, result: 1 },
    ];
    const fitted = fitEloCalibration(samples);
    expect(Number.isFinite(fitted.intercept)).toBe(true);
    expect(Number.isFinite(fitted.slope)).toBe(true);
    expect(fitted.slope).toBeGreaterThan(0); // higher eloDiff -> more likely to win, recovered correctly
  });

  it("is deterministic: the exact same samples array fits to the exact same values every call", () => {
    const samples: EloCalibrationSample[] = [
      { eloDiff: -300, result: 0 },
      { eloDiff: -100, result: 1 },
      { eloDiff: 100, result: 0 },
      { eloDiff: 300, result: 1 },
      { eloDiff: 50, result: 1 },
    ];
    const first = fitEloCalibration(samples);
    const second = fitEloCalibration(samples);
    expect(second).toEqual(first);
  });

  it("sample ORDER doesn't change the fitted result beyond floating-point summation noise", () => {
    const samples: EloCalibrationSample[] = [
      { eloDiff: -300, result: 0 },
      { eloDiff: -100, result: 1 },
      { eloDiff: 100, result: 0 },
      { eloDiff: 300, result: 1 },
      { eloDiff: 50, result: 1 },
    ];
    const forward = fitEloCalibration(samples);
    const reversed = fitEloCalibration([...samples].reverse());
    expect(reversed.intercept).toBeCloseTo(forward.intercept, 9);
    expect(reversed.slope).toBeCloseTo(forward.slope, 9);
  });
});

describe("fitEloCalibration — recovers known parameters", () => {
  /** A large discrete dataset built by rounding a TRUE model's probability at each diff into an
   * exact win/loss count — the standard way to test a logistic fitter's numerical correctness
   * without smuggling continuous "soft" labels past `EloCalibrationSample`'s real 0/0.5/1 contract
   * (a real game's outcome is never a fraction). Enough replicas per diff that rounding noise
   * washes out well below the assertions' tolerance. */
  function replicatedSamples(trueCalibration: EloCalibration, diffs: readonly number[], replicasPerDiff: number): EloCalibrationSample[] {
    const samples: EloCalibrationSample[] = [];
    for (const diff of diffs) {
      const p = calibratedEloProbability(diff, trueCalibration);
      const wins = Math.round(p * replicasPerDiff);
      for (let i = 0; i < wins; i++) samples.push({ eloDiff: diff, result: 1 });
      for (let i = 0; i < replicasPerDiff - wins; i++) samples.push({ eloDiff: diff, result: 0 });
    }
    return samples;
  }

  it("recovers a non-identity true calibration to within a tight tolerance", () => {
    const trueCalibration: EloCalibration = { intercept: 0.15, slope: 0.004 };
    const diffs = [-600, -400, -200, -100, 0, 100, 200, 400, 600];
    const samples = replicatedSamples(trueCalibration, diffs, 1000);

    const fitted = fitEloCalibration(samples);
    expect(fitted.intercept).toBeCloseTo(trueCalibration.intercept, 2);
    expect(fitted.slope).toBeCloseTo(trueCalibration.slope, 4);
  });

  it("recovers IDENTITY_ELO_CALIBRATION's own parameters when the data is generated by the raw Elo formula itself", () => {
    const diffs = [-700, -500, -300, -100, 0, 100, 300, 500, 700];
    const samples = replicatedSamples(IDENTITY_ELO_CALIBRATION, diffs, 1000);

    const fitted = fitEloCalibration(samples);
    expect(fitted.intercept).toBeCloseTo(IDENTITY_ELO_CALIBRATION.intercept, 2);
    expect(fitted.slope).toBeCloseTo(IDENTITY_ELO_CALIBRATION.slope, 4);
  });
});

describe("fitEloCalibration — beats the raw formula on an overconfident-Elo-shaped dataset", () => {
  it("a fitted calibration scores a strictly lower Brier than raw Elo on data where actual win rate is far flatter than raw Elo assumes", () => {
    // Mirrors the real backtest's own finding in miniature: outcomes barely move with eloDiff (win
    // rate stays in a 25%-75% band across the whole range) even though raw Elo's 400-point formula
    // would predict something close to 5%-95% at these same gaps — the exact overconfidence shape
    // that made raw Elo score WORSE than a coin flip on this league's real 937-game history.
    const buckets: { diff: number; wins: number; losses: number }[] = [
      { diff: -500, wins: 1, losses: 3 },
      { diff: -300, wins: 1, losses: 2 },
      { diff: -100, wins: 2, losses: 2 },
      { diff: 100, wins: 2, losses: 2 },
      { diff: 300, wins: 2, losses: 1 },
      { diff: 500, wins: 3, losses: 1 },
    ];
    const samples: EloCalibrationSample[] = [];
    for (const b of buckets) {
      for (let i = 0; i < b.wins; i++) samples.push({ eloDiff: b.diff, result: 1 });
      for (let i = 0; i < b.losses; i++) samples.push({ eloDiff: b.diff, result: 0 });
    }

    const fitted = fitEloCalibration(samples);

    const toOutcomes = (calibration: EloCalibration): BacktestOutcome[] =>
      samples.map((s) => ({ predictedHomeWinProbability: calibratedEloProbability(s.eloDiff, calibration), actualHomeResult: s.result }));

    const fittedBrier = computeBrierScore(toOutcomes(fitted));
    const rawBrier = computeBrierScore(toOutcomes(IDENTITY_ELO_CALIBRATION));
    const coinFlipBrier = computeBrierScore(samples.map((s) => ({ predictedHomeWinProbability: 0.5, actualHomeResult: s.result })));

    expect(fittedBrier).toBeLessThan(rawBrier);
    expect(fittedBrier).toBeLessThan(coinFlipBrier);
  });
});
