/**
 * Pure form-input validation for the pick'em Server Actions — kept out of actions.ts for the same
 * reason as src/features/admin/validation.ts: every export of a `"use server"` module must itself
 * be an async Server Action, so ordinary synchronous functions live here, unit-testable directly
 * with no DB/cookies mocking.
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface PickableMatchupOption {
  matchupId: number;
  homeFranchiseId: number;
  awayFranchiseId: number;
}

export interface PickSubmissionValue {
  matchupId: number;
  pickedFranchiseId: number;
}

/**
 * Validates a submitted set of picks against the CURRENT week's pickable matchups (brief: "each
 * manager picks a winner for EVERY matchup of the current scoring period" — partial submissions
 * are rejected, not silently accepted as "picked some"). Every pickable matchup must have exactly
 * one selection, and it must be one of that matchup's own two real sides — a submission naming
 * neither the home nor away franchise id (tampered form, stale matchup, etc.) fails the same way
 * as a missing one. Never trusts `submitted` beyond that: matchupIds outside `pickableMatchups`
 * are simply ignored, never validated or written.
 */
export function validatePickSubmission(
  submitted: Map<number, number | undefined>,
  pickableMatchups: PickableMatchupOption[],
): ValidationResult<PickSubmissionValue[]> {
  if (pickableMatchups.length === 0) {
    return { ok: false, error: "There's nothing to pick right now." };
  }

  const value: PickSubmissionValue[] = [];
  for (const m of pickableMatchups) {
    const picked = submitted.get(m.matchupId);
    if (picked !== m.homeFranchiseId && picked !== m.awayFranchiseId) {
      return { ok: false, error: "Pick a winner for every game before submitting." };
    }
    value.push({ matchupId: m.matchupId, pickedFranchiseId: picked });
  }
  return { ok: true, value };
}
