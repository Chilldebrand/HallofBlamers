/**
 * Pure form-input validation for the polls admin Server Actions. Kept out of actions.ts because
 * every export of a `"use server"` module must itself be an async Server Action — these are
 * ordinary synchronous functions, unit-testable directly with no DB/cookies mocking. Mirrors
 * src/features/admin/validation.ts's split.
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type PollKind = "single" | "multi";

export interface PollFormInput {
  question: string;
  description: string;
  kind: string;
  anonymous: boolean;
  allowWriteIn: boolean;
  closesAt: string; // "" or "YYYY-MM-DD"
  /** Raw option label lines — one per <input>, blanks filtered before validation. */
  options: string[];
}

export interface PollFormValue {
  question: string;
  description: string | null;
  kind: PollKind;
  anonymous: boolean;
  allowWriteIn: boolean;
  closesAt: Date | null;
  options: string[];
}

/** "YYYY-MM-DD", and a genuine calendar date (rejects e.g. 2026-02-30) — same check as
 * src/features/admin/validation.ts's validateDraftDate, reused here for closesAt. */
function parseCalendarDate(input: string): Date | null {
  const trimmed = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [year, month, day] = trimmed.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return parsed;
}

/**
 * Shape-only validation: question non-empty, kind is a real enum value, options are deduped
 * (case-insensitive, matching the vote-time write-in dedupe rule) and non-empty, minimum 2
 * options UNLESS write-ins are allowed (brief: "options list — min 2 unless write-ins allowed") —
 * in that case zero explicit options is legal, since members can supply their own.
 */
export function validatePollForm(input: PollFormInput): ValidationResult<PollFormValue> {
  const question = input.question.trim();
  if (question.length === 0) return { ok: false, error: "Question is required." };

  if (input.kind !== "single" && input.kind !== "multi") {
    return { ok: false, error: "Kind must be single or multi." };
  }

  const description = input.description.trim();

  let closesAt: Date | null = null;
  if (input.closesAt.trim().length > 0) {
    closesAt = parseCalendarDate(input.closesAt);
    if (!closesAt) return { ok: false, error: `${input.closesAt} is not a real calendar date.` };
  }

  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of input.options) {
    const label = raw.trim();
    if (label.length === 0) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue; // silently dedupe rather than reject — matches vote-time dedupe leniency
    seen.add(key);
    options.push(label);
  }

  if (!input.allowWriteIn && options.length < 2) {
    return { ok: false, error: "Add at least 2 options, or enable write-ins." };
  }

  return {
    ok: true,
    value: { question, description: description.length > 0 ? description : null, kind: input.kind, anonymous: input.anonymous, allowWriteIn: input.allowWriteIn, closesAt, options },
  };
}
