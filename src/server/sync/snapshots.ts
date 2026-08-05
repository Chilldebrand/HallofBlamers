/**
 * Snapshot persistence — the raw archive layer described in AGENTS.md.
 *
 * Snapshots are immutable, verbatim ESPN response bodies. This module never
 * parses/interprets `payload` beyond hashing it for change detection; that is
 * intentional (see AGENTS.md and Task 4's brief — normalization is a later
 * task). Callers (the backfill CLI, and later the live/hourly/daily sync
 * tiers) are responsible for choosing `season` / `scoringPeriod` / `view`.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { snapshots, type Snapshot } from "../db/schema";

export interface StoreSnapshotParams {
  season: number;
  /** NULL for season-scope fetches (no single scoring period applies). */
  scoringPeriod: number | null;
  /** Deterministic view key — see `viewKey()`. */
  view: string;
  url: string;
  httpStatus: number;
  /** Raw ESPN response body, stored verbatim. */
  payload: string;
}

export interface StoreSnapshotResult {
  inserted: boolean;
  id: number;
}

export interface SnapshotKey {
  season: number;
  view: string;
  scoringPeriod: number | null;
}

/**
 * Builds the deterministic `snapshots.view` value for a multi-view fetch: the
 * requested views, sorted and comma-joined, independent of request order.
 * e.g. `viewKey(["mRoster", "mBoxscore", "mMatchupScore"])` ===
 * `"mBoxscore,mMatchupScore,mRoster"`.
 */
export function viewKey(views: readonly string[]): string {
  return [...views].sort().join(",");
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** `scoringPeriod` is nullable, so it needs an IS NULL branch — `eq(col, null)` is not valid SQL. */
function scoringPeriodMatches(scoringPeriod: number | null) {
  return scoringPeriod === null ? isNull(snapshots.scoringPeriod) : eq(snapshots.scoringPeriod, scoringPeriod);
}

/** True if ANY snapshot row (including superseded ones) exists for this key. */
export function hasSnapshot(db: Db, key: SnapshotKey): boolean {
  const row = db
    .select({ id: snapshots.id })
    .from(snapshots)
    .where(
      and(eq(snapshots.season, key.season), eq(snapshots.view, key.view), scoringPeriodMatches(key.scoringPeriod)),
    )
    .limit(1)
    .get();
  return row !== undefined;
}

/**
 * Archives a payload, skipping the insert if it is byte-identical to the most
 * recent NON-superseded snapshot for the same (season, view, scoringPeriod).
 * Superseded rows are ignored entirely when looking for "the most recent"
 * row to compare against, so re-activating a hash lineage after a supersede
 * always writes a fresh row rather than silently no-op'ing against history.
 */
export function storeSnapshot(db: Db, params: StoreSnapshotParams): StoreSnapshotResult {
  const payloadHash = sha256Hex(params.payload);

  const mostRecent = db
    .select({ id: snapshots.id, payloadHash: snapshots.payloadHash })
    .from(snapshots)
    .where(
      and(
        eq(snapshots.season, params.season),
        eq(snapshots.view, params.view),
        scoringPeriodMatches(params.scoringPeriod),
        eq(snapshots.superseded, false),
      ),
    )
    .orderBy(desc(snapshots.fetchedAt), desc(snapshots.id))
    .limit(1)
    .get();

  if (mostRecent && mostRecent.payloadHash === payloadHash) {
    return { inserted: false, id: mostRecent.id };
  }

  const row = db
    .insert(snapshots)
    .values({
      season: params.season,
      scoringPeriod: params.scoringPeriod,
      view: params.view,
      url: params.url,
      fetchedAt: new Date(),
      httpStatus: params.httpStatus,
      payload: params.payload,
      payloadHash,
    })
    .returning({ id: snapshots.id })
    .get();

  return { inserted: true, id: row.id };
}

/**
 * The latest NON-superseded snapshot row for (season, view, scoringPeriod),
 * or `null` if none exists. This is the read side the normalizer (Task 5)
 * builds layer-2 tables from — always the most recently archived, still-live
 * payload for a given key, never a superseded one.
 */
export function getLatestSnapshot(db: Db, key: SnapshotKey): Snapshot | null {
  const row = db
    .select()
    .from(snapshots)
    .where(
      and(
        eq(snapshots.season, key.season),
        eq(snapshots.view, key.view),
        scoringPeriodMatches(key.scoringPeriod),
        eq(snapshots.superseded, false),
      ),
    )
    .orderBy(desc(snapshots.fetchedAt), desc(snapshots.id))
    .limit(1)
    .get();
  return row ?? null;
}

/**
 * Distinct seasons that have at least one non-superseded season-scope
 * snapshot (`scoringPeriod IS NULL`) for `view`, ascending. Used to discover
 * "all seasons with snapshots" for `normalizeAll`.
 */
export function seasonsWithSnapshot(db: Db, view: string): number[] {
  const rows = db
    .selectDistinct({ season: snapshots.season })
    .from(snapshots)
    .where(and(eq(snapshots.view, view), eq(snapshots.superseded, false), isNull(snapshots.scoringPeriod)))
    .all();
  return rows.map((r) => r.season).sort((a, b) => a - b);
}

/**
 * Distinct (non-null) `scoringPeriod`s with a non-superseded snapshot for
 * (season, view), ascending. Used by the normalizer (Task 7) to discover
 * which periods have an archived per-period `mTransactions2` snapshot,
 * without assuming that range matches the roster/matchup week numbers.
 */
export function periodsWithSnapshot(db: Db, season: number, view: string): number[] {
  const rows = db
    .selectDistinct({ scoringPeriod: snapshots.scoringPeriod })
    .from(snapshots)
    .where(and(eq(snapshots.season, season), eq(snapshots.view, view), eq(snapshots.superseded, false)))
    .all();
  return rows
    .map((r) => r.scoringPeriod)
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
}
