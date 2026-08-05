/**
 * Pure form-input validation for the admin Server Actions. Kept out of
 * actions.ts because every export of a `"use server"` module must itself be
 * an async Server Action — these are ordinary synchronous functions, and
 * being pure means they're unit-testable directly with no DB/cookies mocking.
 */

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** "YYYY-MM-DD", and a genuine calendar date (rejects e.g. 2026-02-30, which Date() silently rolls into March). */
export function validateDraftDate(input: string): ValidationResult<string> {
  const trimmed = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { ok: false, error: "Enter the draft date as YYYY-MM-DD." };
  }
  const [year, month, day] = trimmed.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return { ok: false, error: `${trimmed} is not a real calendar date.` };
  }
  return { ok: true, value: trimmed };
}

export type ManagerRole = "commissioner" | "manager";

export interface ManagerFormInput {
  name: string;
  role: string;
  /** Raw <select> value: "" means no franchise, otherwise a franchise id as a string. */
  franchiseId: string;
}

export interface ManagerFormValue {
  name: string;
  role: ManagerRole;
  franchiseId: number | null;
}

/**
 * Shape-only validation (name non-empty, role is a real enum value,
 * franchiseId is either empty or a parseable integer). Does NOT check that
 * franchiseId actually references a real franchise — that requires the DB,
 * so the action does that check itself after this passes.
 */
export function validateManagerForm(input: ManagerFormInput): ValidationResult<ManagerFormValue> {
  const name = input.name.trim();
  if (name.length === 0) {
    return { ok: false, error: "Name is required." };
  }
  if (input.role !== "commissioner" && input.role !== "manager") {
    return { ok: false, error: "Role must be commissioner or manager." };
  }

  const rawFranchiseId = input.franchiseId.trim();
  if (rawFranchiseId === "") {
    return { ok: true, value: { name, role: input.role, franchiseId: null } };
  }
  const franchiseId = Number(rawFranchiseId);
  if (!Number.isInteger(franchiseId)) {
    return { ok: false, error: "Franchise selection is invalid." };
  }
  return { ok: true, value: { name, role: input.role, franchiseId } };
}

export interface EspnCookieFormValue {
  espnS2: string;
  swid: string;
}

const SWID_PATTERN = /^\{[0-9A-Fa-f-]+\}$/;
/** ESPN's real espn_s2 values run several hundred characters; 50 is a loose "plausibly real,
 * not a stray fragment" floor, not an attempt to validate the exact format. */
const MIN_ESPN_S2_LENGTH = 50;

/**
 * Loose shape validation ONLY — SWID must be wrapped in the curly braces ESPN issues it with;
 * espn_s2 just needs to be long enough to plausibly be real. Deliberately does NOT trim, decode,
 * or otherwise transform either field: both are returned byte-for-byte identical to what was
 * submitted. Never "clean up" these values — see src/server/sync/credentials.ts's docstring for
 * why (ESPN issues SWID WITH braces and espn_s2 URL-encoded; `EspnClient` interpolates both
 * verbatim into the `Cookie` header, so stripping/decoding here would silently break auth rather
 * than fix anything). A malformed paste should fail this check loudly, not get silently "fixed."
 */
export function validateEspnCookiesForm(input: { espnS2: string; swid: string }): ValidationResult<EspnCookieFormValue> {
  if (!SWID_PATTERN.test(input.swid)) {
    return { ok: false, error: "SWID must look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} — including the curly braces, copied exactly as shown." };
  }
  if (input.espnS2.length <= MIN_ESPN_S2_LENGTH) {
    return { ok: false, error: "espn_s2 looks too short to be a real ESPN cookie value — copy the whole thing." };
  }
  return { ok: true, value: { espnS2: input.espnS2, swid: input.swid } };
}
