import type { DetectLineupHolesInput, LineupHoleStarterInput } from "../lineupHoles";

/** A standard 9-starter lineup shape (QB1/RB2/WR2/TE1/FLEX1/D-ST1/K1), matching the real league's
 * actual configured `rosterSettings.lineupSlotCounts` (confirmed against real archived data — see
 * `src/server/sync/lineup-holes.ts`'s module docstring). */
export const STANDARD_STARTING_SLOT_COUNTS: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  "D/ST": 1,
  K: 1,
};

function starter(overrides: Partial<LineupHoleStarterInput> & { playerId: number; lineupSlot: string }): LineupHoleStarterInput {
  return { playerName: `Player ${overrides.playerId}`, injuryStatus: "ACTIVE", ...overrides };
}

/** A fully healthy, fully filled lineup — every configured slot occupied by a non-disqualified
 * starter. The common real-world case — the large majority of sampled real weeks (2018-2026)
 * looked like this. FIX ROUND 1 CORRECTION: NOT literally every one — a reviewer's independent
 * cross-reference of real `roster_slots` against configured `lineupSlotCounts` found 9 genuine
 * historical empty-starter-slot instances across 6 team/weeks (2018-2024); see
 * `REAL_2018_WK1_EMPTY_DST_INPUT` below, reconstructed verbatim from one of them. */
export const HEALTHY_LINEUP: LineupHoleStarterInput[] = [
  starter({ playerId: 1, lineupSlot: "QB" }),
  starter({ playerId: 2, lineupSlot: "RB" }),
  starter({ playerId: 3, lineupSlot: "RB" }),
  starter({ playerId: 4, lineupSlot: "WR" }),
  starter({ playerId: 5, lineupSlot: "WR" }),
  starter({ playerId: 6, lineupSlot: "TE" }),
  starter({ playerId: 7, lineupSlot: "FLEX", injuryStatus: "QUESTIONABLE" }), // still not a hole — see below
  starter({ playerId: 8, lineupSlot: "D/ST", injuryStatus: null }), // real D/ST entries carry no designation
  starter({ playerId: 9, lineupSlot: "K" }),
];

export const HEALTHY_INPUT: DetectLineupHolesInput = { starters: HEALTHY_LINEUP, startingSlotCounts: STANDARD_STARTING_SLOT_COUNTS };

/** One starting RB slot has nobody in it — RB is configured for 2, only 1 filled. Models the real
 * mechanism (ESPN represents an empty slot by ABSENCE, never a placeholder row) via a synthetic
 * shape; see `REAL_2018_WK1_EMPTY_DST_INPUT` below for the same mechanism proven against a real
 * historical instance instead of a constructed one. */
export const EMPTY_SLOT_LINEUP: LineupHoleStarterInput[] = HEALTHY_LINEUP.filter((s) => s.playerId !== 3);
export const EMPTY_SLOT_INPUT: DetectLineupHolesInput = { starters: EMPTY_SLOT_LINEUP, startingSlotCounts: STANDARD_STARTING_SLOT_COUNTS };

/** BOTH starting RB slots empty — exercises the `emptyIndex` 1/2 ordinal assignment for two
 * simultaneously-empty instances of the same slot label. */
export const BOTH_RB_EMPTY_LINEUP: LineupHoleStarterInput[] = HEALTHY_LINEUP.filter((s) => s.playerId !== 2 && s.playerId !== 3);
export const BOTH_RB_EMPTY_INPUT: DetectLineupHolesInput = { starters: BOTH_RB_EMPTY_LINEUP, startingSlotCounts: STANDARD_STARTING_SLOT_COUNTS };

/** A starting WR is OUT — the clearest real "disqualifying" case (84 real occurrences observed). */
export const DISQUALIFIED_OUT_LINEUP: LineupHoleStarterInput[] = HEALTHY_LINEUP.map((s) =>
  s.playerId === 4 ? { ...s, injuryStatus: "OUT" } : s,
);
export const DISQUALIFIED_OUT_INPUT: DetectLineupHolesInput = { starters: DISQUALIFIED_OUT_LINEUP, startingSlotCounts: STANDARD_STARTING_SLOT_COUNTS };

/** A starting TE is on INJURY_RESERVE while started — real (if historically-caveated, see the
 * sync-integration module's docstring) observed value; still correctly disqualifying when it's
 * genuinely the CURRENT week's status. */
export const DISQUALIFIED_IR_LINEUP: LineupHoleStarterInput[] = HEALTHY_LINEUP.map((s) =>
  s.playerId === 6 ? { ...s, injuryStatus: "INJURY_RESERVE" } : s,
);
export const DISQUALIFIED_IR_INPUT: DetectLineupHolesInput = { starters: DISQUALIFIED_IR_LINEUP, startingSlotCounts: STANDARD_STARTING_SLOT_COUNTS };

/** Two DIFFERENT starters in the SAME slot label (both RBs) simultaneously disqualified — proves
 * disqualified holes are anchored to playerId, not slot+reason alone (which would collide). */
export const BOTH_RB_DISQUALIFIED_LINEUP: LineupHoleStarterInput[] = HEALTHY_LINEUP.map((s) =>
  s.lineupSlot === "RB" ? { ...s, injuryStatus: "OUT" } : s,
);
export const BOTH_RB_DISQUALIFIED_INPUT: DetectLineupHolesInput = {
  starters: BOTH_RB_DISQUALIFIED_LINEUP,
  startingSlotCounts: STANDARD_STARTING_SLOT_COUNTS,
};

/** Sentinel/negative: `startingSlotCounts: {}` (season settings unresolved) must never fabricate
 * "empty" holes, even against a roster with zero starters. */
export const UNRESOLVED_SLOT_COUNTS_INPUT: DetectLineupHolesInput = { starters: [], startingSlotCounts: {} };

// ---------------------------------------------------------------------------
// FIX ROUND 1 (real-data regression) — reconstructed verbatim from the actual archived ESPN
// payload for `data/league.db`, season 2018, week 1, espnTeamId 2 ("Two Time Timmy"), one of the
// 9 real historical empty-starter-slot instances a reviewer found and the implementer's original
// report incorrectly claimed did not exist (see `src/server/sync/lineup-holes.ts`'s module
// docstring for the full correction). Confirmed directly against the raw snapshot: the team
// genuinely rosters TWO defenses ("Eagles D/ST", "Lions D/ST") but both sit at `lineupSlotId: 20`
// (bench) — there is no roster entry at all for `lineupSlotId: 16` (D/ST), the real mechanism this
// engine detects (absence, never a placeholder). Real player ids/names/injuryStatus values kept
// verbatim (public NFL/fantasy data, not personal information) rather than anonymized, per the
// review's "anonymized only if needed" allowance — nothing here needs anonymizing.
//
// Kept at FULL real fidelity rather than trimmed to isolate just the empty slot: the same real
// roster also genuinely carries two `INJURY_RESERVE`-flagged starters (Jay Ajayi at RB, Jack Doyle
// at TE) in the archived snapshot. Per this module's HISTORICAL DATA CAVEAT (see
// `lineup-holes.ts`), `injuryStatus` on old backfilled data may reflect fetch-time status rather
// than the true week-1-2018 designation — but that caveat is about whether the LABEL is
// historically accurate, not about whether the ENGINE behaves correctly given its input: fed this
// exact real snapshot's data, `detectLineupHoles` correctly returns all three real holes, and the
// regression test below asserts exactly that.
// ---------------------------------------------------------------------------

export const REAL_2018_WK1_EMPTY_DST_STARTERS: LineupHoleStarterInput[] = [
  { playerId: 2330, playerName: "Tom Brady", lineupSlot: "QB", injuryStatus: "ACTIVE" },
  { playerId: 2573300, playerName: "Jay Ajayi", lineupSlot: "RB", injuryStatus: "INJURY_RESERVE" },
  { playerId: 3045147, playerName: "James Conner", lineupSlot: "RB", injuryStatus: "ACTIVE" },
  { playerId: 16733, playerName: "Odell Beckham Jr.", lineupSlot: "WR", injuryStatus: "QUESTIONABLE" },
  { playerId: 16737, playerName: "Mike Evans", lineupSlot: "WR", injuryStatus: "ACTIVE" },
  { playerId: 16504, playerName: "Jack Doyle", lineupSlot: "TE", injuryStatus: "INJURY_RESERVE" },
  { playerId: 15971, playerName: "Rex Burkhead", lineupSlot: "FLEX", injuryStatus: "ACTIVE" },
  { playerId: 4333, playerName: "Matt Bryant", lineupSlot: "K", injuryStatus: "ACTIVE" },
  // No D/ST entry — "Eagles D/ST" (-16021) and "Lions D/ST" (-16008) are both real roster
  // entries, but both at lineupSlotId 20 (bench), not started. This is the real empty slot.
];

export const REAL_2018_WK1_EMPTY_DST_INPUT: DetectLineupHolesInput = {
  starters: REAL_2018_WK1_EMPTY_DST_STARTERS,
  startingSlotCounts: STANDARD_STARTING_SLOT_COUNTS, // real 2018 lineupSlotCounts match the standard shape exactly
};
