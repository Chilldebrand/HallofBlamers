/**
 * Query layer for Task 20's lineup-hole detection — BACKEND ONLY (the commissioner "who's not set"
 * admin panel and any ticker surfacing ship later, per the task brief). Returns the current week's
 * still-open (unresolved) holes per franchise, sourced entirely from `events` — never re-derives
 * detection itself, so "what this shows" and "what `lineup-holes.ts`'s sync-tier integration
 * actually recorded" can never drift apart. No UI files import this yet.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { events } from "../db/schema";
import { getLatestMatchupWeek } from "./matchups";
import { LINEUP_EVENT_TYPES, resolvedDedupeKeyFor } from "../sync/lineup-holes";

export interface LineupHoleRow {
  franchiseId: number;
  franchiseName: string;
  season: number;
  week: number;
  slot: string;
  reason: "empty" | "disqualified";
  playerId: number | null;
  playerName: string | null;
  injuryStatus: string | null;
  detectedAt: Date;
}

interface LineupHolePayloadShape {
  franchiseName?: unknown;
  slot?: unknown;
  reason?: unknown;
  playerId?: unknown;
  playerName?: unknown;
  injuryStatus?: unknown;
}

function toLineupHoleRow(row: { franchiseId: number | null; season: number | null; week: number | null; payloadJson: unknown; detectedAt: Date }): LineupHoleRow | null {
  if (row.franchiseId === null || row.season === null || row.week === null) return null;
  const p = (row.payloadJson ?? {}) as LineupHolePayloadShape;
  const reason = p.reason === "empty" || p.reason === "disqualified" ? p.reason : null;
  if (reason === null) return null;

  return {
    franchiseId: row.franchiseId,
    franchiseName: typeof p.franchiseName === "string" ? p.franchiseName : `Franchise ${row.franchiseId}`,
    season: row.season,
    week: row.week,
    slot: typeof p.slot === "string" ? p.slot : "",
    reason,
    playerId: typeof p.playerId === "number" ? p.playerId : null,
    playerName: typeof p.playerName === "string" ? p.playerName : null,
    injuryStatus: typeof p.injuryStatus === "string" ? p.injuryStatus : null,
    detectedAt: row.detectedAt,
  };
}

/** Every unresolved lineup hole recorded for a specific `(season, week)`, franchise then slot then
 * reason order. Empty array means either a genuinely healthy week or that detection hasn't run yet
 * for it (e.g. preseason, or before the season's first hourly/live tick) — this query has no way to
 * distinguish the two, by design (it only reads what was already recorded, never re-derives). */
export function getLineupHolesForWeek(season: number, week: number): LineupHoleRow[] {
  const db = getDb();

  const detected = db
    .select({ franchiseId: events.franchiseId, season: events.season, week: events.week, dedupeKey: events.dedupeKey, payloadJson: events.payloadJson, detectedAt: events.detectedAt })
    .from(events)
    .where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_DETECTED), eq(events.season, season), eq(events.week, week)))
    .all();
  if (detected.length === 0) return [];

  const resolvedKeys = new Set(
    db
      .select({ dedupeKey: events.dedupeKey })
      .from(events)
      .where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_RESOLVED), eq(events.season, season), eq(events.week, week)))
      .all()
      .map((r) => r.dedupeKey),
  );

  return detected
    .filter((e) => !resolvedKeys.has(resolvedDedupeKeyFor(e.dedupeKey)))
    .map(toLineupHoleRow)
    .filter((r): r is LineupHoleRow => r !== null)
    .sort((a, b) => a.franchiseName.localeCompare(b.franchiseName) || a.slot.localeCompare(b.slot) || a.reason.localeCompare(b.reason));
}

/** Convenience wrapper: the league's current (most relevant) matchup week's unresolved holes — the
 * same "current week" notion `getLiveSnapshot`/`getWeekMatchupRows` already use. Null only when
 * there are no matchups anywhere in the DB yet (mirrors `getLatestMatchupWeek`'s own null case). */
export function getCurrentWeekLineupHoles(): LineupHoleRow[] {
  const target = getLatestMatchupWeek();
  if (!target) return [];
  return getLineupHolesForWeek(target.season, target.week);
}

// ---------------------------------------------------------------------------
// Resolved holes (Task 33 wiring wave) — the admin "who's not set" panel's companion list, using
// the `resolvedReason` field `src/server/sync/lineup-holes.ts`'s resolve pass now writes (see that
// module's docstring) so a commissioner can tell an actual fix apart from a hole that only
// disappeared because the franchise's matchup went final.
// ---------------------------------------------------------------------------

export interface ResolvedLineupHoleRow {
  franchiseId: number;
  franchiseName: string;
  slot: string;
  reason: "empty" | "disqualified";
  /** Null for a resolved row written before this field existed (a real possibility once this
   * ships against production data with prior weeks already resolved) — never fabricated. */
  resolvedReason: "fixed" | "matchup_final" | null;
  resolvedAt: Date;
}

interface ResolvedLineupHolePayloadShape extends LineupHolePayloadShape {
  resolvedReason?: unknown;
}

function toResolvedLineupHoleRow(row: { franchiseId: number | null; payloadJson: unknown; detectedAt: Date }): ResolvedLineupHoleRow | null {
  if (row.franchiseId === null) return null;
  const p = (row.payloadJson ?? {}) as ResolvedLineupHolePayloadShape;
  const reason = p.reason === "empty" || p.reason === "disqualified" ? p.reason : null;
  if (reason === null) return null;
  const resolvedReason = p.resolvedReason === "fixed" || p.resolvedReason === "matchup_final" ? p.resolvedReason : null;

  return {
    franchiseId: row.franchiseId,
    franchiseName: typeof p.franchiseName === "string" ? p.franchiseName : `Franchise ${row.franchiseId}`,
    slot: typeof p.slot === "string" ? p.slot : "",
    reason,
    resolvedReason,
    // `events.detected_at` is set to `resolvedAt`'s value on the resolve-pass insert (see
    // emitLineupHoleEvents) — reusing the column rather than re-parsing the payload's own
    // `resolvedAt` ISO string keeps this a plain typed Date with no parse-failure edge case.
    resolvedAt: row.detectedAt,
  };
}

/** Every hole resolved for a specific (season, week), most recently resolved first. */
export function getResolvedLineupHolesForWeek(season: number, week: number): ResolvedLineupHoleRow[] {
  const db = getDb();
  const rows = db
    .select({ franchiseId: events.franchiseId, payloadJson: events.payloadJson, detectedAt: events.detectedAt })
    .from(events)
    .where(and(eq(events.eventType, LINEUP_EVENT_TYPES.LINEUP_HOLE_RESOLVED), eq(events.season, season), eq(events.week, week)))
    .all();

  return rows
    .map(toResolvedLineupHoleRow)
    .filter((r): r is ResolvedLineupHoleRow => r !== null)
    .sort((a, b) => b.resolvedAt.getTime() - a.resolvedAt.getTime());
}

/** Convenience wrapper, same "current week" notion as `getCurrentWeekLineupHoles`. */
export function getCurrentWeekResolvedLineupHoles(): ResolvedLineupHoleRow[] {
  const target = getLatestMatchupWeek();
  if (!target) return [];
  return getResolvedLineupHolesForWeek(target.season, target.week);
}
