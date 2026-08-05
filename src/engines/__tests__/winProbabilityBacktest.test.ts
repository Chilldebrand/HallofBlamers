import { describe, expect, it } from "vitest";
import { computeBrierScore, computeCalibrationBuckets, type BacktestOutcome } from "../winProbabilityBacktest";

describe("computeBrierScore", () => {
  it("is NaN for an empty input — never fabricated as 0", () => {
    expect(Number.isNaN(computeBrierScore([]))).toBe(true);
  });

  it("is 0 for a set of perfect predictions", () => {
    const outcomes: BacktestOutcome[] = [
      { predictedHomeWinProbability: 1, actualHomeResult: 1 },
      { predictedHomeWinProbability: 0, actualHomeResult: 0 },
      { predictedHomeWinProbability: 0.5, actualHomeResult: 0.5 },
    ];
    expect(computeBrierScore(outcomes)).toBe(0);
  });

  it("is 1 for a set of maximally wrong predictions (predicted 1, actual 0 and vice versa)", () => {
    const outcomes: BacktestOutcome[] = [
      { predictedHomeWinProbability: 1, actualHomeResult: 0 },
      { predictedHomeWinProbability: 0, actualHomeResult: 1 },
    ];
    expect(computeBrierScore(outcomes)).toBe(1);
  });

  it("an always-0.5 coin flip scores exactly 0.25 against any actual 0/1 outcome", () => {
    const outcomes: BacktestOutcome[] = [
      { predictedHomeWinProbability: 0.5, actualHomeResult: 1 },
      { predictedHomeWinProbability: 0.5, actualHomeResult: 0 },
      { predictedHomeWinProbability: 0.5, actualHomeResult: 1 },
      { predictedHomeWinProbability: 0.5, actualHomeResult: 0 },
    ];
    expect(computeBrierScore(outcomes)).toBeCloseTo(0.25, 10);
  });

  it("matches a hand-computed mean squared error for a mixed set", () => {
    const outcomes: BacktestOutcome[] = [
      { predictedHomeWinProbability: 0.7, actualHomeResult: 1 }, // (0.7-1)^2 = 0.09
      { predictedHomeWinProbability: 0.3, actualHomeResult: 0 }, // (0.3-0)^2 = 0.09
      { predictedHomeWinProbability: 0.6, actualHomeResult: 0 }, // (0.6-0)^2 = 0.36
    ];
    // (0.09 + 0.09 + 0.36) / 3 = 0.18
    expect(computeBrierScore(outcomes)).toBeCloseTo(0.18, 10);
  });
});

describe("computeCalibrationBuckets", () => {
  it("returns all 10 buckets (default width 0.1) even when several are empty", () => {
    const buckets = computeCalibrationBuckets([{ predictedHomeWinProbability: 0.55, actualHomeResult: 1 }]);
    expect(buckets.length).toBe(10);
    expect(buckets.filter((b) => b.n > 0).length).toBe(1);
    expect(buckets.every((b) => b.n === 0 || (b.low === 0.5 && b.high === 0.6))).toBe(true);
  });

  it("empty buckets report n=0 and NaN mean/actual — never fabricated as 0", () => {
    const buckets = computeCalibrationBuckets([{ predictedHomeWinProbability: 0.05, actualHomeResult: 0 }]);
    const emptyBucket = buckets.find((b) => b.label === "90-100%")!;
    expect(emptyBucket.n).toBe(0);
    expect(Number.isNaN(emptyBucket.meanPredicted)).toBe(true);
    expect(Number.isNaN(emptyBucket.actualWinRate)).toBe(true);
  });

  it("groups predictions into the correct bucket by value, and averages both predicted and actual correctly", () => {
    const outcomes: BacktestOutcome[] = [
      { predictedHomeWinProbability: 0.62, actualHomeResult: 1 },
      { predictedHomeWinProbability: 0.68, actualHomeResult: 0 },
      { predictedHomeWinProbability: 0.61, actualHomeResult: 1 },
    ];
    const buckets = computeCalibrationBuckets(outcomes);
    const bucket = buckets.find((b) => b.label === "60-70%")!;
    expect(bucket.n).toBe(3);
    expect(bucket.meanPredicted).toBeCloseTo((0.62 + 0.68 + 0.61) / 3, 10);
    expect(bucket.actualWinRate).toBeCloseTo(2 / 3, 10);
  });

  it("a predicted probability of exactly 1.0 lands in the last bucket (90-100%), not off the end", () => {
    const buckets = computeCalibrationBuckets([{ predictedHomeWinProbability: 1, actualHomeResult: 1 }]);
    const lastBucket = buckets[buckets.length - 1]!;
    expect(lastBucket.label).toBe("90-100%");
    expect(lastBucket.n).toBe(1);
  });

  it("a predicted probability of exactly 0.0 lands in the first bucket (0-10%)", () => {
    const buckets = computeCalibrationBuckets([{ predictedHomeWinProbability: 0, actualHomeResult: 0 }]);
    expect(buckets[0]!.label).toBe("0-10%");
    expect(buckets[0]!.n).toBe(1);
  });

  it("a bucket boundary value (exactly 0.5) lands in the bucket it opens (50-60%), not the one below", () => {
    const buckets = computeCalibrationBuckets([{ predictedHomeWinProbability: 0.5, actualHomeResult: 1 }]);
    const bucket = buckets.find((b) => b.n > 0)!;
    expect(bucket.label).toBe("50-60%");
  });

  it("supports a coarser bucket width (e.g. 0.2 -> 5 buckets)", () => {
    const buckets = computeCalibrationBuckets([{ predictedHomeWinProbability: 0.35, actualHomeResult: 1 }], 0.2);
    expect(buckets.length).toBe(5);
    expect(buckets.find((b) => b.n > 0)!.label).toBe("20-40%");
  });
});
