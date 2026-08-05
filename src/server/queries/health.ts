/**
 * Backing query for `/api/health` (Task 15) — the unauthenticated liveness/
 * diagnostic endpoint the `web` service's Docker healthcheck and `ops/
 * status.sh` both hit. See AGENTS.md: DB reads live in server-side query
 * functions, routes stay thin.
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { statBuilds, syncRuns } from "../db/schema";

/**
 * Warn threshold for "last sync looks stale." The hourly tier runs every
 * hour; 3x that interval gives slack for one or two missed/failed ticks
 * before flagging staleness — an operator glancing at /api/health or
 * status.sh shouldn't get a false alarm from one transient ESPN hiccup.
 */
export const SYNC_STALE_WARN_MINUTES = 180;

export interface HealthLastSync {
  tier: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  ageMinutes: number;
  stale: boolean;
}

export interface HealthStatus {
  /** DB opened and could be queried — the process's own liveness signal. Does NOT reflect sync
   * staleness (see `lastSync.stale`): restarting the web container can't fix a stale worker, so
   * a stale sync must never make Docker think restarting `web` is the fix. */
  ok: boolean;
  /** Null only on a genuinely fresh install with zero sync_runs rows ever recorded. */
  lastSync: HealthLastSync | null;
  /** Latest successful (`status = 'ok'`) stat_builds.id, or null if none has ever succeeded. */
  buildId: number | null;
}

export function getHealthStatus(now: Date = new Date()): HealthStatus {
  const db = getDb();

  const lastSyncRow = db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(1).get();
  const lastBuildRow = db
    .select({ id: statBuilds.id })
    .from(statBuilds)
    .where(eq(statBuilds.status, "ok"))
    .orderBy(desc(statBuilds.id))
    .limit(1)
    .get();

  let lastSync: HealthLastSync | null = null;
  if (lastSyncRow) {
    const ageMinutes = Math.max(0, Math.round((now.getTime() - lastSyncRow.startedAt.getTime()) / 60_000));
    lastSync = {
      tier: lastSyncRow.tier,
      status: lastSyncRow.status,
      startedAt: lastSyncRow.startedAt.toISOString(),
      finishedAt: lastSyncRow.finishedAt ? lastSyncRow.finishedAt.toISOString() : null,
      ageMinutes,
      stale: ageMinutes > SYNC_STALE_WARN_MINUTES,
    };
  }

  return { ok: true, lastSync, buildId: lastBuildRow?.id ?? null };
}
