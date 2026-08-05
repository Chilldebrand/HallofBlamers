import type { LiveEventFrame } from "./types";

/**
 * Score-cell live update — shared by the home scoreboard band and the week-hub matchup grid,
 * both of which are shaped "one card per matchup, home/away score + final flag" even though
 * their full card props differ otherwise. Pure; no DOM, no timers — the two client islands that
 * use this own their own `useState`/flash-timeout wiring.
 */
export interface LiveScoreSide {
  franchiseId: number;
  score: number | null;
}

export interface LiveScoreCell {
  matchupId: number;
  isFinal: boolean;
  home: LiveScoreSide;
  away: LiveScoreSide | null;
}

export interface ScoreUpdate {
  matchupId: number;
  homeScore: number;
  awayScore: number;
  isFinal: boolean;
}

interface ScoreEventPayloadShape {
  homeScore?: unknown;
  awayScore?: unknown;
}

/**
 * `MatchupLeadChanged` and `MatchupFinished` are the two live event types that carry a fresh
 * home/away score pair (see `src/server/sync/emit-events.ts`'s payload shapes for both) — every
 * other event type returns `null` here, and any payload missing a numeric home/away score is
 * treated the same as "not a score event" rather than partially applied.
 */
export function extractScoreUpdate(frame: LiveEventFrame): ScoreUpdate | null {
  if (frame.eventType !== "MatchupLeadChanged" && frame.eventType !== "MatchupFinished") return null;
  if (typeof frame.matchupId !== "number") return null;

  const payload = (frame.payload ?? {}) as ScoreEventPayloadShape;
  if (typeof payload.homeScore !== "number" || typeof payload.awayScore !== "number") return null;

  return { matchupId: frame.matchupId, homeScore: payload.homeScore, awayScore: payload.awayScore, isFinal: frame.eventType === "MatchupFinished" };
}

/** Applies a `ScoreUpdate` to whichever cell matches its `matchupId` (a no-op array — same
 * reference back — when nothing matches, so callers can skip a re-render/flash trigger). */
export function applyScoreUpdate<T extends LiveScoreCell>(cells: T[], update: ScoreUpdate): T[] {
  let changed = false;
  const next = cells.map((c) => {
    if (c.matchupId !== update.matchupId) return c;
    changed = true;
    return {
      ...c,
      isFinal: update.isFinal,
      home: { ...c.home, score: update.homeScore },
      away: c.away ? { ...c.away, score: update.awayScore } : c.away,
    };
  });
  return changed ? next : cells;
}

/**
 * Reconciles a `/api/live/snapshot` poll (the SSE fallback contract — see `useSnapshotFallback`)
 * into existing cell state. `getWeekMatchupRows`/`getInSeasonScoreboard` (what the snapshot route
 * reuses) deliberately null a score until its matchup is FINAL — there's no in-progress live
 * number in that shape, only "final" or nothing (see those query files' own comments) — so a poll
 * row that isn't final yet carries nothing better than what's already on screen and is skipped
 * rather than regressing an already-shown live (SSE-sourced) score back to a blank/projected
 * placeholder. Once a poll row IS final, its real score always wins.
 */
export function mergeSnapshotCells<T extends LiveScoreCell>(cells: T[], snapshotRows: LiveScoreCell[]): T[] {
  let result = cells;
  for (const row of snapshotRows) {
    if (!row.isFinal || row.home.score === null) continue;
    if (row.away !== null && row.away.score === null) continue;
    result = applyScoreUpdate(result, { matchupId: row.matchupId, homeScore: row.home.score, awayScore: row.away?.score ?? 0, isFinal: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Belt-label live update (fix round 1, finding 6) — the week hub card's `beltLabel` is baked into
// its initial SSR props from `m.beltResult`/`m.isFinal` at render time (see
// matchups/[year]/[week]/page.tsx) and was never being recomputed on a live transition, so a belt
// game finishing via a live `MatchupFinished` update kept showing its pre-game "Belt at stake"
// wording forever. Two pieces: `extractBeltOutcome` upgrades the label to the real decided
// outcome once a `BeltDefended`/`BeltTransferred` event actually arrives; the caller additionally
// neutralizes to a plain "Final" the INSTANT a belt game's score update reports final (so there's
// never a window where a decided game still reads "at stake", even before the belt event lands).
// ---------------------------------------------------------------------------

export interface BeltLabelUpdate {
  matchupId: number;
  beltLabel: string;
}

/**
 * `BeltDefended`/`BeltTransferred` carry the belt game's real outcome — this mirrors the EXACT
 * wording the static week-hub page computes from `m.beltResult` (see that page's `beltLabel`
 * ternary) so a live-updated card and a freshly-loaded one never disagree.
 */
export function extractBeltOutcome(frame: LiveEventFrame): BeltLabelUpdate | null {
  if (frame.eventType !== "BeltDefended" && frame.eventType !== "BeltTransferred") return null;
  if (typeof frame.matchupId !== "number") return null;
  return { matchupId: frame.matchupId, beltLabel: frame.eventType === "BeltDefended" ? "Belt Defended" : "Belt Changes Hands" };
}

/** Applies a `BeltLabelUpdate` to whichever card matches its `matchupId` — same no-op-when-
 * nothing-matches shape as `applyScoreUpdate`. */
export function applyBeltLabelUpdate<T extends { matchupId: number; beltLabel: string }>(cards: T[], update: BeltLabelUpdate): T[] {
  let changed = false;
  const next = cards.map((c) => {
    if (c.matchupId !== update.matchupId) return c;
    changed = true;
    return { ...c, beltLabel: update.beltLabel };
  });
  return changed ? next : cards;
}
