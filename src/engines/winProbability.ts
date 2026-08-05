/**
 * Live win-probability engine (roadmap "Live Win Probability / Sweat Meter" — Task 32,
 * backend half; the UI lands in a later wiring wave). Pure per AGENTS.md: no DB, no IO.
 * Given one matchup's current state, returns P(home wins) in [0,1].
 *
 * MODEL V1 combines two signals:
 *
 * 1. A normal-approximation over each side's REMAINING starters' scoring distribution,
 *    calibrated per lineup-slot label from the league's OWN roster_slots history (see
 *    `SlotScoringCalibration` below and `src/server/stats/build.ts`'s slot-scoring-stats
 *    build stage, which produces it). Each remaining starter slot is modeled as an
 *    independent Normal(mean, variance) draw; the sum of independent normals is itself
 *    normal (mean = sum of means, variance = sum of variances). This deliberately ignores
 *    any slot x slot covariance (same-game stacks, game-script correlation between a team's
 *    own RB and D/ST, etc.) — a real effect this codebase has no practical way to estimate
 *    from ~8 seasons x 12 teams x ~9 slots of data without overfitting noise. Documented
 *    simplification, not a hidden one.
 * 2. An Elo-based pre-game prior — `eloExpected`, reused verbatim from `./replay` (the SAME
 *    win-expectancy formula that drives the league's own Elo ratings, so "Elo says" and "win
 *    probability says" can never quietly diverge on the underlying math).
 *
 * BLEND: weighted by how much of the week has actually been played — weight on the
 * score-based model = (starters already played, both sides combined) / (starters total,
 * both sides combined); weight on the Elo prior = the complement. Two structural
 * consequences, both intentional and both exercised by dedicated tests in
 * `__tests__/winProbability.test.ts`:
 *
 *   - FULL LINEUPS REMAINING (weekProgress = 0, e.g. the Tuesday before kickoff): the blend
 *     collapses to the Elo prior ALONE. This isn't a rounding coincidence — every team in a
 *     season shares the exact same starting-slot composition (a league's
 *     `settingsJson.rosterSettings.lineupSlotCounts` is ONE config per SEASON, not per team —
 *     see `resolveStartingSlotCounts` in build.ts), so pre-game, both sides' projected
 *     remaining points are drawn from IDENTICAL distributions and their expected difference
 *     is a dead 0 — the score-based term is genuinely uninformative before a single point is
 *     on the board, not just given zero weight by convention. Direct, load-bearing
 *     consequence: this module's own backtest (see the honesty note below) can only ever
 *     evaluate something numerically identical to a pure-Elo baseline pre-game.
 *   - ZERO STARTERS REMAINING ANYWHERE (weekProgress = 1): combined variance collapses to 0,
 *     so the score-based term itself collapses to a step function on whoever currently leads
 *     — the final score decides outright, and the Elo prior contributes nothing (its weight
 *     is 0 anyway at that point).
 *
 * WHAT 11 SEASONS CAN AND CANNOT CALIBRATE (read before trusting this module's output):
 *   - `roster_slots` — the only source of PER-SLOT starter scoring — exists for 2018-2025
 *     only (8 seasons). 2015-2017 have matchup/team-week totals but zero archived rosters
 *     (see the espn-fantasy-data skill and build.ts's own efficiency-null comments for the
 *     same boundary). Every per-slot mean/variance in `SlotScoringCalibration` is therefore
 *     an 8-season sample, not the full 11 team_week has.
 *   - The calibration silently assumes those 8 seasons' slot-scoring distributions are
 *     STATIONARY enough to also describe 2015-2017 and any future season. Scoring rules,
 *     roster construction, and the NFL's own offensive environment have all drifted over an
 *     11-year window; this module makes no attempt to detect or correct for that drift. If a
 *     future season's scoring format changes materially (e.g. a full-PPR flip), this
 *     calibration goes stale until enough new seasons accumulate under the new rules.
 *   - A slot label with zero calibrated rows — or missing entirely from `calibration` — falls
 *     back to the pooled `CALIBRATION_POOLED_SLOT` ("ALL": every starter, every slot, pooled)
 *     that the build stage guarantees to include whenever any calibration rows exist at all.
 *     A slot missing from BOTH the per-slot table and the pooled fallback contributes 0 to
 *     both mean and variance for that remaining starter — a documented degrade, never a
 *     silent mis-estimate blended into a real number.
 *
 * INTRA-WEEK STATES CANNOT BE BACKTESTED. ESPN's live scoring only ever exists AS IT
 * HAPPENS — this codebase archives just the final normalized `roster_slots.points` per
 * player-week, never a series of intra-week snapshots (no historical "3pm Sunday" state was
 * ever captured). So any backtest built from this database can only evaluate the PRE-GAME
 * output, which — per the bullet above — is mathematically identical to the pure-Elo
 * baseline. There is no historical ground truth to check the score-blended, mid-week
 * probabilities against; that evidence only starts accumulating once this ships and the live
 * layer records real in-progress weeks going forward.
 */

import { eloExpected } from "./replay";

/** Reserved slot label for the pooled "every starter, every slot" fallback distribution — see
 * the module docstring's calibration-gap bullet. The build stage that produces
 * `SlotScoringCalibration` guarantees this key is present whenever any calibration data
 * exists at all. */
export const CALIBRATION_POOLED_SLOT = "ALL";

export interface SlotScoringDistribution {
  mean: number;
  variance: number;
}

/** Lineup-slot label (e.g. "QB", "RB", "FLEX", or `CALIBRATION_POOLED_SLOT`) -> its calibrated
 * scoring distribution. Produced by `src/server/stats/build.ts`'s slot-scoring-stats stage from
 * real `roster_slots` history — never fabricated here. */
export type SlotScoringCalibration = Record<string, SlotScoringDistribution>;

export interface WinProbabilityTeamState {
  /** This side's current cumulative score for the week. */
  score: number;
  /** Pre-game Elo rating — this franchise's rating AS OF immediately before this week's game,
   * i.e. `elo_history.elo_pre` for a completed game, or the live-layer's resolved "last known
   * post-game Elo, season-regressed if the season has rolled over since" for an in-progress
   * or upcoming one. This engine does no Elo bookkeeping of its own — it only ever reads this
   * one already-resolved number (see `src/engines/replay.ts` for where the value actually
   * comes from). */
  eloPre: number;
  /** Count of this side's STARTER roster slots that already have a recorded score this week
   * (caller has already excluded bench/IR — same convention as `optimalLineup`'s `players`
   * input and `RosterProgressRow` in the matchups query layer). */
  startersPlayed: number;
  /** This side's STARTER roster slots that do NOT yet have a recorded score this week, keyed
   * by lineup-slot label (e.g. `{ RB: 1, FLEX: 1 }`) — the engine sums each slot's own
   * calibrated distribution rather than assuming one league-average "generic bench player" for
   * every remaining starter, regardless of position. A slot with 0 remaining need not be
   * present in this object. */
  remainingBySlot: Record<string, number>;
}

export interface WinProbabilityInput {
  home: WinProbabilityTeamState;
  away: WinProbabilityTeamState;
}

/** Diagnostic breakdown behind `winProbability`'s single number — exported for the backtest
 * (which needs the pure-Elo component in isolation to build its baseline) and for tests that
 * want to assert on an intermediate value rather than reverse-engineer it from the blend. */
export interface WinProbabilityBreakdown {
  /** P(home wins) from the normal-approximation score model alone (0.5 whenever combined
   * variance is 0 AND the projected scores are exactly tied — see `normalCdf`). */
  scoreProbability: number;
  /** P(home wins) from the Elo prior alone — `eloExpected(home.eloPre, away.eloPre)`. */
  eloProbability: number;
  /** Blend weight given to `scoreProbability` (0..1); `1 - weekProgress` is `eloProbability`'s
   * weight. See the module docstring's BLEND section for the two collapse cases this drives. */
  weekProgress: number;
  /** The final blended probability — identical to `winProbability`'s return value. */
  winProbability: number;
}

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 rational approximation to erf (max
 * absolute error ~1.5e-7) — plenty of precision for a probability that only ever gets rounded
 * to a percentage point for display. Avoids pulling in a general-purpose stats dependency for
 * one function. Pure numeric helper; exported for direct unit testing.
 */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function sumRemaining(remainingBySlot: Record<string, number>): number {
  let total = 0;
  for (const count of Object.values(remainingBySlot)) total += count;
  return total;
}

/**
 * Sums one side's remaining starters into a single Normal(mean, variance) — see the module
 * docstring's independence-assumption paragraph for why summed variance (no covariance term)
 * is the deliberate simplification here. A slot absent from BOTH `calibration` and the pooled
 * fallback contributes 0 to both mean and variance (documented degrade, see module docstring).
 */
function remainingDistribution(remainingBySlot: Record<string, number>, calibration: SlotScoringCalibration): SlotScoringDistribution {
  const pooled = calibration[CALIBRATION_POOLED_SLOT];
  let mean = 0;
  let variance = 0;
  for (const [slot, count] of Object.entries(remainingBySlot)) {
    if (count <= 0) continue;
    const dist = calibration[slot] ?? pooled;
    if (!dist) continue;
    mean += count * dist.mean;
    variance += count * dist.variance;
  }
  return { mean, variance };
}

/**
 * Fraction of this matchup's combined starters (both sides) that have already played. Depends
 * ONLY on starter counts, never on score — this is what keeps `winProbability` monotonic in
 * score (see that function's docstring): a bigger lead can only move `scoreProbability` via
 * `normalCdf`, never the blend weight itself.
 *
 * Returns 0 (fully Elo-prior-dominated) when NEITHER side has any starter information at all
 * (both `startersPlayed` and every `remainingBySlot` count are 0) — a genuinely empty input,
 * e.g. no roster synced yet for this team-week. Degrading to the Elo prior rather than
 * fabricating a 50/50 "everyone's tied at zero" certainty from an empty state.
 */
function computeWeekProgress(home: WinProbabilityTeamState, away: WinProbabilityTeamState): number {
  const totalRemaining = sumRemaining(home.remainingBySlot) + sumRemaining(away.remainingBySlot);
  const totalPlayed = home.startersPlayed + away.startersPlayed;
  const total = totalRemaining + totalPlayed;
  if (total <= 0) return 0;
  return totalPlayed / total;
}

/** Variance below this is treated as exactly 0 (both sides fully resolved, or a calibration gap
 * that leaves nothing to model) — avoids a division-by-near-zero blowup in `normalCdf`'s input. */
const VARIANCE_EPSILON = 1e-9;

/**
 * Full breakdown behind `winProbability` — see that function and the module docstring for the
 * model. Monotonicity: holding `away` and both sides' starter counts fixed, increasing
 * `home.score` strictly increases `projectedDiff`, which `normalCdf` (or the exact-tie step
 * function below `VARIANCE_EPSILON`) maps to a non-decreasing `scoreProbability`; `weekProgress`
 * doesn't depend on score at all, so the blended result is non-decreasing in `home.score` too —
 * "more points never lowers your probability" holds by construction, not just by test.
 */
export function winProbabilityBreakdown(input: WinProbabilityInput, calibration: SlotScoringCalibration): WinProbabilityBreakdown {
  const { home, away } = input;

  const homeDist = remainingDistribution(home.remainingBySlot, calibration);
  const awayDist = remainingDistribution(away.remainingBySlot, calibration);

  const projectedDiff = home.score + homeDist.mean - (away.score + awayDist.mean);
  const combinedVariance = homeDist.variance + awayDist.variance;

  const scoreProbability =
    combinedVariance <= VARIANCE_EPSILON
      ? projectedDiff > 0
        ? 1
        : projectedDiff < 0
          ? 0
          : 0.5
      : normalCdf(projectedDiff / Math.sqrt(combinedVariance));

  const eloProbability = eloExpected(home.eloPre, away.eloPre);
  const weekProgress = computeWeekProgress(home, away);
  const winProbability = weekProgress * scoreProbability + (1 - weekProgress) * eloProbability;

  return { scoreProbability, eloProbability, weekProgress, winProbability };
}

/** P(home wins), in [0,1]. See the module docstring for the model and `winProbabilityBreakdown`
 * for the intermediate values this collapses. */
export function winProbability(input: WinProbabilityInput, calibration: SlotScoringCalibration): number {
  return winProbabilityBreakdown(input, calibration).winProbability;
}
