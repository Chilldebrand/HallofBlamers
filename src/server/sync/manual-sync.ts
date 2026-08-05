/**
 * Sync run coordination (Task 33 audit catch + fix round 1, findings 2/3): the manual "Sync now"
 * request signal, PLUS the shared "don't stack a second run" guard every sync tier now checks
 * (`isAnySyncRunning`) and the crash-recovery pass that keeps that guard from deadlocking forever
 * (`recoverStaleSyncRuns`). Per AGENTS.md, "Web and worker are separate processes sharing the
 * SQLite file; they communicate only through the database... Worker is the sole writer of
 * ESPN-derived data" — a load-bearing rule marked "do not violate". The /admin Server Action
 * therefore does NOT call `runSyncTier` itself (that would make the WEB process fetch/normalize/
 * write ESPN-derived data, exactly what that rule forbids); it only writes a request flag here,
 * through the one channel the two processes already share. The worker polls for that flag (see
 * `worker/index.ts`'s `runManualSyncTick`) and runs the SAME pipeline (`run-tier.ts`'s
 * `runSyncTier`) tagged `tier: "manual"` so it's visually distinguishable from an automatic
 * hourly/daily/live tick in the admin Sync Status table.
 *
 * FIX ROUND 1, finding 2 (guard was one-directional): the original `isAnySyncRunning` check only
 * ever guarded `runManualSyncTick` — `runHourlyTick`/`runDailyTick`/`runLiveTick` never checked
 * anything before calling `runSyncTier`, so any of them could start concurrently with an in-flight
 * manual run (most likely exactly during a live window, when a live tick fires every 2 minutes).
 * `isAnySyncRunning` is now exported and checked by EVERY tick entry point in `worker/index.ts`,
 * symmetrically — see that file's tick functions.
 *
 * FIX ROUND 1, finding 3 (no stale/crash recovery): since 'running' is now a hard blocking gate
 * for every tier, a `sync_runs` row stuck at status='running' forever (the worker process was
 * killed/crashed/OOM'd mid-tick, so the normal end-of-run status update in `run-tier.ts` never
 * ran) would otherwise permanently disable every sync tier, including manual. Two complementary
 * pieces, designed together so neither can deadlock the other:
 *   1. `isAnySyncRunning` itself only ever treats a 'running' row as blocking while it's YOUNGER
 *      than `STALE_RUNNING_THRESHOLD_MS` — this alone is what actually prevents a permanent
 *      deadlock: even if the worker never restarts and recovery (below) never runs, every guard
 *      check naturally stops treating a stuck row as blocking once it's old enough, self-healing
 *      with no explicit cleanup required.
 *   2. `recoverStaleSyncRuns`, called once at worker startup before any cron job is registered,
 *      explicitly marks any already-stale 'running' row 'failed' — a cleanup/observability nicety
 *      (so the admin Sync Status table shows an honest terminal status instead of an eternally
 *      misleading "running"), not the actual deadlock-prevention mechanism (that's #1).
 */
import { and, eq, gt, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { appSettings, syncRuns } from "../db/schema";

export const MANUAL_SYNC_REQUEST_KEY = "manual_sync_requested_at";

/**
 * How long a 'running' sync_runs row is trusted before being treated as stale (fix round 1,
 * finding 3). 15 minutes: comfortably longer than any real tier's actual duration against this
 * league's real data size (an hourly tick's single-period fetch, or even a daily tick's full
 * ~14-period refetch plus a stat rebuild, finishes in well under a minute in practice — see
 * run-tier.ts's own politeness delays, ~2.5s per request against a handful of requests per tick),
 * while still being short enough that a genuinely stuck worker doesn't block "Sync now" for hours.
 */
export const STALE_RUNNING_THRESHOLD_MS = 15 * 60 * 1000;

export interface ManualSyncRequestState {
  /** Set (ISO timestamp) while a request is waiting for the worker to pick it up; null once the
   * worker has cleared it (picked up, or the caller never requested one). */
  requestedAt: Date | null;
  /** True while ANY sync_runs row (any tier) is genuinely in flight — the "don't stack a second
   * run" guard the brief asks for ("polite... disable while one is in flight via sync_runs
   * state"), now shared symmetrically by every tier (fix round 1, finding 2). */
  anySyncRunning: boolean;
  /** Convenience for the admin page's disabled-button rendering: true if EITHER of the above. */
  pending: boolean;
}

/**
 * True while a sync_runs row is 'running' AND started recently enough to trust (see
 * `STALE_RUNNING_THRESHOLD_MS`) — the shared guard every tick entry point in `worker/index.ts`
 * checks before calling `runSyncTier` (fix round 1, finding 2), and what `getManualSyncRequestState`
 * uses for the admin button's disabled state. A 'running' row older than the threshold is treated
 * exactly as though nothing is running — see the module docstring's "designed together" note.
 */
export function isAnySyncRunning(db: Db, now: Date = new Date()): boolean {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_THRESHOLD_MS);
  const row = db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(eq(syncRuns.status, "running"), gt(syncRuns.startedAt, cutoff)))
    .limit(1)
    .get();
  return row !== undefined;
}

/** Reads the current request/in-flight state — drives both the admin page's rendering and the
 * guard `requestManualSync` itself uses before writing a new request. */
export function getManualSyncRequestState(db: Db, now: Date = new Date()): ManualSyncRequestState {
  const row = db.select({ valueJson: appSettings.valueJson }).from(appSettings).where(eq(appSettings.key, MANUAL_SYNC_REQUEST_KEY)).get();
  const requestedAt = typeof row?.valueJson === "string" ? new Date(row.valueJson) : null;
  const anySyncRunning = isAnySyncRunning(db, now);
  return { requestedAt, anySyncRunning, pending: requestedAt !== null || anySyncRunning };
}

export type RequestManualSyncResult = { ok: true } | { ok: false; message: string };

/** Commissioner-gated caller (the Server Action) writes the request flag — never calls the ESPN
 * pipeline itself (see module docstring). Refuses politely (no write at all) if a request is
 * already pending or ANY sync is currently running, rather than queuing a second one. */
export function requestManualSync(db: Db, now: Date = new Date()): RequestManualSyncResult {
  const state = getManualSyncRequestState(db, now);
  if (state.pending) {
    return { ok: false, message: "A sync is already running or queued — it'll show up in the table below within a minute." };
  }

  db.insert(appSettings)
    .values({ key: MANUAL_SYNC_REQUEST_KEY, valueJson: now.toISOString(), updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: now.toISOString(), updatedAt: now } })
    .run();

  return { ok: true };
}

/** Clears the request flag — called by the worker once it has picked up (or deliberately
 * deferred) a pending request, so the same request is never replayed on a later tick. */
export function clearManualSyncRequest(db: Db): void {
  db.delete(appSettings).where(eq(appSettings.key, MANUAL_SYNC_REQUEST_KEY)).run();
}

export interface StaleSyncRecoveryResult {
  /** Rows marked 'failed' by this call — 0 is the overwhelmingly common case (a clean start/
   * restart with nothing stuck). */
  recovered: number;
}

/**
 * Crash recovery (fix round 1, finding 3) — call ONCE at worker startup, before any cron job is
 * registered (see `worker/index.ts`'s `main()`). A 'running' row can be left behind if the worker
 * process dies mid-tick (killed, OOM, host reboot): `run-tier.ts`'s `runSyncTier` only updates a
 * run's status at the END of its own (synchronous, in-process) execution, so a process that never
 * gets that far leaves the row exactly as it inserted it — status='running' forever, with nothing
 * else in the system able to notice. Only touches rows already stale by
 * `STALE_RUNNING_THRESHOLD_MS`, so a genuinely-in-progress run from THIS same just-started process
 * (shouldn't be possible — this runs before any tick can start — but defensive regardless) is
 * never touched.
 */
export function recoverStaleSyncRuns(db: Db, now: Date = new Date()): StaleSyncRecoveryResult {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_THRESHOLD_MS);
  const staleRows = db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(eq(syncRuns.status, "running"), lte(syncRuns.startedAt, cutoff)))
    .all();
  if (staleRows.length === 0) return { recovered: 0 };

  for (const row of staleRows) {
    db.update(syncRuns)
      .set({ status: "failed", finishedAt: now, errorText: "Worker restarted while this run was in progress; marked failed during startup recovery." })
      .where(eq(syncRuns.id, row.id))
      .run();
  }
  return { recovered: staleRows.length };
}
