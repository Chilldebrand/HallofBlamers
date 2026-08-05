import { desc, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { appSettings, franchises, managers, statBuilds, syncRuns, type Manager } from "@/server/db/schema";
import { DEFAULT_DRAFT_DATE } from "@/server/queries/home";
import { getCurrentWeekLineupHoles, getCurrentWeekResolvedLineupHoles } from "@/server/queries/lineup-holes";
import { getManualSyncRequestState, type ManualSyncRequestState } from "@/server/sync/manual-sync";

export interface ManagerRow {
  id: number;
  name: string;
  role: Manager["role"];
  franchiseId: number | null;
  franchiseName: string | null;
  /**
   * Deliberately NOT `inviteToken` — the live token must never be readable from a page render
   * (fix round 1, C1: the managers table was rendering every manager's live token on every load,
   * defeating "shows the new link once"). `createdAt` is inert, non-sensitive metadata for the
   * table instead; the ONLY place a live token is ever exposed is the one-time post-action reveal
   * banner (see AdminPage's readRevealPayload / ADMIN_REVEAL_COOKIE).
   */
  createdAt: Date;
}

/** All managers, commissioners first then by name — for the admin managers table. */
export function getManagersWithFranchise(): ManagerRow[] {
  const db = getDb();
  const managerRows = db.select().from(managers).all();
  const franchiseRows = db.select({ id: franchises.id, name: franchises.canonicalName }).from(franchises).all();
  const nameById = new Map(franchiseRows.map((f) => [f.id, f.name]));

  return managerRows
    .map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      franchiseId: m.franchiseId,
      franchiseName: m.franchiseId !== null ? (nameById.get(m.franchiseId) ?? null) : null,
      createdAt: m.createdAt,
    }))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "commissioner" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/** Active franchises only — a departed franchise isn't a sensible new-manager assignment. */
export function getFranchiseOptions(): { id: number; name: string }[] {
  const db = getDb();
  return db
    .select({ id: franchises.id, name: franchises.canonicalName })
    .from(franchises)
    .where(eq(franchises.active, true))
    .all()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getCurrentDraftDate(): string {
  const db = getDb();
  const row = db.select().from(appSettings).where(eq(appSettings.key, "draft_date")).get();
  return typeof row?.valueJson === "string" ? row.valueJson : DEFAULT_DRAFT_DATE;
}

export function getRecentSyncRuns(limit = 10) {
  const db = getDb();
  return db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(limit).all();
}

export function getRecentStatBuilds(limit = 5) {
  const db = getDb();
  return db.select().from(statBuilds).orderBy(desc(statBuilds.id)).limit(limit).all();
}

export interface EspnConnectionStatus {
  /** `sync_runs.started_at` of the most recent `status = 'ok'` run — null if there's never been one. */
  lastSuccessfulSync: Date | null;
  /** True when the MOST RECENT run of any kind is `auth_failed` — drives the "cookies expired,
   * paste fresh ones" red banner. A later successful run (even a manual one) clears this. */
  latestRunIsAuthFailed: boolean;
}

export function getEspnConnectionStatus(): EspnConnectionStatus {
  const db = getDb();
  const latestOk = db.select({ startedAt: syncRuns.startedAt }).from(syncRuns).where(eq(syncRuns.status, "ok")).orderBy(desc(syncRuns.id)).limit(1).get();
  const latestRun = db.select({ status: syncRuns.status }).from(syncRuns).orderBy(desc(syncRuns.id)).limit(1).get();
  return {
    lastSuccessfulSync: latestOk?.startedAt ?? null,
    latestRunIsAuthFailed: latestRun?.status === "auth_failed",
  };
}

/** "Sync now" button state (Task 33 audit catch) — see src/server/sync/manual-sync.ts. */
export function getManualSyncStatus(): ManualSyncRequestState {
  return getManualSyncRequestState(getDb());
}

/** Who's-not-set panel (Task 33 wiring wave) — current-week unresolved lineup holes, plus this
 * week's already-resolved ones (with resolvedReason, once the who's-not-set section renders it). */
export function getWhosNotSet() {
  return { unresolved: getCurrentWeekLineupHoles(), resolved: getCurrentWeekResolvedLineupHoles() };
}
