/**
 * Monte Carlo playoff-odds simulator (Task 52, roadmap §5 — the regular-season half; §23's
 * championship-bracket odds is a later task this one is deliberately scoped to enable, not
 * duplicate). From a set of franchises' CURRENT real standings plus the remaining REGULAR-SEASON
 * schedule, simulates N complete "rest of season" trajectories using the CALIBRATED win-probability
 * model (`./eloCalibration`) and reports, per franchise: how often it finished inside the playoff
 * bracket, how often it finished the #1 overall seed, and its full final-seed probability
 * distribution. Pure per AGENTS.md: no DB, no IO, no `Math.random`/`Date.now` — every call is
 * bit-for-bit reproducible given its `seed` (see `mulberry32` below), matching this codebase's
 * "rebuilds reproduce history exactly" discipline for derived stats.
 *
 * The calibration is required rather than defaulted, so callers cannot silently fall back to an
 * uncalibrated generic Elo formula. The engine is read-only and deterministic for identical
 * inputs, seed, and run count.
 *
 * SCOPE: this engine only simulates the REGULAR SEASON through to its final standings — it does
 * NOT simulate the playoff bracket itself (who wins the championship). "P(playoffs)" = probability
 * of finishing among the top `format.playoffTeamCount` regular-season seeds; "P(top seed)" =
 * probability of finishing #1 overall. Extending this to simulate the bracket itself is exactly the
 * §23 follow-on this task's brief names — out of scope here.
 *
 * DOCUMENTED SIMPLIFICATIONS (deliberate, not oversights — see this task's report for the
 * reasoning in full):
 *  - Elo is held FIXED at its pre-simulation value for every remaining game across an ENTIRE
 *    simulated trajectory — this engine never re-runs `replay()`'s K-factor update mid-simulation.
 *    Within-season Elo drift is a second-order effect for a roster that doesn't change teams
 *    mid-season; holding it fixed keeps 10,000 trajectories cheap and keeps this engine from having
 *    to re-implement `replay()`'s margin-of-victory/K-factor machinery a second time.
 *  - Every remaining game is simulated as DECISIVE (home or away wins, drawn against
 *    `calibratedEloProbability`) — ties are modeled as decisive because the
 *    calibrated model has no separate tie-probability output to draw from, so this engine never
 *    manufactures one.
 *  - The points-for tiebreak uses each franchise's
 *    ALREADY-ACCUMULATED real points-for through games actually played — NOT a simulated forward
 *    projection of future scores, since this engine only ever models WIN probability, never a score
 *    margin, for these pre-game-with-full-lineups-remaining future weeks (see
 *    `src/engines/winProbability.ts`'s own module docstring: pre-game, its score-based term is
 *    provably uninformative anyway — every team shares the same starting-slot composition before a
 *    single point is on the board).
 */

import { calibratedEloProbability, type EloCalibration } from "./eloCalibration";

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32 — a small, fast, public-domain 32-bit seeded PRNG. Returns a `() => number` generator
 * producing values in [0, 1); each call advances the closure's internal state deterministically, so
 * two generators built from the SAME `seed` always produce the SAME sequence forever. This is the
 * ONLY source of randomness anywhere in this engine — `Math.random()`/`Date.now()` are fine
 * elsewhere in this codebase's app code (AGENTS.md's "pure functions only" rule is about DB/IO, not
 * randomness per se), but a Monte Carlo simulation's entire output IS its random draws, so
 * "deterministic per (seed, inputs)" is only achievable with an injected, seedable generator —
 * `Math.random()` cannot be seeded at all, and would make this engine unreproducible and untestable.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PlayoffOddsStanding {
  franchiseId: number;
  wins: number;
  losses: number;
  ties: number;
  /** Real, ALREADY-ACCUMULATED points-for through the games actually played so far this season —
   * see the module docstring's tiebreak note. Held fixed for every simulated trajectory. */
  pointsFor: number;
}

export interface PlayoffOddsMatchup {
  /** Orientation matters: this engine always computes `eloByFranchise[home] -
   * eloByFranchise[away]`, the SAME home-minus-away convention
   * `src/server/queries/winProbability.ts`'s `loadEloCalibrationSamples` used to FIT
   * `eloCalibration` in the first place. Fantasy football has no real home-field advantage —
   * "home"/"away" here is just each matchup's own stored ESPN schedule orientation, carried
   * through so the calibrated model sees the exact input shape it was fit on. */
  homeFranchiseId: number;
  awayFranchiseId: number;
}

export interface PlayoffOddsFormat {
  teamCount: number;
  /** Clamped into `[0, standings.length]` by `runPlayoffOddsSimulation` — a malformed or
   * out-of-range value from `seasons.playoffFormatJson` never throws or produces a nonsensical
   * probability, it just degrades to the nearest valid bracket size. */
  playoffTeamCount: number;
}

export interface PlayoffOddsInput {
  standings: readonly PlayoffOddsStanding[];
  /** Regular-season games that have NOT been played yet — a completed/complete-season input
   * simply passes an empty array here (see the degenerate-case short-circuit below). */
  remainingMatchups: readonly PlayoffOddsMatchup[];
  /** Each franchise's CURRENT (pre-remaining-schedule) Elo rating, held FIXED for the whole
   * simulation (see module docstring). A franchiseId referenced by `remainingMatchups` but absent
   * here — shouldn't happen for real data, the caller always resolves a current rating for every
   * franchise in `standings` — defaults to `ELO_START` rather than throwing (see
   * `resolveEloFor`), the same "never rated yet" baseline `src/engines/replay.ts` itself uses. */
  eloByFranchise: ReadonlyMap<number, number>;
  eloCalibration: EloCalibration;
  format: PlayoffOddsFormat;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface PlayoffOddsFranchiseResult {
  franchiseId: number;
  playoffProbability: number;
  topSeedProbability: number;
  /** index 0 = P(finish seed 1) ... index `standings.length - 1` = P(finish LAST). Sums to 1
   * across one franchise's own array (exactly for the degenerate no-remaining-games case, within
   * floating-point summation noise otherwise). */
  seedDistribution: number[];
}

export interface PlayoffOddsResult {
  /** The ACTUAL number of simulated trajectories this result is built from — see the "no
   * remaining games" short-circuit below for why this can be `1` even when a much larger `runs`
   * was requested. */
  runs: number;
  franchises: PlayoffOddsFranchiseResult[];
}

const DEFAULT_RUNS = 10_000;
const ELO_START_FALLBACK = 1500; // mirrors src/engines/replay.ts's ELO_START — not imported to keep
// this engine's only dependency the calibration module itself; a franchise entirely missing from
// `eloByFranchise` is defensive-only (see the docstring above), never expected against real data.

function resolveEloFor(eloByFranchise: ReadonlyMap<number, number>, franchiseId: number): number {
  return eloByFranchise.get(franchiseId) ?? ELO_START_FALLBACK;
}

function winPct(wins: number, losses: number, ties: number): number {
  const games = wins + losses + ties;
  return games > 0 ? (wins + 0.5 * ties) / games : 0;
}

/**
 * Final regular-season order, best -> worst: win% desc, then points-for desc, then franchiseId asc
 * as a final deterministic tiebreak. Mirrors `sortRealStandings`'s in-progress-season comparator in
 * `src/server/queries/standings.ts`. `src/engines/` cannot import from `src/server/`
 * per AGENTS.md, so this is a deliberate, documented duplication of that one comparator — not a
 * fork of its behavior; if `sortRealStandings`'s tiebreak convention ever changes, this must change
 * with it (same cross-file contract `columns.tsx`'s Gap tooltip already documents for
 * `scheduleHelp()`).
 */
export function rankFranchisesForSeeding(
  rows: readonly { franchiseId: number; wins: number; losses: number; ties: number; pointsFor: number }[],
): number[] {
  return [...rows]
    .sort((a, b) => {
      const pctDiff = winPct(b.wins, b.losses, b.ties) - winPct(a.wins, a.losses, a.ties);
      if (pctDiff !== 0) return pctDiff;
      if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
      return a.franchiseId - b.franchiseId;
    })
    .map((r) => r.franchiseId);
}

/**
 * Runs `runs` independent Monte Carlo trajectories (default 10,000, per this task's brief) of the
 * remaining regular season and aggregates, per franchise, how often it made the playoff bracket,
 * finished the #1 seed, and its full seed distribution. Deterministic: the exact same
 * `(input, seed, runs)` always produces the exact same `PlayoffOddsResult` (see `mulberry32`).
 *
 * DEGENERATE CASE — no remaining games (a complete regular season, or a season simulated from its
 * very last meaningful boundary): every one of `runs` trajectories would be BIT-FOR-BIT IDENTICAL
 * (no random draw ever happens, since there's nothing left to simulate), so this short-circuits to
 * exactly one pass rather than burning `runs` identical iterations — `result.runs` reports `1`,
 * honestly reflecting that no randomness was involved, and every probability comes out exactly 0 or
 * 1 (100%), matching reality exactly rather than approximating it.
 */
export function runPlayoffOddsSimulation(input: PlayoffOddsInput, seed: number, runs: number = DEFAULT_RUNS): PlayoffOddsResult {
  const { standings, remainingMatchups, eloByFranchise, eloCalibration, format } = input;
  const teamCount = standings.length;
  const playoffTeamCount = Math.max(0, Math.min(format.playoffTeamCount, teamCount));

  const effectiveRuns = remainingMatchups.length === 0 ? 1 : Math.max(1, Math.trunc(runs));
  const rng = mulberry32(seed);

  const playoffCounts = new Map<number, number>();
  const topSeedCounts = new Map<number, number>();
  const seedCounts = new Map<number, number[]>();
  for (const s of standings) {
    playoffCounts.set(s.franchiseId, 0);
    topSeedCounts.set(s.franchiseId, 0);
    seedCounts.set(s.franchiseId, new Array<number>(teamCount).fill(0));
  }

  for (let run = 0; run < effectiveRuns; run++) {
    const wins = new Map<number, number>();
    const losses = new Map<number, number>();
    const ties = new Map<number, number>();
    for (const s of standings) {
      wins.set(s.franchiseId, s.wins);
      losses.set(s.franchiseId, s.losses);
      ties.set(s.franchiseId, s.ties);
    }

    for (const m of remainingMatchups) {
      const homeElo = resolveEloFor(eloByFranchise, m.homeFranchiseId);
      const awayElo = resolveEloFor(eloByFranchise, m.awayFranchiseId);
      const pHome = calibratedEloProbability(homeElo - awayElo, eloCalibration);
      const homeWins = rng() < pHome;
      if (homeWins) {
        wins.set(m.homeFranchiseId, (wins.get(m.homeFranchiseId) ?? 0) + 1);
        losses.set(m.awayFranchiseId, (losses.get(m.awayFranchiseId) ?? 0) + 1);
      } else {
        wins.set(m.awayFranchiseId, (wins.get(m.awayFranchiseId) ?? 0) + 1);
        losses.set(m.homeFranchiseId, (losses.get(m.homeFranchiseId) ?? 0) + 1);
      }
    }

    const rows = standings.map((s) => ({
      franchiseId: s.franchiseId,
      wins: wins.get(s.franchiseId) ?? s.wins,
      losses: losses.get(s.franchiseId) ?? s.losses,
      ties: ties.get(s.franchiseId) ?? s.ties,
      pointsFor: s.pointsFor,
    }));
    const order = rankFranchisesForSeeding(rows);

    order.forEach((franchiseId, idx) => {
      const dist = seedCounts.get(franchiseId);
      if (dist) dist[idx] = (dist[idx] ?? 0) + 1;
      if (idx < playoffTeamCount) playoffCounts.set(franchiseId, (playoffCounts.get(franchiseId) ?? 0) + 1);
      if (idx === 0) topSeedCounts.set(franchiseId, (topSeedCounts.get(franchiseId) ?? 0) + 1);
    });
  }

  const franchises: PlayoffOddsFranchiseResult[] = standings.map((s) => ({
    franchiseId: s.franchiseId,
    playoffProbability: (playoffCounts.get(s.franchiseId) ?? 0) / effectiveRuns,
    topSeedProbability: (topSeedCounts.get(s.franchiseId) ?? 0) / effectiveRuns,
    seedDistribution: (seedCounts.get(s.franchiseId) ?? new Array<number>(teamCount).fill(0)).map((c) => c / effectiveRuns),
  }));

  return { runs: effectiveRuns, franchises };
}

/** Stable public adapter used by query/build callers; simulation behavior remains centralized in
 * `runPlayoffOddsSimulation` so seed handling and calibration cannot diverge. */
export function calculatePlayoffOdds(input: PlayoffOddsInput, seed: number, runs: number = DEFAULT_RUNS): PlayoffOddsResult {
  return runPlayoffOddsSimulation(input, seed, runs);
}
