import type { WeekFacts } from "./facts";

/**
 * A lightweight sanity pass over a generated (or hand-edited) recap draft: every number and every
 * capitalized multi-word name it contains SHOULD trace back to the facts JSON that was fed to the
 * model. This never rejects a draft — it only surfaces warnings for the commissioner's review
 * panel (deliverable 5's "validation warnings panel"). False positives (a markdown heading that
 * happens to look like a name, a number that's a coincidental match to something structural) are
 * expected and acceptable; the cost of a false positive is a warning a human dismisses, the cost
 * of a false negative is a fabricated stat nobody catches.
 */

export interface RecapValidationWarning {
  type: "number" | "name";
  /** The exact substring from the draft that triggered the warning. */
  text: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Numbers that are structurally expected in recap prose without appearing anywhere in the facts
 * payload verbatim: calendar years, and small integers doing double duty as week numbers,
 * standings rankings (this is a 12-team league), or written-out ordinals ("3rd"). 25 comfortably
 * covers the longest realistic playoff week number; rankings never exceed the team count (12).
 */
const SMALL_INTEGER_WHITELIST_MAX = 25;

function isWhitelistedNumber(n: number): boolean {
  if (Number.isInteger(n) && n >= 1 && n <= SMALL_INTEGER_WHITELIST_MAX) return true;
  if (Number.isInteger(n) && n >= 1990 && n <= 2099) return true;
  return false;
}

// Negative lookbehind on the sign so "4-1" (a W-L record, hyphen with no surrounding space)
// parses as [4, 1], not [4, -1] — a `-` immediately after a digit is a separator, not a sign.
// A genuine negative number (preceded by whitespace/start-of-string/punctuation) still matches.
const NUMBER_PATTERN = /(?<!\d)-?\d+(?:\.\d+)?/g;

function extractNumbers(text: string): number[] {
  const matches = text.match(NUMBER_PATTERN) ?? [];
  return matches.map(Number).filter((n) => Number.isFinite(n));
}

/**
 * Recursively collects every number a draft is allowed to cite: (1) `number`-typed fields
 * (scores, margins, win/loss counts, record values, ids — deliberately permissive, since picking
 * up id fields only makes the check MORE lenient) AND (2) numbers embedded inside STRING-valued
 * fields (fix round 1, I1b) — e.g. a context note's "previously 142.6, 2020" or a belt note's
 * "63rd reign" already quote real numbers verbatim in prose the facts payload itself wrote; a
 * model restating one of those isn't a fabrication. Guards against non-plain-object values
 * (`null`, dates, etc.) the same way `collectFactsNames` below does, for the same partial/
 * malformed-`factsJson` reason (fix round 1, I2).
 */
function collectFactsNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") {
    out.push(value);
  } else if (typeof value === "string") {
    out.push(...extractNumbers(value));
  } else if (Array.isArray(value)) {
    for (const v of value) collectFactsNumbers(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectFactsNumbers(v, out);
  }
  return out;
}

const NUMBER_TOLERANCE = 0.1;

function numberIsSupported(n: number, factsNumbers: number[]): boolean {
  return factsNumbers.some((f) => Math.abs(f - n) <= NUMBER_TOLERANCE);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Two-or-more consecutive Capitalized words — the shape of a person/team name in prose. Uses
 * horizontal whitespace only between words (not `\s+`) so a heading is never merged with the
 * capitalized-starting sentence that immediately follows it on the next line. */
const NAME_PATTERN = /\b[A-Z][a-zA-Z'.-]*(?:[ \t]+[A-Z][a-zA-Z'.-]*)+\b/g;

function extractCapitalizedNames(markdown: string): string[] {
  return markdown.match(NAME_PATTERN) ?? [];
}

/**
 * Common recap section headings the guardrail prompt and the fallback renderer both produce —
 * whitelisted so the structural skeleton of every recap doesn't itself generate warning noise.
 * NOT a list of real league names; a name that happens to collide with one of these is vanishingly
 * unlikely and, even then, only costs a missed warning on an already-permissive tool.
 */
const STRUCTURAL_HEADING_WHITELIST = new Set([
  "Week Recap",
  "Standings",
  "Matchups",
  "Top Performers",
  "Superlatives",
  "Top Score",
  "Low Score",
  "Closest Game",
  "Biggest Blowout",
  "Bench Disaster",
  "Luckiest Win",
  "Best Efficiency",
  "Record Book",
  "Records Broken",
  "Records Approached",
  "Notable Adds",
  "Transactions",
  "Playoff Picture",
  "Commissioner Notes",
]);

/**
 * Every team/franchise/player name that legitimately appears in the facts JSON. Every collection
 * uses `?? []` / optional chaining (fix round 1, I2) — `factsJson` is stored as an `unknown`-typed
 * JSON column and can legitimately be PARTIAL (e.g. `{meta: {...}}` only, the exact shape
 * `src/features/recaps/__tests__/actions.test.ts`'s own fixture uses) — a bare `facts.standings`
 * access on a row like that threw `TypeError: standings is not iterable` and 500'd the admin
 * detail page (`admin/recaps/[id]/page.tsx`) before this fix.
 */
function collectFactsNames(facts: Partial<WeekFacts> | null | undefined): Set<string> {
  const names = new Set<string>();
  for (const s of facts?.standings ?? []) names.add(s.franchiseName);
  for (const m of facts?.matchups ?? []) {
    names.add(m.home.franchiseName);
    if (m.away) names.add(m.away.franchiseName);
    for (const p of m.topPerformers ?? []) {
      names.add(p.playerName);
      names.add(p.franchiseName);
    }
    if (m.belt) {
      names.add(m.belt.holderName);
      names.add(m.belt.challengerName);
    }
  }
  const sup = facts?.superlatives;
  if (sup?.topScore) names.add(sup.topScore.franchiseName);
  if (sup?.lowScore) names.add(sup.lowScore.franchiseName);
  if (sup?.closest) {
    names.add(sup.closest.winnerName);
    names.add(sup.closest.loserName);
  }
  if (sup?.blowout) {
    names.add(sup.blowout.winnerName);
    names.add(sup.blowout.loserName);
  }
  if (sup?.benchDisaster) names.add(sup.benchDisaster.franchiseName);
  if (sup?.luckiestWin) names.add(sup.luckiestWin.franchiseName);
  if (sup?.bestEfficiency) names.add(sup.bestEfficiency.franchiseName);
  for (const r of facts?.records?.broken ?? []) {
    if (r.franchiseName) names.add(r.franchiseName);
  }
  for (const r of facts?.records?.approached ?? []) names.add(r.franchiseName);
  for (const t of facts?.transactions?.trades ?? []) {
    for (const side of t.franchises ?? []) {
      names.add(side.franchiseName);
      for (const p of side.sent ?? []) names.add(p);
      for (const p of side.received ?? []) names.add(p);
    }
  }
  for (const a of facts?.transactions?.notableAdds ?? []) {
    names.add(a.franchiseName);
    names.add(a.playerName);
  }
  return names;
}

/**
 * Masks every EXACT, already-verified facts name out of `text` (replaced with same-length spaces,
 * longest names first so a short name that's a substring of a longer one never partially masks it
 * first) before number extraction runs over the result. Fix round 1, I1a: a franchise literally
 * named "Bonnie Blue 42" carries a digit inside a legitimate name — `extractNumbers` has no
 * concept of "inside a name" on its own, so without this the "42" gets independently flagged as an
 * unsupported number even though the whole name is fine. Masking only ever REMOVES characters a
 * verified name occupies; it never invents or hides anything the number pass would otherwise need
 * to see.
 */
function maskKnownNames(text: string, names: Set<string>): string {
  const sorted = [...names].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  let masked = text;
  for (const name of sorted) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    masked = masked.replace(new RegExp(escaped, "g"), (match) => " ".repeat(match.length));
  }
  return masked;
}

function nameIsSupported(name: string, factsNames: Set<string>, allowedHeadings: Set<string>): boolean {
  if (factsNames.has(name)) return true;
  if (allowedHeadings.has(name)) return true;
  // A multi-word name can appear as a SUBSTRING of a longer facts name (e.g. draft prose
  // shortens "The Hall of Blamers Ballers" to "Blue Bell") or vice versa — check both directions
  // before flagging.
  for (const factsName of factsNames) {
    if (factsName.includes(name) || name.includes(factsName)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Structural completeness
// ---------------------------------------------------------------------------

/**
 * True when `facts` has the top-level shape `validateRecap` actually needs to say anything
 * meaningful — `standings`/`matchups` arrays and a `superlatives` object all present.
 *
 * Fix round 2, I2 gap: `collectFactsNames`/`collectFactsNumbers` are defensive (fix round 1) and
 * never throw on a partial object — but that means a `{meta}`-only row silently produces ZERO
 * warnings, not because the draft was checked and found clean, but because there was nothing to
 * check against. The admin page was rendering that as "No warnings — every number and name traced
 * back to the facts," which is false confidence, not honesty. Callers MUST check this FIRST and
 * show an explicit "warnings unavailable" state instead of trusting an all-clear that was never
 * earned. This is a plain boolean, not a TypeScript type predicate — passing this check narrows
 * confidence, not the full `WeekFacts` shape (records/transactions/etc. can still be absent
 * without failing it, since the collectors handle those defensively regardless).
 */
export function isCompleteWeekFacts(facts: Partial<WeekFacts> | null | undefined): boolean {
  if (!facts || typeof facts !== "object") return false;
  return Array.isArray(facts.standings) && Array.isArray(facts.matchups) && typeof facts.superlatives === "object" && facts.superlatives !== null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validateRecap(markdown: string, facts: Partial<WeekFacts> | null | undefined): RecapValidationWarning[] {
  const warnings: RecapValidationWarning[] = [];
  const factsNames = collectFactsNames(facts);

  // Mask verified name spans BEFORE scanning for numbers (fix round 1, I1a) — a digit inside a
  // legitimate name (e.g. "Bonnie Blue 42") must never be independently flagged.
  const factsNumbers = collectFactsNumbers(facts);
  const maskedForNumbers = maskKnownNames(markdown, factsNames);
  for (const n of extractNumbers(maskedForNumbers)) {
    if (isWhitelistedNumber(n)) continue;
    if (numberIsSupported(n, factsNumbers)) continue;
    warnings.push({ type: "number", text: String(n), detail: `${n} does not match any number in the facts JSON (±${NUMBER_TOLERANCE}).` });
  }

  const seenNames = new Set<string>();
  for (const name of extractCapitalizedNames(markdown)) {
    if (seenNames.has(name)) continue; // one warning per distinct name, not per occurrence
    seenNames.add(name);
    if (nameIsSupported(name, factsNames, STRUCTURAL_HEADING_WHITELIST)) continue;
    warnings.push({ type: "name", text: name, detail: `"${name}" does not match any team, franchise, or player name in the facts JSON.` });
  }

  return warnings;
}
