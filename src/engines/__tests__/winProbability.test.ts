import { describe, expect, it } from "vitest";
import { eloExpected } from "../replay";
import {
  AWAY_TIED_FINAL_AWAY,
  AWAY_TRAILS_FINAL_AWAY,
  ELO_FAVORITE_HOME,
  ELO_UNDERDOG_AWAY,
  EVEN_ELO_AWAY,
  EVEN_ELO_HOME,
  HOME_LEADS_FINAL_HOME,
  HOME_TIED_FINAL_HOME,
  MID_WEEK_AWAY,
  MID_WEEK_HOME,
  SAMPLE_CALIBRATION,
} from "../__fixtures__/winProbability";
import {
  CALIBRATION_POOLED_SLOT,
  normalCdf,
  winProbability,
  winProbabilityBreakdown,
  type SlotScoringCalibration,
  type WinProbabilityTeamState,
} from "../winProbability";

describe("normalCdf", () => {
  it("is 0.5 at z=0", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
  });

  it("matches well-known standard-normal reference values", () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 3);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it("is monotonically non-decreasing", () => {
    let prev = normalCdf(-5);
    for (let z = -4.9; z <= 5; z += 0.1) {
      const cur = normalCdf(z);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("approaches 0 and 1 in the tails", () => {
    expect(normalCdf(-6)).toBeLessThan(1e-6);
    expect(normalCdf(6)).toBeGreaterThan(1 - 1e-6);
  });
});

describe("winProbability — edge cases", () => {
  it("0 remaining both sides, home ahead: collapses to 1 by score, ignoring Elo", () => {
    // Elo favors AWAY here (1500 vs a hypothetical would-be-underdog home) — proves the score,
    // not Elo, decides once nobody's left to play.
    const home: WinProbabilityTeamState = { ...HOME_LEADS_FINAL_HOME, eloPre: 1300 };
    const away: WinProbabilityTeamState = { ...AWAY_TRAILS_FINAL_AWAY, eloPre: 1700 };
    const breakdown = winProbabilityBreakdown({ home, away }, SAMPLE_CALIBRATION);

    expect(breakdown.weekProgress).toBe(1);
    expect(breakdown.winProbability).toBe(1);
  });

  it("0 remaining both sides, away ahead: collapses to 0 by score", () => {
    const home: WinProbabilityTeamState = { ...AWAY_TRAILS_FINAL_AWAY, eloPre: 1700 };
    const away: WinProbabilityTeamState = { ...HOME_LEADS_FINAL_HOME, eloPre: 1300 };
    const breakdown = winProbabilityBreakdown({ home, away }, SAMPLE_CALIBRATION);

    expect(breakdown.weekProgress).toBe(1);
    expect(breakdown.winProbability).toBe(0);
  });

  it("0 remaining both sides, exact tie: collapses to 0.5", () => {
    const breakdown = winProbabilityBreakdown({ home: HOME_TIED_FINAL_HOME, away: AWAY_TIED_FINAL_AWAY }, SAMPLE_CALIBRATION);

    expect(breakdown.weekProgress).toBe(1);
    expect(breakdown.winProbability).toBe(0.5);
  });

  it("all starters remaining, even Elo: prior-dominated at exactly 0.5 (identical remaining distributions cancel)", () => {
    const breakdown = winProbabilityBreakdown({ home: EVEN_ELO_HOME, away: EVEN_ELO_AWAY }, SAMPLE_CALIBRATION);

    expect(breakdown.weekProgress).toBe(0);
    expect(breakdown.eloProbability).toBeCloseTo(0.5, 6);
    expect(breakdown.winProbability).toBeCloseTo(0.5, 6);
  });

  it("all starters remaining, Elo favorite: result equals the pure Elo prior exactly", () => {
    const breakdown = winProbabilityBreakdown({ home: ELO_FAVORITE_HOME, away: ELO_UNDERDOG_AWAY }, SAMPLE_CALIBRATION);
    const expectedElo = eloExpected(ELO_FAVORITE_HOME.eloPre, ELO_UNDERDOG_AWAY.eloPre);

    expect(breakdown.weekProgress).toBe(0);
    expect(breakdown.eloProbability).toBeCloseTo(expectedElo, 10);
    expect(breakdown.winProbability).toBeCloseTo(expectedElo, 10);
    expect(breakdown.winProbability).toBeGreaterThan(0.5); // home really is the favorite here
  });

  it("no starter information at all on either side: degrades to Elo-only rather than fabricating certainty", () => {
    const home: WinProbabilityTeamState = { score: 0, eloPre: 1650, startersPlayed: 0, remainingBySlot: {} };
    const away: WinProbabilityTeamState = { score: 0, eloPre: 1500, startersPlayed: 0, remainingBySlot: {} };
    const breakdown = winProbabilityBreakdown({ home, away }, SAMPLE_CALIBRATION);

    expect(breakdown.weekProgress).toBe(0);
    expect(breakdown.winProbability).toBeCloseTo(eloExpected(1650, 1500), 10);
  });
});

describe("winProbability — monotonicity", () => {
  it("more home points never lowers home's win probability, holding everything else fixed (mid-week state)", () => {
    let prev = -Infinity;
    for (let bump = 0; bump <= 40; bump += 1) {
      const home: WinProbabilityTeamState = { ...MID_WEEK_HOME, score: MID_WEEK_HOME.score + bump };
      const p = winProbability({ home, away: MID_WEEK_AWAY }, SAMPLE_CALIBRATION);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it("more home points never lowers home's win probability, holding everything else fixed (fully resolved state)", () => {
    let prev = -Infinity;
    for (let bump = -20; bump <= 20; bump += 1) {
      const home: WinProbabilityTeamState = { ...HOME_LEADS_FINAL_HOME, score: HOME_LEADS_FINAL_HOME.score + bump };
      const p = winProbability({ home, away: AWAY_TRAILS_FINAL_AWAY }, SAMPLE_CALIBRATION);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it("fewer away points never lowers home's win probability (symmetric check)", () => {
    let prev = -Infinity;
    for (let cut = 0; cut <= 40; cut += 1) {
      const away: WinProbabilityTeamState = { ...MID_WEEK_AWAY, score: MID_WEEK_AWAY.score - cut };
      const p = winProbability({ home: MID_WEEK_HOME, away }, SAMPLE_CALIBRATION);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it("crossing the tie point at zero variance steps cleanly from 0 to 0.5 to 1, never dipping", () => {
    const results: number[] = [];
    for (let score = 105; score <= 115; score += 1) {
      const home: WinProbabilityTeamState = { score, eloPre: 1500, startersPlayed: 9, remainingBySlot: {} };
      const away: WinProbabilityTeamState = { score: 110, eloPre: 1500, startersPlayed: 9, remainingBySlot: {} };
      results.push(winProbability({ home, away }, SAMPLE_CALIBRATION));
    }
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!).toBeGreaterThanOrEqual(results[i - 1]!);
    }
    expect(results[0]).toBe(0);
    expect(results[5]).toBe(0.5); // score === 110, exact tie
    expect(results[results.length - 1]).toBe(1);
  });
});

describe("winProbability — calibration fallback", () => {
  it("an unmapped slot label falls back to the pooled ALL distribution", () => {
    const calibrationWithoutRB: SlotScoringCalibration = { ...SAMPLE_CALIBRATION };
    delete calibrationWithoutRB.RB;

    const home: WinProbabilityTeamState = { score: 0, eloPre: 1500, startersPlayed: 0, remainingBySlot: { RB: 1 } };
    const homeAll: WinProbabilityTeamState = { score: 0, eloPre: 1500, startersPlayed: 0, remainingBySlot: { [CALIBRATION_POOLED_SLOT]: 1 } };
    const away: WinProbabilityTeamState = { score: 0, eloPre: 1500, startersPlayed: 5, remainingBySlot: {} };

    const withFallback = winProbabilityBreakdown({ home, away }, calibrationWithoutRB);
    const usingAllDirectly = winProbabilityBreakdown({ home: homeAll, away }, calibrationWithoutRB);

    // Falling back to ALL for the unmapped RB slot must behave identically to a starter
    // explicitly counted under the ALL slot itself.
    expect(withFallback.winProbability).toBeCloseTo(usingAllDirectly.winProbability, 10);
  });

  it("a slot missing from both the table and the pooled fallback contributes 0, not a crash", () => {
    const bareCalibration: SlotScoringCalibration = { QB: { mean: 18, variance: 36 } };
    const home: WinProbabilityTeamState = { score: 0, eloPre: 1500, startersPlayed: 0, remainingBySlot: { "D/ST": 1 } };
    const away: WinProbabilityTeamState = { score: 0, eloPre: 1500, startersPlayed: 0, remainingBySlot: {} };

    expect(() => winProbability({ home, away }, bareCalibration)).not.toThrow();
    const breakdown = winProbabilityBreakdown({ home, away }, bareCalibration);
    // Home's lone D/ST remaining contributes 0 mean/0 variance (no calibration for it, no ALL
    // fallback either) — home's remaining distribution ends up {mean:0,variance:0}, identical to
    // away's genuinely-empty one, so projectedDiff is 0 and combinedVariance is 0 -> scoreProbability
    // 0.5, and weekProgress > 0 here (1 real remaining slot counted, 0 played) so it's actually a
    // pure-score-model tie, not an Elo fallback — even Elo (1500 vs 1500) lands on 0.5 too either way.
    expect(breakdown.winProbability).toBeCloseTo(0.5, 10);
  });
});

describe("winProbability — mid-week sanity", () => {
  it("blends score and Elo strictly between the two pure signals when both matter", () => {
    const breakdown = winProbabilityBreakdown({ home: MID_WEEK_HOME, away: MID_WEEK_AWAY }, SAMPLE_CALIBRATION);
    expect(breakdown.weekProgress).toBeGreaterThan(0);
    expect(breakdown.weekProgress).toBeLessThan(1);

    const lo = Math.min(breakdown.scoreProbability, breakdown.eloProbability);
    const hi = Math.max(breakdown.scoreProbability, breakdown.eloProbability);
    expect(breakdown.winProbability).toBeGreaterThanOrEqual(lo - 1e-12);
    expect(breakdown.winProbability).toBeLessThanOrEqual(hi + 1e-12);
  });
});
