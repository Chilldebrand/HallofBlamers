import type { LiveEventFrame } from "./types";

/**
 * Parses one SSE frame's `data:` line (already extracted by the browser's `EventSource` /
 * `addEventListener`) into a `LiveEventFrame`. Pure and defensive — returns `null` rather than
 * throwing on anything that isn't shaped like `formatSseFrame`'s envelope (a malformed frame
 * should never crash a live client island; it should just be dropped). Never fabricates a field:
 * every value is read from the parsed JSON as-is, `null` only where the source was already null.
 */
export function parseLiveEventFrame(raw: string): LiveEventFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;

  const o = obj as Record<string, unknown>;
  if (typeof o.id !== "number" || typeof o.eventType !== "string" || typeof o.occurredAt !== "number") return null;

  return {
    id: o.id,
    eventType: o.eventType,
    season: typeof o.season === "number" ? o.season : null,
    week: typeof o.week === "number" ? o.week : null,
    occurredAt: o.occurredAt,
    franchiseId: typeof o.franchiseId === "number" ? o.franchiseId : null,
    matchupId: typeof o.matchupId === "number" ? o.matchupId : null,
    playerId: typeof o.playerId === "number" ? o.playerId : null,
    payload: o.payload ?? null,
  };
}
