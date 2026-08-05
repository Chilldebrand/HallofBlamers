import { and, eq } from "drizzle-orm";
import type { FranchiseNameFlags } from "@/components/league/FranchiseName";
import type { Db } from "../db/client";
import { beltReigns, franchises, managers, seasonStats, seasons } from "../db/schema";

// ---------------------------------------------------------------------------
// Identity flags (docs/design/redesign-2026-08/README.md, "Identity system")
// ---------------------------------------------------------------------------

export interface IdentityFlags {
  championFranchiseId: number | null;
  beltHolderFranchiseId: number | null;
  sackoFranchiseId: number | null;
  viewerFranchiseId: number | null;
}

export interface SeasonStatusRow {
  season: number;
  status: string;
}

/**
 * Newest season with `status === "complete"`, or null if the league has
 * never finished one. Pure — unit-tested directly, including the
 * no-complete-season edge (a brand-new league, or one where the only rows
 * are "upcoming"/"active").
 */
export function computeLatestCompleteSeason(rows: SeasonStatusRow[]): number | null {
  let latest: number | null = null;
  for (const r of rows) {
    if (r.status === "complete" && (latest === null || r.season > latest)) latest = r.season;
  }
  return latest;
}

/**
 * Resolves the four identity-system flags FranchiseName renders across the
 * site. Each resolves independently:
 *  - champion/sacko come from the latest COMPLETE season's season_stats row
 *    — null/null when the league has never finished a season, rather than
 *    fabricating a "champion" out of an in-progress one.
 *  - belt holder comes from belt_reigns.is_current, independent of season
 *    completeness (a belt can change hands mid-season).
 *  - viewer comes from the signed-in manager's own franchise_id (null when
 *    not signed in, or a manager row with no franchise attached).
 * Takes `db` directly (not the getDb() singleton other query files use) so
 * callers — including this file's own tests — can point it at an isolated
 * fixture DB without env-var indirection, per the Task 21 brief's spec for
 * this function.
 */
export function getIdentityFlags(db: Db, viewerManagerId: number | null): IdentityFlags {
  const seasonRows = db.select({ season: seasons.season, status: seasons.status }).from(seasons).all();
  const latestComplete = computeLatestCompleteSeason(seasonRows);

  let championFranchiseId: number | null = null;
  let sackoFranchiseId: number | null = null;
  if (latestComplete !== null) {
    const champRow = db
      .select({ franchiseId: seasonStats.franchiseId })
      .from(seasonStats)
      .where(and(eq(seasonStats.season, latestComplete), eq(seasonStats.champion, true)))
      .get();
    championFranchiseId = champRow?.franchiseId ?? null;

    const sackoRow = db
      .select({ franchiseId: seasonStats.franchiseId })
      .from(seasonStats)
      .where(and(eq(seasonStats.season, latestComplete), eq(seasonStats.sacko, true)))
      .get();
    sackoFranchiseId = sackoRow?.franchiseId ?? null;
  }

  const beltRow = db.select({ franchiseId: beltReigns.franchiseId }).from(beltReigns).where(eq(beltReigns.isCurrent, true)).get();
  const beltHolderFranchiseId = beltRow?.franchiseId ?? null;

  let viewerFranchiseId: number | null = null;
  if (viewerManagerId !== null) {
    const managerRow = db.select({ franchiseId: managers.franchiseId }).from(managers).where(eq(managers.id, viewerManagerId)).get();
    viewerFranchiseId = managerRow?.franchiseId ?? null;
  }

  return { championFranchiseId, beltHolderFranchiseId, sackoFranchiseId, viewerFranchiseId };
}

/** Per-franchise booleans for FranchiseName, given the league-wide flags — the shape most
 * callers actually want (one franchise id in, four booleans out). Pure. */
export function resolveFranchiseFlags(flags: IdentityFlags, franchiseId: number): FranchiseNameFlags {
  return {
    isChampion: flags.championFranchiseId === franchiseId,
    holdsBelt: flags.beltHolderFranchiseId === franchiseId,
    isSacko: flags.sackoFranchiseId === franchiseId,
    isViewer: flags.viewerFranchiseId === franchiseId,
  };
}

// ---------------------------------------------------------------------------
// Nav's "<manager> · <franchise>" display (Shell, README)
// ---------------------------------------------------------------------------

export interface ViewerDisplay {
  managerName: string;
  franchiseName: string | null;
}

/** Resolves the signed-in manager's own franchise name for the nav's right slot. Null
 * franchiseName covers a manager row with no franchise attached yet. */
export function getViewerDisplay(db: Db, manager: { name: string; franchiseId: number | null }): ViewerDisplay {
  if (manager.franchiseId === null) return { managerName: manager.name, franchiseName: null };
  const row = db.select({ name: franchises.canonicalName }).from(franchises).where(eq(franchises.id, manager.franchiseId)).get();
  return { managerName: manager.name, franchiseName: row?.name ?? null };
}
