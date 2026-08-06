/**
 * Elo-diff -> P(win) calibration. Pure: no DB and no IO.
 *
 * The generic 400-point Elo logistic curve is not automatically calibrated to fantasy-football
 * outcomes. This module fits a deterministic two-parameter logistic curve against archived final
 * matchups. Callers assemble pre-game Elo differences, so post-game information cannot leak into
 * the fit. The calibration is descriptive rather than a claim of held-out performance; the
 * playoff-odds feature provides its own season-boundary backtest for the complete simulation.
 */

export interface EloCalibration {
  intercept: number;
  slope: number;
}

export interface EloCalibrationSample {
  /** One side's pre-game Elo minus the other's — the SAME orientation as `result` (e.g. both from
   * the home side's perspective, or both from a consistent "side A" perspective — the caller just
   * has to be consistent within one call, since the model has no notion of "home" itself). */
  eloDiff: number;
  /** 1 = the `eloDiff` side won, 0 = lost, 0.5 = tie. */
  result: 0 | 0.5 | 1;
}

/**
 * Reproduces `eloExpected`'s raw 400-point formula EXACTLY: `eloExpected(a, b) ===
 * calibratedEloProbability(a - b, IDENTITY_ELO_CALIBRATION)` for any a, b (see this module's own
 * test for the direct proof). This is the "no calibration happened" baseline — exported for
 * tests/fixtures that want raw-Elo-equivalent behavior on purpose, and as `fitEloCalibration`'s
 * fallback when there's no data to fit from (e.g. a brand-new database before any final has ever
 * been played). PRODUCTION CODE MUST NEVER PASS THIS AS IF IT WERE A REAL FITTED CALIBRATION —
 * it's provably the miscalibrated thing this whole module exists to replace. Real callers get
 * their calibration from `src/server/queries/winProbability.ts`'s `loadEloCalibration`.
 */
export const IDENTITY_ELO_CALIBRATION: EloCalibration = { intercept: 0, slope: Math.log(10) / 400 };

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/** P(the `eloDiff` side wins) under `calibration` — `sigmoid(intercept + slope * eloDiff)`. Safe
 * for any finite `eloDiff`/`calibration` values, including a very large fitted `slope`: `Math.exp`
 * overflows to `0`/`Infinity` (never `NaN`) at the extremes, which this formula's division handles
 * cleanly, saturating to exactly 0 or 1 rather than producing a non-finite result. */
export function calibratedEloProbability(eloDiff: number, calibration: EloCalibration): number {
  return sigmoid(calibration.intercept + calibration.slope * eloDiff);
}

const MAX_ITERATIONS = 100;
const CONVERGENCE_TOLERANCE = 1e-10;
/** Below this, the 2x2 Hessian is treated as singular (either every sample shares one `eloDiff` —
 * slope is genuinely unidentifiable from a single x-value — or the iteration has driven every
 * sample's weight `p*(1-p)` toward 0 via near-perfect separation) and iteration stops, returning
 * the LAST finite estimate rather than dividing by ~0. */
const HESSIAN_SINGULARITY_EPSILON = 1e-12;

/**
 * Fits `{ intercept, slope }` by maximum likelihood (Newton-Raphson / IRLS — exact for this
 * 2-parameter logistic model, typically converging in well under `MAX_ITERATIONS`) so that
 * `calibratedEloProbability(sample.eloDiff, fitted)` best predicts `sample.result` across every
 * sample. Cross-entropy loss generalizes cleanly to a fractional `result` (0.5 for a tie) — no
 * special-casing needed.
 *
 * `samples.length === 0` returns `IDENTITY_ELO_CALIBRATION` verbatim — a documented degrade (e.g.
 * a fresh database before any final has been recorded), never a crash or a fabricated fit.
 *
 * Deterministic: the same `samples` array (any order — this function never sorts or depends on
 * input order) always produces the exact same output, same discipline every other derived-stat
 * computation in this codebase follows (AGENTS.md: "rebuilds reproduce history exactly").
 */
export function fitEloCalibration(samples: readonly EloCalibrationSample[]): EloCalibration {
  if (samples.length === 0) return IDENTITY_ELO_CALIBRATION;

  let intercept = IDENTITY_ELO_CALIBRATION.intercept;
  let slope = IDENTITY_ELO_CALIBRATION.slope;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    // Gradient (g0, g1) and the negative Hessian's three distinct entries (s0, s1, s2) of the
    // log-likelihood, evaluated at the current (intercept, slope) — standard IRLS bookkeeping.
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let g0 = 0;
    let g1 = 0;
    for (const { eloDiff: x, result: y } of samples) {
      const p = sigmoid(intercept + slope * x);
      const w = p * (1 - p);
      s0 += w;
      s1 += w * x;
      s2 += w * x * x;
      const residual = y - p;
      g0 += residual;
      g1 += residual * x;
    }

    const determinant = s0 * s2 - s1 * s1;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < HESSIAN_SINGULARITY_EPSILON) break;

    const deltaIntercept = (s2 * g0 - s1 * g1) / determinant;
    const deltaSlope = (s0 * g1 - s1 * g0) / determinant;
    if (!Number.isFinite(deltaIntercept) || !Number.isFinite(deltaSlope)) break;

    intercept += deltaIntercept;
    slope += deltaSlope;

    if (Math.abs(deltaIntercept) + Math.abs(deltaSlope) < CONVERGENCE_TOLERANCE) break;
  }

  return { intercept, slope };
}
