/**
 * Client-safe live-event types (Task 33 wiring wave). Deliberately duplicated from the server
 * side rather than imported — `src/server/sync/emit-events.ts`'s `EVENT_TYPES` and
 * `src/server/sync/lineup-holes.ts`'s `LINEUP_EVENT_TYPES` are the real source of truth for these
 * string values (see their docstrings), but both live under `src/server/`, which client
 * components must never import from (AGENTS.md). This module is the client-side mirror of that
 * contract — keep it in sync by hand if either server module ever adds/renames an event type.
 */

/** Every `events.event_type` value the SSE stream (`/api/live`) can emit — also each frame's
 * `event:` field, per `src/server/live/stream.ts`'s `formatSseFrame`. */
export const LIVE_EVENT_TYPES = [
  "MatchupLeadChanged",
  "MatchupFinished",
  "BeltDefended",
  "BeltTransferred",
  "RecordBroken",
  "BeatdownOfWeek",
  "LineupHoleDetected",
  "LineupHoleResolved",
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

/** One parsed SSE frame — mirrors `formatSseFrame`'s `data:` envelope in
 * `src/server/live/stream.ts` field for field. `payload` is the event-type-specific, render-ready
 * object each emitting module documents (e.g. `MatchupLeadChanged` carries `leader`/
 * `homeFranchiseName`/`homeScore`/etc — see `emit-events.ts`). */
export interface LiveEventFrame {
  id: number;
  eventType: string;
  season: number | null;
  week: number | null;
  occurredAt: number;
  franchiseId: number | null;
  matchupId: number | null;
  playerId: number | null;
  payload: unknown;
}
