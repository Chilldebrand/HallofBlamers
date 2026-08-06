import { describe, expect, it } from "vitest";
import {
  computePlayoffOddsBrierScore,
  computePlayoffOddsCalibrationBuckets,
  evaluatePlayoffOddsGate,
  type PlayoffOddsBacktestOutcome,
} from "../playoffOddsBacktest";

describe("computePlayoffOddsBrierScore", () => {
  it("scores 0 for perfect predictions", () => {
    const outcomes: PlayoffOddsBacktestOutcome[] = [
      { predictedPlayoffProbability: 1, actualMadePlayoffs: 1 },
      { predictedPlayoffProbability: 0, actualMadePlayoffs: 0 },
    ];
    expect(computePlayoffOddsBrierScore(outcomes)).toBe(0);
  });

  it("scores 0.25 for an always-50% baseline against a 50/50 split", () => {
    const outcomes: PlayoffOddsBacktestOutcome[] = [
      { predictedPlayoffProbability: 0.5, actualMadePlayoffs: 1 },
      { predictedPlayoffProbability: 0.5, actualMadePlayoffs: 0 },
    ];
    expect(computePlayoffOddsBrierScore(outcomes)).toBeCloseTo(0.25, 9);
  });

  it("NaN for an empty input, never fabricated as 0", () => {
    expect(computePlayoffOddsBrierScore([])).toBeNaN();
  });
});

describe("computePlayoffOddsCalibrationBuckets", () => {
  it("buckets predictions by their predicted probability and reports actual playoff rate per bucket", () => {
    const outcomes: PlayoffOddsBacktestOutcome[] = [
      { predictedPlayoffProbability: 0.85, actualMadePlayoffs: 1 },
      { predictedPlayoffProbability: 0.82, actualMadePlayoffs: 1 },
      { predictedPlayoffProbability: 0.15, actualMadePlayoffs: 0 },
    ];
    const buckets = computePlayoffOddsCalibrationBuckets(outcomes);
    const highBucket = buckets.find((b) => b.label === "80-90%")!;
    expect(highBucket.n).toBe(2);
    expect(highBucket.actualWinRate).toBeCloseTo(1, 9);
    const lowBucket = buckets.find((b) => b.label === "10-20%")!;
    expect(lowBucket.n).toBe(1);
    expect(lowBucket.actualWinRate).toBeCloseTo(0, 9);
  });
});

describe("evaluatePlayoffOddsGate", () => {
  it("passes when the MC model's Brier score is strictly lower than the naive baseline's", () => {
    const mc: PlayoffOddsBacktestOutcome[] = [
      { predictedPlayoffProbability: 0.9, actualMadePlayoffs: 1 },
      { predictedPlayoffProbability: 0.1, actualMadePlayoffs: 0 },
    ];
    const naive: PlayoffOddsBacktestOutcome[] = [
      { predictedPlayoffProbability: 1, actualMadePlayoffs: 1 }, // still "correct" here, but...
      { predictedPlayoffProbability: 1, actualMadePlayoffs: 0 }, // ...a hard-wrong miss costs the naive baseline dearly
    ];
    const gate = evaluatePlayoffOddsGate(mc, naive);
    expect(gate.gatePass).toBe(true);
    expect(gate.mcBrierScore).toBeLessThan(gate.naiveBrierScore);
  });

  it("fails when the naive baseline actually scores better", () => {
    const mc: PlayoffOddsBacktestOutcome[] = [{ predictedPlayoffProbability: 0.5, actualMadePlayoffs: 1 }];
    const naive: PlayoffOddsBacktestOutcome[] = [{ predictedPlayoffProbability: 1, actualMadePlayoffs: 1 }];
    const gate = evaluatePlayoffOddsGate(mc, naive);
    expect(gate.gatePass).toBe(false);
  });
});
