/**
 * Lineup-hole detection (Task 20) — given a franchise's STARTING roster rows for one week, flags
 * two kinds of "hole": a starting slot with nobody in it, or a starting slot occupied by a player
 * whose injury/suspension status means they will not accrue points. Pure per AGENTS.md: no DB, no
 * IO, no knowledge of ESPN slot ids or the events table — callers translate lineup-slot ids to
 * labels (already done for them by `normalize.ts`/`roster_slots.lineup_slot`), resolve the season's
 * configured starting-slot counts, and join in real injury data before calling in. See
 * `src/server/sync/lineup-holes.ts` for the DB-facing caller and the ground-truth notes on exactly
 * what real ESPN data does and doesn't support here.
 *
 * DESIGN NOTE on identifying a specific hole across repeated calls (re-runs must be idempotent —
 * see the sync-integration module's dedupe-key scheme): a "disqualified" hole is always anchored to
 * a real `playerId`, which is a stable identity on its own. An "empty" hole has no player to anchor
 * to — ESPN represents an empty starting slot by the ABSENCE of a roster row, never a placeholder —
 * so multiple simultaneously-empty instances of the SAME slot label are anonymized as a 1-based
 * `emptyIndex` among the current deficit for that label. This is stable as long as the deficit
 * COUNT for that slot doesn't change, which is the only thing that's actually meaningful to track
 * (the slots themselves are interchangeable).
 */

export type LineupHoleReason = "empty" | "disqualified";

export interface LineupHoleStarterInput {
  playerId: number;
  playerName: string;
  /** Starting-slot label, e.g. "RB", "FLEX" — NOT "BE"/"IR". Caller must have already excluded
   * bench/IR rows; this engine has no concept of which slot ids are bench/IR. */
  lineupSlot: string;
  /** The player-level ESPN designation (see the espn-fantasy-data skill / this task's ground truth
   * for the sentinel trap this deliberately avoids: a DIFFERENT, same-named ROSTER-ENTRY-level
   * field is a constant and not a real signal). `null` for "no designation" (e.g. every D/ST) —
   * never treated as disqualifying. */
  injuryStatus: string | null;
}

export interface DetectLineupHolesInput {
  /** Every STARTING roster row for this franchise/week — bench/IR already excluded by the caller. */
  starters: LineupHoleStarterInput[];
  /** Slot label -> configured starting count for the season (e.g. `{ QB: 1, RB: 2, FLEX: 1, ... }`).
   * Pass `{}` when the season's settings couldn't be resolved — this safely produces zero "empty"
   * holes rather than guessing a count, by construction (see module docstring). */
  startingSlotCounts: Record<string, number>;
}

export interface LineupHole {
  slot: string;
  reason: LineupHoleReason;
  /** Set only when `reason === "disqualified"`. */
  playerId: number | null;
  playerName: string | null;
  /** The real observed value (e.g. "OUT") when `reason === "disqualified"`; always `null` for
   * "empty". Informational only — NOT part of the dedupe identity (see the sync-integration
   * module's docstring for why: avoids spurious resolve/re-detect churn when a player's status
   * wobbles between two disqualifying values). */
  injuryStatus: string | null;
  /** Set only when `reason === "empty"` — 1-based ordinal among the CURRENT deficit for this slot
   * label (see module docstring). Always `null` for "disqualified". */
  emptyIndex: number | null;
}

/**
 * Every real value observed across the full archived history (2018-2026) that means "this player
 * will not accrue points this week." Judgment call: `QUESTIONABLE` is deliberately EXCLUDED — it
 * means "may play," not "won't," and is extremely common in real data (~18% of all entries); a
 * "hole" is meant to flag a near-certain problem, not the ordinary weekly injury report. This is an
 * ALLOWLIST (not "anything that isn't ACTIVE/QUESTIONABLE") on purpose: an unrecognized future
 * ESPN value is treated as non-disqualifying rather than guessed at.
 */
const DISQUALIFYING_INJURY_STATUSES = new Set(["OUT", "DOUBTFUL", "SUSPENSION", "INJURY_RESERVE"]);

function isDisqualifyingInjuryStatus(status: string | null): boolean {
  return status !== null && DISQUALIFYING_INJURY_STATUSES.has(status);
}

function compareHoles(a: LineupHole, b: LineupHole): number {
  if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
  if (a.reason !== b.reason) return a.reason === "disqualified" ? -1 : 1;
  if (a.reason === "disqualified") return (a.playerId ?? 0) - (b.playerId ?? 0);
  return (a.emptyIndex ?? 0) - (b.emptyIndex ?? 0);
}

/**
 * Returns every current lineup hole for this franchise/week, deterministically ordered. Empty
 * array means a healthy lineup (every configured starting slot filled with a non-disqualified
 * player) — the common case in most real weeks, though NOT universal: FIX ROUND 1 CORRECTION —
 * this docstring previously claimed a real empty starting slot "has never actually occurred in
 * this league's history," which a reviewer's independent cross-reference of real `roster_slots`
 * against configured `lineupSlotCounts` disproved (9 genuine historical instances across 6
 * team/weeks, 2018-2024). The mechanism is exercised both via synthetic fixtures AND, now, a
 * regression test reconstructed verbatim from one of those real instances (2018 wk1, an empty
 * D/ST slot) — see `src/engines/__fixtures__/lineupHoles.ts`'s `REAL_2018_WK1_EMPTY_DST_*` exports.
 */
export function detectLineupHoles(input: DetectLineupHolesInput): LineupHole[] {
  const holes: LineupHole[] = [];

  for (const starter of input.starters) {
    if (isDisqualifyingInjuryStatus(starter.injuryStatus)) {
      holes.push({
        slot: starter.lineupSlot,
        reason: "disqualified",
        playerId: starter.playerId,
        playerName: starter.playerName,
        injuryStatus: starter.injuryStatus,
        emptyIndex: null,
      });
    }
  }

  const filledCountBySlot = new Map<string, number>();
  for (const starter of input.starters) {
    filledCountBySlot.set(starter.lineupSlot, (filledCountBySlot.get(starter.lineupSlot) ?? 0) + 1);
  }

  for (const [slot, configuredCount] of Object.entries(input.startingSlotCounts)) {
    const filled = filledCountBySlot.get(slot) ?? 0;
    const deficit = configuredCount - filled;
    for (let i = 1; i <= deficit; i++) {
      holes.push({ slot, reason: "empty", playerId: null, playerName: null, injuryStatus: null, emptyIndex: i });
    }
  }

  return holes.sort(compareHoles);
}
