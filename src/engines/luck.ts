/**
 * Weekly luck score. Pure per AGENTS.md.
 *
 * `luck_w = (result - pAllPlay) + 0.25 * closeSwing`
 *   - `result` in {1, 0.5, 0} — actual head-to-head outcome that week.
 *   - `pAllPlay = allPlayWins / opponents` — how often you'd have won that
 *     week against a randomly chosen league opponent. `allPlayWins` may be
 *     fractional (callers typically pass `wins + 0.5 * ties` from
 *     `allPlayWeek`'s output). 0 when there are no opponents to compare
 *     against (nothing to be lucky against).
 *   - `closeSwing`: +1 for a win by <= 5.0 points, -1 for a loss by <= 5.0
 *     points, else 0. Ties never swing — there's no "close" direction to
 *     credit or blame.
 */

export interface WeeklyLuckInput {
  result: 1 | 0.5 | 0;
  allPlayWins: number;
  opponents: number;
  /** Absolute point margin of victory/defeat for the actual matchup that week. */
  margin: number;
}

const CLOSE_MARGIN_THRESHOLD = 5.0;

export function weeklyLuck(input: WeeklyLuckInput): number {
  const { result, allPlayWins, opponents, margin } = input;
  const pAllPlay = opponents > 0 ? allPlayWins / opponents : 0;

  let closeSwing = 0;
  if (result === 1 && margin <= CLOSE_MARGIN_THRESHOLD) closeSwing = 1;
  else if (result === 0 && margin <= CLOSE_MARGIN_THRESHOLD) closeSwing = -1;

  return result - pAllPlay + 0.25 * closeSwing;
}
