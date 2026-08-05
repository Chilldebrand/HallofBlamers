import { describe, expect, it } from "vitest";
import {
  BOTH_RB_DISQUALIFIED_INPUT,
  BOTH_RB_EMPTY_INPUT,
  DISQUALIFIED_IR_INPUT,
  DISQUALIFIED_OUT_INPUT,
  EMPTY_SLOT_INPUT,
  HEALTHY_INPUT,
  REAL_2018_WK1_EMPTY_DST_INPUT,
  UNRESOLVED_SLOT_COUNTS_INPUT,
} from "../__fixtures__/lineupHoles";
import { detectLineupHoles } from "../lineupHoles";

describe("detectLineupHoles", () => {
  it("returns no holes for a fully filled, non-disqualified lineup (the common real-world case)", () => {
    expect(detectLineupHoles(HEALTHY_INPUT)).toEqual([]);
  });

  it("never fabricates an empty-slot hole when startingSlotCounts is unresolved ({})", () => {
    expect(detectLineupHoles(UNRESOLVED_SLOT_COUNTS_INPUT)).toEqual([]);
  });

  it("QUESTIONABLE is never disqualifying (judgment call — 'may play' is not a hole)", () => {
    // HEALTHY_INPUT's FLEX starter is QUESTIONABLE; asserting [] above already covers this, but
    // this test names the specific behavior so a future change to the allowlist can't silently
    // start flagging QUESTIONABLE without a test failing here.
    const holes = detectLineupHoles(HEALTHY_INPUT);
    expect(holes.some((h) => h.reason === "disqualified")).toBe(false);
  });

  it("undefined/null injuryStatus (real D/ST shape) is never disqualifying", () => {
    const holes = detectLineupHoles(HEALTHY_INPUT);
    expect(holes.find((h) => h.slot === "D/ST")).toBeUndefined();
  });

  describe("empty-slot holes", () => {
    it("flags one empty RB instance when RB is configured for 2 and only 1 is filled", () => {
      const holes = detectLineupHoles(EMPTY_SLOT_INPUT);
      expect(holes).toEqual([{ slot: "RB", reason: "empty", playerId: null, playerName: null, injuryStatus: null, emptyIndex: 1 }]);
    });

    it("assigns stable 1/2 emptyIndex ordinals when BOTH RB instances are empty", () => {
      const holes = detectLineupHoles(BOTH_RB_EMPTY_INPUT);
      expect(holes).toEqual([
        { slot: "RB", reason: "empty", playerId: null, playerName: null, injuryStatus: null, emptyIndex: 1 },
        { slot: "RB", reason: "empty", playerId: null, playerName: null, injuryStatus: null, emptyIndex: 2 },
      ]);
    });

    it("is deterministic and idempotent — calling twice with the same input returns equal results", () => {
      expect(detectLineupHoles(BOTH_RB_EMPTY_INPUT)).toEqual(detectLineupHoles(BOTH_RB_EMPTY_INPUT));
    });
  });

  describe("disqualified-starter holes", () => {
    it("flags a starter whose real observed status is OUT", () => {
      const holes = detectLineupHoles(DISQUALIFIED_OUT_INPUT);
      expect(holes).toEqual([{ slot: "WR", reason: "disqualified", playerId: 4, playerName: "Player 4", injuryStatus: "OUT", emptyIndex: null }]);
    });

    it("flags a starter whose real observed status is INJURY_RESERVE", () => {
      const holes = detectLineupHoles(DISQUALIFIED_IR_INPUT);
      expect(holes).toEqual([{ slot: "TE", reason: "disqualified", playerId: 6, playerName: "Player 6", injuryStatus: "INJURY_RESERVE", emptyIndex: null }]);
    });

    it("anchors each disqualified hole to its own playerId — two different disqualified starters in the SAME slot label never collide", () => {
      const holes = detectLineupHoles(BOTH_RB_DISQUALIFIED_INPUT);
      expect(holes).toHaveLength(2);
      expect(holes.map((h) => h.playerId).sort()).toEqual([2, 3]);
      expect(holes.every((h) => h.slot === "RB" && h.reason === "disqualified" && h.injuryStatus === "OUT")).toBe(true);
    });
  });

  describe("FIX ROUND 1 — real historical instance (2018 wk1, espnTeamId 2 'Two Time Timmy')", () => {
    // Regression test for the report's corrected central claim: a reviewer's independent
    // cross-reference of real roster_slots against configured lineupSlotCounts found 9 genuine
    // historical empty-starter-slot instances (2018-2024) — the original report incorrectly
    // claimed none had ever occurred. This fixture is reconstructed verbatim from the actual
    // archived ESPN payload for one of them (see __fixtures__/lineupHoles.ts's full docstring) —
    // real player ids/names/injuryStatus values, not synthetic.
    it("flags the real empty D/ST slot plus the two real INJURY_RESERVE starters this exact snapshot carries", () => {
      const holes = detectLineupHoles(REAL_2018_WK1_EMPTY_DST_INPUT);
      expect(holes).toEqual([
        { slot: "D/ST", reason: "empty", playerId: null, playerName: null, injuryStatus: null, emptyIndex: 1 },
        { slot: "RB", reason: "disqualified", playerId: 2573300, playerName: "Jay Ajayi", injuryStatus: "INJURY_RESERVE", emptyIndex: null },
        { slot: "TE", reason: "disqualified", playerId: 16504, playerName: "Jack Doyle", injuryStatus: "INJURY_RESERVE", emptyIndex: null },
      ]);
    });

    it("the empty D/ST hole specifically is present even though the team genuinely rosters two real defenses (both benched, not started)", () => {
      const holes = detectLineupHoles(REAL_2018_WK1_EMPTY_DST_INPUT);
      const dstHole = holes.find((h) => h.slot === "D/ST");
      expect(dstHole).toEqual({ slot: "D/ST", reason: "empty", playerId: null, playerName: null, injuryStatus: null, emptyIndex: 1 });
    });
  });

  it("sorts holes deterministically by slot, then reason (disqualified before empty), then identity", () => {
    const holes = detectLineupHoles({
      starters: [
        { playerId: 20, playerName: "Late RB", lineupSlot: "RB", injuryStatus: "OUT" },
        { playerId: 21, playerName: "Kicker", lineupSlot: "K", injuryStatus: "ACTIVE" },
      ],
      startingSlotCounts: { RB: 2, K: 1, QB: 1 },
    });
    expect(holes.map((h) => `${h.slot}:${h.reason}:${h.playerId ?? h.emptyIndex}`)).toEqual(["QB:empty:1", "RB:disqualified:20", "RB:empty:1"]);
  });
});
