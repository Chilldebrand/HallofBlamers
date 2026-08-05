/**
 * Snapshot fallback query for `GET /api/live/snapshot` (Task 25) — the polling-fallback contract
 * for a client that opens `/api/live` (the SSE stream) for an INITIAL paint before/instead of
 * subscribing, or as a fallback when EventSource isn't viable. Reuses the SAME "current week" +
 * matchup-row queries the week hub page already uses (`getLatestMatchupWeek`/`getWeekMatchupRows`,
 * `matchups.ts`) so the two views of "this week's scores" can never drift apart from each other.
 */
import { desc } from "drizzle-orm";
import { getDb } from "../db/client";
import { events } from "../db/schema";
import { getLatestMatchupWeek, getWeekMatchupRows, type WeekMatchupRow } from "./matchups";

export interface LiveSnapshot {
  season: number;
  week: number;
  matchups: WeekMatchupRow[];
  /** The highest `events.id` currently recorded, or null when the table is empty — a client
   * opening `/api/live` next can pass this straight through as `Last-Event-ID` to resume without
   * re-receiving anything this snapshot already reflects. */
  lastEventId: number | null;
}

/** Null only when there are no matchups anywhere in the DB yet (a brand-new, unpopulated league) —
 * mirrors `getLatestMatchupWeek`'s own null case, never fabricated. */
export function getLiveSnapshot(): LiveSnapshot | null {
  const target = getLatestMatchupWeek();
  if (!target) return null;

  const db = getDb();
  const lastEventRow = db.select({ id: events.id }).from(events).orderBy(desc(events.id)).limit(1).get();

  return {
    season: target.season,
    week: target.week,
    matchups: getWeekMatchupRows(target.season, target.week),
    lastEventId: lastEventRow?.id ?? null,
  };
}
