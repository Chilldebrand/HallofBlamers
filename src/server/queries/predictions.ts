import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { franchises, managers, predictions, seasons, type PredictionCategory } from "../db/schema";
import { isSeasonUnderway } from "../sync/run-tier";

/**
 * Preseason Predictions Time Capsule (Task 30) — read side. Every DB access for /predictions
 * lives here (AGENTS.md: "All DB reads live in server-side query functions"); the page and the
 * Server Action (src/features/predictions/actions.ts) both call into this file rather than
 * touching `predictions`/`managers`/`franchises`/`seasons` directly.
 *
 * The lock gate (`isPredictionsLocked`) and the reveal query (`getReveal`) both take `db`
 * directly (not the getDb() singleton other query files default to) — same reasoning as
 * identity.ts's getIdentityFlags: lets tests fixture "season underway" against an isolated temp
 * DB without env-var indirection. Every function here follows that same `db: Db` convention for
 * consistency within this one file.
 */

// ---------------------------------------------------------------------------
// Season targeting + lock gate
// ---------------------------------------------------------------------------

/**
 * The newest season known to the system (max `seasons.season`) — the ONE active "capsule"
 * /predictions targets. Null only for a brand-new install before backfill/normalize has ever
 * archived a season row. Once a season completes and a NEW season row appears for next year's
 * preseason, this flips forward and that new (empty) capsule opens; last season's locked-in
 * predictions remain in the table but v1 has no history browser for them — out of scope per the
 * Task 30 brief (v1 is capture + lock + reveal for the CURRENT capsule only).
 */
export function getPredictionsSeason(db: Db): number | null {
  const row = db.select({ season: seasons.season }).from(seasons).orderBy(desc(seasons.season)).limit(1).get();
  return row?.season ?? null;
}

/**
 * The authoritative lock gate — reuses `isSeasonUnderway` (src/server/sync/run-tier.ts) verbatim,
 * the SAME "has week 1 actually kicked off" signal the live sync tier uses (ESPN's own
 * `status.latestScoringPeriod` on the latest archived season-scope snapshot, not the draft date).
 * Exported so the page and the Server Action call the exact same function rather than risking two
 * notions of "locked" drifting apart.
 */
export function isPredictionsLocked(db: Db, season: number): boolean {
  return isSeasonUnderway(db, season);
}

/**
 * The regular-season win-total upper bound for a season — read from `seasons.regSeasonWeeks` (a
 * per-season SETTING, never hardcoded per AGENTS.md: "Per-season league settings are data, never
 * hardcoded"), not a bare literal 14. Real 2026 data has regSeasonWeeks=14, matching the brief's
 * "(0-14 number)" description, but a future season with a different regular-season length is
 * validated correctly without a code change. Null only if the season row itself doesn't exist
 * (shouldn't happen for whatever `getPredictionsSeason` returned).
 */
export function getWinTotalMax(db: Db, season: number): number | null {
  const row = db.select({ regSeasonWeeks: seasons.regSeasonWeeks }).from(seasons).where(eq(seasons.season, season)).get();
  return row?.regSeasonWeeks ?? null;
}

// ---------------------------------------------------------------------------
// Franchise options (for the champion/sacko/top_scorer selects + subject validation)
// ---------------------------------------------------------------------------

export interface FranchiseOption {
  id: number;
  name: string;
}

/** Active franchises only — same filter as the admin page's franchise dropdown
 * (src/features/admin/queries.ts's getFranchiseOptions), reimplemented here rather than imported
 * so src/server/queries/ doesn't reach into src/features/. */
export function getActiveFranchises(db: Db): FranchiseOption[] {
  return db
    .select({ id: franchises.id, name: franchises.canonicalName })
    .from(franchises)
    .where(eq(franchises.active, true))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// "My" predictions — always readable by the caller for their OWN managerId, pre- or post-lock.
// There is deliberately no "get another manager's individual predictions" query — the only way to
// read anyone ELSE's predictions is `getReveal`, which is itself lock-gated below. That's the
// server-side enforcement structure for "each manager sees only their own set before lock": it's
// not that callers are trusted to check first, it's that no query exists which could return
// someone else's pre-lock content at all.
// ---------------------------------------------------------------------------

export interface MyPredictionRow {
  category: PredictionCategory;
  subject: string;
}

export function getMyPredictions(db: Db, managerId: number, season: number): MyPredictionRow[] {
  return db
    .select({ category: predictions.category, subject: predictions.subject })
    .from(predictions)
    .where(and(eq(predictions.managerId, managerId), eq(predictions.season, season)))
    .all();
}

// ---------------------------------------------------------------------------
// Pre-lock "capsule seal" — names + submitted/not, ZERO content. Safe to show to everyone before
// the reveal.
// ---------------------------------------------------------------------------

export interface SubmissionStatusRow {
  managerId: number;
  name: string;
  submitted: boolean;
}

/**
 * A manager counts as "submitted" once they have at least one row for the season. In practice
 * this is the same as "submitted a complete set": the Server Action always replaces a manager's
 * entire applicable category set in one transaction (see actions.ts), so there's never a
 * half-submitted row left behind by this codebase's own write path.
 */
export function getSubmissionStatus(db: Db, season: number): SubmissionStatusRow[] {
  const allManagers = db.select({ id: managers.id, name: managers.name }).from(managers).all();
  const submittedRows = db.selectDistinct({ managerId: predictions.managerId }).from(predictions).where(eq(predictions.season, season)).all();
  const submittedSet = new Set(submittedRows.map((r) => r.managerId));
  return allManagers.map((m) => ({ managerId: m.id, name: m.name, submitted: submittedSet.has(m.id) })).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// The reveal — everyone's full set, resolved to display-ready cells. Lock-gated AT THIS FUNCTION,
// not just by the page choosing not to call it (same enforcement-at-the-query-boundary principle
// as getPollResults's anonymous-gated perVoterBreakdown in src/server/queries/polls.ts).
// ---------------------------------------------------------------------------

export type RevealCell =
  | { kind: "franchise"; category: PredictionCategory; franchiseId: number; franchiseName: string }
  | { kind: "number"; category: PredictionCategory; value: number }
  | { kind: "text"; category: PredictionCategory; value: string };

export interface RevealManagerRow {
  managerId: number;
  managerName: string;
  franchiseId: number | null;
  franchiseName: string | null;
  /** One cell per category the manager actually has a row for, in PREDICTION_CATEGORIES order —
   * see `sortCellsByCategory`. A manager with no franchise on file simply has no `win_total`
   * cell; the page renders a dash for the missing column rather than this function fabricating
   * one. */
  cells: RevealCell[];
}

const CATEGORY_ORDER = new Map<PredictionCategory, number>([
  ["champion", 0],
  ["sacko", 1],
  ["top_scorer", 2],
  ["win_total", 3],
  ["bold_take", 4],
]);

/** Pure — unit-tested directly against plain fixture cells. */
export function sortCellsByCategory(cells: RevealCell[]): RevealCell[] {
  return [...cells].sort((a, b) => (CATEGORY_ORDER.get(a.category) ?? 0) - (CATEGORY_ORDER.get(b.category) ?? 0));
}

/**
 * Resolves one raw (category, subject) row into a display-ready cell. `franchiseNameById` is
 * built from ALL franchises (not just active ones) — a franchise that goes inactive/departs
 * between prediction time and reveal time must still resolve to a real name, not "—". Pure —
 * unit-tested directly.
 */
export function toRevealCell(category: PredictionCategory, subject: string, franchiseNameById: Map<number, string>): RevealCell {
  if (category === "win_total") {
    return { kind: "number", category, value: Number(subject) };
  }
  if (category === "bold_take") {
    return { kind: "text", category, value: subject };
  }
  const franchiseId = Number(subject);
  return { kind: "franchise", category, franchiseId, franchiseName: franchiseNameById.get(franchiseId) ?? "—" };
}

/**
 * Full reveal — every manager's full prediction set for `season`. Returns `null` before lock:
 * enforced HERE, not by the page — calling this before `isPredictionsLocked(db, season)` is true
 * can never leak anyone's content, no matter what a future caller does with the return value.
 * Returns `[]` (not null) once locked if nobody predicted anything at all.
 */
export function getReveal(db: Db, season: number): RevealManagerRow[] | null {
  if (!isSeasonUnderway(db, season)) return null;

  const rows = db
    .select({ managerId: predictions.managerId, category: predictions.category, subject: predictions.subject })
    .from(predictions)
    .where(eq(predictions.season, season))
    .all();

  const allManagers = db.select({ id: managers.id, name: managers.name, franchiseId: managers.franchiseId }).from(managers).all();
  const managerById = new Map(allManagers.map((m) => [m.id, m]));

  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const franchiseNameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  const byManager = new Map<number, RevealCell[]>();
  for (const r of rows) {
    const list = byManager.get(r.managerId) ?? [];
    list.push(toRevealCell(r.category, r.subject, franchiseNameById));
    byManager.set(r.managerId, list);
  }

  return [...byManager.entries()]
    .map(([managerId, cells]) => {
      const m = managerById.get(managerId);
      const franchiseId = m?.franchiseId ?? null;
      return {
        managerId,
        managerName: m?.name ?? `Manager ${managerId}`,
        franchiseId,
        franchiseName: franchiseId !== null ? (franchiseNameById.get(franchiseId) ?? null) : null,
        cells: sortCellsByCategory(cells),
      };
    })
    .sort((a, b) => a.managerName.localeCompare(b.managerName));
}
