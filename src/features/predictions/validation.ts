import type { PredictionCategory } from "@/server/db/schema";

/**
 * Pure form-input validation for the /predictions Server Action. Kept out of actions.ts because
 * every export of a `"use server"` module must itself be an async Server Action — these are
 * ordinary synchronous functions, unit-testable directly with no DB/cookies mocking. Mirrors
 * src/features/polls/validation.ts's split.
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const BOLD_TAKE_MAX_LENGTH = 500;

export interface PredictionsFormInput {
  champion: string;
  sacko: string;
  topScorer: string;
  /** "" is only legal when `hasFranchise` is false — a manager with no franchise on file has no
   * "own team" to predict a win total for, and the page never renders that input for them. */
  winTotal: string;
  boldTake: string;
}

export interface PredictionsFormValue {
  champion: number;
  sacko: number;
  topScorer: number;
  /** Null exactly when the manager has no franchise on file — the category is SKIPPED, not
   * defaulted to 0 (a fabricated prediction nobody made). */
  winTotal: number | null;
  boldTake: string;
}

export interface PredictionsValidationOpts {
  /** Real, currently-active franchise ids — champion/sacko/top_scorer must resolve to one of
   * these (src/server/queries/predictions.ts's getActiveFranchises). */
  activeFranchiseIds: Set<number>;
  hasFranchise: boolean;
  winTotalMax: number;
}

function parseFranchisePick(raw: string, label: string, activeFranchiseIds: Set<number>): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: `Pick a ${label}.` };
  const id = Number(trimmed);
  if (!Number.isInteger(id) || !activeFranchiseIds.has(id)) return { ok: false, error: `That's not a real franchise for ${label}.` };
  return { ok: true, value: id };
}

/**
 * Shape-only validation, one error at a time (first failure wins — same convention as
 * src/features/polls/validation.ts's validatePollForm): franchise picks must resolve to a REAL
 * active franchise id, win total is a whole number in [0, winTotalMax] (required unless the
 * manager has no franchise, in which case it's skipped entirely), bold take is non-empty text
 * capped at BOLD_TAKE_MAX_LENGTH.
 */
export function validatePredictionsForm(input: PredictionsFormInput, opts: PredictionsValidationOpts): ValidationResult<PredictionsFormValue> {
  const champion = parseFranchisePick(input.champion, "champion", opts.activeFranchiseIds);
  if (!champion.ok) return champion;

  const sacko = parseFranchisePick(input.sacko, "sacko", opts.activeFranchiseIds);
  if (!sacko.ok) return sacko;

  const topScorer = parseFranchisePick(input.topScorer, "top scorer", opts.activeFranchiseIds);
  if (!topScorer.ok) return topScorer;

  let winTotal: number | null = null;
  if (opts.hasFranchise) {
    const trimmed = input.winTotal.trim();
    if (trimmed.length === 0) return { ok: false, error: "Give your own team a win total." };
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > opts.winTotalMax) {
      return { ok: false, error: `Win total has to be a whole number between 0 and ${opts.winTotalMax}.` };
    }
    winTotal = n;
  }

  const boldTake = input.boldTake.trim();
  if (boldTake.length === 0) return { ok: false, error: "Give us a bold take." };
  if (boldTake.length > BOLD_TAKE_MAX_LENGTH) return { ok: false, error: `Keep the bold take under ${BOLD_TAKE_MAX_LENGTH} characters.` };

  return { ok: true, value: { champion: champion.value, sacko: sacko.value, topScorer: topScorer.value, winTotal, boldTake } };
}

export interface PredictionRow {
  category: PredictionCategory;
  subject: string;
}

/** Maps a validated form value to the rows the Server Action writes — always champion/sacko/
 * top_scorer/bold_take, plus win_total only when the manager has a franchise (winTotal !== null).
 * Pure — unit-tested directly. */
export function toPredictionRows(value: PredictionsFormValue): PredictionRow[] {
  const rows: PredictionRow[] = [
    { category: "champion", subject: String(value.champion) },
    { category: "sacko", subject: String(value.sacko) },
    { category: "top_scorer", subject: String(value.topScorer) },
    { category: "bold_take", subject: value.boldTake },
  ];
  if (value.winTotal !== null) rows.push({ category: "win_total", subject: String(value.winTotal) });
  return rows;
}
