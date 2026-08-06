import { describe, expect, it } from "vitest";
import { IDENTITY_ELO_CALIBRATION, type EloCalibration } from "../eloCalibration";
import {
  mulberry32,
  rankFranchisesForSeeding,
  runPlayoffOddsSimulation,
  type PlayoffOddsInput,
  type PlayoffOddsMatchup,
  type PlayoffOddsStanding,
} from "../playoffOdds";

describe("mulberry32", () => {
  it("produces values in [0, 1)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic: the same seed always produces the exact same sequence", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    expect(seqB).toEqual(seqA);
  });

  it("different seeds produce different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqB).not.toEqual(seqA);
  });
});

describe("rankFranchisesForSeeding", () => {
  it("orders by win% desc", () => {
    const rows = [
      { franchiseId: 1, wins: 5, losses: 5, ties: 0, pointsFor: 100 },
      { franchiseId: 2, wins: 8, losses: 2, ties: 0, pointsFor: 90 },
      { franchiseId: 3, wins: 2, losses: 8, ties: 0, pointsFor: 200 },
    ];
    expect(rankFranchisesForSeeding(rows)).toEqual([2, 1, 3]);
  });

  it("falls back to points-for desc on a win% tie", () => {
    const rows = [
      { franchiseId: 1, wins: 5, losses: 5, ties: 0, pointsFor: 900 },
      { franchiseId: 2, wins: 5, losses: 5, ties: 0, pointsFor: 1100 },
    ];
    expect(rankFranchisesForSeeding(rows)).toEqual([2, 1]);
  });

  it("falls back to franchiseId asc as the final deterministic tiebreak", () => {
    const rows = [
      { franchiseId: 5, wins: 5, losses: 5, ties: 0, pointsFor: 1000 },
      { franchiseId: 2, wins: 5, losses: 5, ties: 0, pointsFor: 1000 },
    ];
    expect(rankFranchisesForSeeding(rows)).toEqual([2, 5]);
  });

  it("treats ties as half a win in the win% comparison", () => {
    const rows = [
      { franchiseId: 1, wins: 4, losses: 4, ties: 2, pointsFor: 0 }, // .500
      { franchiseId: 2, wins: 5, losses: 5, ties: 0, pointsFor: 0 }, // .500
      { franchiseId: 3, wins: 5, losses: 4, ties: 1, pointsFor: 0 }, // .55
    ];
    expect(rankFranchisesForSeeding(rows)[0]).toBe(3);
  });

  it("does not mutate its input array", () => {
    const rows = [
      { franchiseId: 2, wins: 1, losses: 0, ties: 0, pointsFor: 0 },
      { franchiseId: 1, wins: 0, losses: 1, ties: 0, pointsFor: 0 },
    ];
    const copy = rows.map((r) => ({ ...r }));
    rankFranchisesForSeeding(rows);
    expect(rows).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// runPlayoffOddsSimulation
// ---------------------------------------------------------------------------

const CALIBRATION: EloCalibration = { intercept: 0, slope: Math.log(10) / 400 }; // same shape as IDENTITY

function threeTeamFixture(): { standings: PlayoffOddsStanding[]; remaining: PlayoffOddsMatchup[]; elo: Map<number, number> } {
  const standings: PlayoffOddsStanding[] = [
    { franchiseId: 1, wins: 3, losses: 0, ties: 0, pointsFor: 300 },
    { franchiseId: 2, wins: 1, losses: 2, ties: 0, pointsFor: 250 },
    { franchiseId: 3, wins: 0, losses: 3, ties: 0, pointsFor: 200 },
  ];
  const remaining: PlayoffOddsMatchup[] = [
    { homeFranchiseId: 1, awayFranchiseId: 2 },
    { homeFranchiseId: 2, awayFranchiseId: 3 },
    { homeFranchiseId: 1, awayFranchiseId: 3 },
  ];
  const elo = new Map<number, number>([
    [1, 1700],
    [2, 1500],
    [3, 1300],
  ]);
  return { standings, remaining, elo };
}

describe("runPlayoffOddsSimulation — determinism", () => {
  it("the same (input, seed, runs) always produces the exact same result", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 2 } };
    const first = runPlayoffOddsSimulation(input, 777, 5000);
    const second = runPlayoffOddsSimulation(input, 777, 5000);
    expect(second).toEqual(first);
  });

  it("a different seed produces a different result (real randomness is actually being used)", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 2 } };
    const a = runPlayoffOddsSimulation(input, 1, 5000);
    const b = runPlayoffOddsSimulation(input, 2, 5000);
    expect(b).not.toEqual(a);
  });
});

describe("runPlayoffOddsSimulation — degenerate cases", () => {
  it("season over (no remaining games): probabilities are EXACTLY 0/1, matching the already-decided reality", () => {
    const standings: PlayoffOddsStanding[] = [
      { franchiseId: 1, wins: 10, losses: 0, ties: 0, pointsFor: 1000 }, // seed 1
      { franchiseId: 2, wins: 8, losses: 2, ties: 0, pointsFor: 900 }, // seed 2
      { franchiseId: 3, wins: 5, losses: 5, ties: 0, pointsFor: 800 }, // seed 3, misses a 2-team bracket
      { franchiseId: 4, wins: 2, losses: 8, ties: 0, pointsFor: 700 }, // seed 4
    ];
    const input: PlayoffOddsInput = {
      standings,
      remainingMatchups: [],
      eloByFranchise: new Map([[1, 1600], [2, 1550], [3, 1500], [4, 1450]]),
      eloCalibration: CALIBRATION,
      format: { teamCount: 4, playoffTeamCount: 2 },
    };
    const result = runPlayoffOddsSimulation(input, 42, 10_000);

    // No randomness was possible — a single deterministic pass, honestly reported as such.
    expect(result.runs).toBe(1);

    const byFranchise = new Map(result.franchises.map((f) => [f.franchiseId, f]));
    expect(byFranchise.get(1)!.playoffProbability).toBe(1);
    expect(byFranchise.get(2)!.playoffProbability).toBe(1);
    expect(byFranchise.get(3)!.playoffProbability).toBe(0);
    expect(byFranchise.get(4)!.playoffProbability).toBe(0);
    expect(byFranchise.get(1)!.topSeedProbability).toBe(1);
    expect(byFranchise.get(2)!.topSeedProbability).toBe(0);
    // One-hot seed distribution for the already-decided franchise 1 (seed 1).
    expect(byFranchise.get(1)!.seedDistribution).toEqual([1, 0, 0, 0]);
    expect(byFranchise.get(4)!.seedDistribution).toEqual([0, 0, 0, 1]);
  });

  it("playoffTeamCount = teamCount (everyone qualifies): every franchise's playoff probability is exactly 1", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 3 } };
    const result = runPlayoffOddsSimulation(input, 1, 2000);
    for (const f of result.franchises) expect(f.playoffProbability).toBe(1);
  });

  it("playoffTeamCount = 0: every franchise's playoff probability is exactly 0", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 0 } };
    const result = runPlayoffOddsSimulation(input, 1, 2000);
    for (const f of result.franchises) expect(f.playoffProbability).toBe(0);
  });

  it("clamps an out-of-range playoffTeamCount (larger than teamCount) rather than throwing", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 99 } };
    const result = runPlayoffOddsSimulation(input, 1, 1000);
    for (const f of result.franchises) expect(f.playoffProbability).toBe(1);
  });

  it("a franchise missing from eloByFranchise does not throw (defensive ELO_START fallback)", () => {
    const { standings, remaining } = threeTeamFixture();
    const input: PlayoffOddsInput = {
      standings,
      remainingMatchups: remaining,
      eloByFranchise: new Map(), // nobody resolved — every game defaults to a 1500-vs-1500 coin flip
      eloCalibration: CALIBRATION,
      format: { teamCount: 3, playoffTeamCount: 2 },
    };
    expect(() => runPlayoffOddsSimulation(input, 1, 500)).not.toThrow();
  });
});

describe("runPlayoffOddsSimulation — all-games-remaining sanity", () => {
  it("a large, consistent Elo favorite ends up with a strictly higher playoff probability than a large underdog", () => {
    const standings: PlayoffOddsStanding[] = [
      { franchiseId: 1, wins: 0, losses: 0, ties: 0, pointsFor: 0 },
      { franchiseId: 2, wins: 0, losses: 0, ties: 0, pointsFor: 0 },
      { franchiseId: 3, wins: 0, losses: 0, ties: 0, pointsFor: 0 },
      { franchiseId: 4, wins: 0, losses: 0, ties: 0, pointsFor: 0 },
    ];
    // A full round-robin so every team's simulated record depends only on its own Elo strength.
    const remaining: PlayoffOddsMatchup[] = [
      { homeFranchiseId: 1, awayFranchiseId: 2 },
      { homeFranchiseId: 1, awayFranchiseId: 3 },
      { homeFranchiseId: 1, awayFranchiseId: 4 },
      { homeFranchiseId: 2, awayFranchiseId: 3 },
      { homeFranchiseId: 2, awayFranchiseId: 4 },
      { homeFranchiseId: 3, awayFranchiseId: 4 },
    ];
    const elo = new Map<number, number>([
      [1, 2000], // huge favorite
      [2, 1500],
      [3, 1500],
      [4, 1000], // huge underdog
    ]);
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 4, playoffTeamCount: 2 } };
    const result = runPlayoffOddsSimulation(input, 99, 10_000);
    const byFranchise = new Map(result.franchises.map((f) => [f.franchiseId, f]));

    expect(byFranchise.get(1)!.playoffProbability).toBeGreaterThan(byFranchise.get(4)!.playoffProbability);
    expect(byFranchise.get(1)!.topSeedProbability).toBeGreaterThan(0.9); // should win the top seed nearly every time

    for (const f of result.franchises) {
      expect(f.playoffProbability).toBeGreaterThanOrEqual(0);
      expect(f.playoffProbability).toBeLessThanOrEqual(1);
      expect(f.topSeedProbability).toBeGreaterThanOrEqual(0);
      expect(f.topSeedProbability).toBeLessThanOrEqual(1);
      const seedSum = f.seedDistribution.reduce((a, b) => a + b, 0);
      expect(seedSum).toBeCloseTo(1, 6);
    }
  });

  it("invariant: the sum of every franchise's playoff probability equals playoffTeamCount exactly (each trajectory always seats exactly that many teams)", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 2 } };
    const result = runPlayoffOddsSimulation(input, 55, 10_000);
    const total = result.franchises.reduce((a, f) => a + f.playoffProbability, 0);
    expect(total).toBeCloseTo(2, 9);
  });

  it("invariant: the sum of every franchise's top-seed probability equals exactly 1 (exactly one team finishes #1 per trajectory)", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 2 } };
    const result = runPlayoffOddsSimulation(input, 55, 10_000);
    const total = result.franchises.reduce((a, f) => a + f.topSeedProbability, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  it("respects the requested runs count when there are remaining games", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: CALIBRATION, format: { teamCount: 3, playoffTeamCount: 2 } };
    const result = runPlayoffOddsSimulation(input, 1, 1234);
    expect(result.runs).toBe(1234);
  });
});

describe("runPlayoffOddsSimulation — uses the CALIBRATED model, never a raw/identity shortcut silently", () => {
  it("IDENTITY_ELO_CALIBRATION is accepted like any other EloCalibration (no special-casing) — it's on the CALLER to never pass it in production", () => {
    const { standings, remaining, elo } = threeTeamFixture();
    const input: PlayoffOddsInput = { standings, remainingMatchups: remaining, eloByFranchise: elo, eloCalibration: IDENTITY_ELO_CALIBRATION, format: { teamCount: 3, playoffTeamCount: 2 } };
    expect(() => runPlayoffOddsSimulation(input, 1, 500)).not.toThrow();
  });
});
