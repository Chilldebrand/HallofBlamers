import { describe, expect, it } from "vitest";
import { applyBeltLabelUpdate, applyScoreUpdate, extractBeltOutcome, extractScoreUpdate, mergeSnapshotCells, type LiveScoreCell } from "../scoreUpdate";
import type { LiveEventFrame } from "../types";

function frame(overrides: Partial<LiveEventFrame> = {}): LiveEventFrame {
  return {
    id: 1,
    eventType: "MatchupLeadChanged",
    season: 2026,
    week: 3,
    occurredAt: 1700000000000,
    franchiseId: 5,
    matchupId: 9,
    playerId: null,
    payload: { homeScore: 55.5, awayScore: 44.4 },
    ...overrides,
  };
}

describe("extractScoreUpdate", () => {
  it("extracts a score update from MatchupLeadChanged (not final)", () => {
    expect(extractScoreUpdate(frame())).toEqual({ matchupId: 9, homeScore: 55.5, awayScore: 44.4, isFinal: false });
  });

  it("extracts a score update from MatchupFinished (final)", () => {
    expect(extractScoreUpdate(frame({ eventType: "MatchupFinished" }))).toEqual({ matchupId: 9, homeScore: 55.5, awayScore: 44.4, isFinal: true });
  });

  it("returns null for any other event type", () => {
    expect(extractScoreUpdate(frame({ eventType: "BeltDefended" }))).toBeNull();
    expect(extractScoreUpdate(frame({ eventType: "RecordBroken" }))).toBeNull();
  });

  it("returns null when matchupId is missing", () => {
    expect(extractScoreUpdate(frame({ matchupId: null }))).toBeNull();
  });

  it("returns null when the payload has no numeric scores", () => {
    expect(extractScoreUpdate(frame({ payload: { homeScore: "55.5" } }))).toBeNull();
    expect(extractScoreUpdate(frame({ payload: null }))).toBeNull();
  });
});

describe("applyScoreUpdate", () => {
  const cells: LiveScoreCell[] = [
    { matchupId: 1, isFinal: false, home: { franchiseId: 10, score: 20 }, away: { franchiseId: 11, score: 15 } },
    { matchupId: 2, isFinal: false, home: { franchiseId: 12, score: 5 }, away: null },
  ];

  it("updates the matching cell's scores and final flag", () => {
    const next = applyScoreUpdate(cells, { matchupId: 1, homeScore: 25, awayScore: 18, isFinal: true });
    expect(next[0]).toEqual({ matchupId: 1, isFinal: true, home: { franchiseId: 10, score: 25 }, away: { franchiseId: 11, score: 18 } });
    expect(next[1]).toBe(cells[1]); // untouched cell keeps referential identity
  });

  it("leaves a bye's null away side null", () => {
    const next = applyScoreUpdate(cells, { matchupId: 2, homeScore: 30, awayScore: 0, isFinal: false });
    expect(next[1]!.away).toBeNull();
    expect(next[1]!.home.score).toBe(30);
  });

  it("returns the SAME array reference when no cell matches (no-op, no spurious re-render)", () => {
    const next = applyScoreUpdate(cells, { matchupId: 999, homeScore: 1, awayScore: 1, isFinal: false });
    expect(next).toBe(cells);
  });
});

describe("mergeSnapshotCells", () => {
  const cells: LiveScoreCell[] = [
    { matchupId: 1, isFinal: false, home: { franchiseId: 10, score: 55.5 }, away: { franchiseId: 11, score: 44.4 } },
    { matchupId: 2, isFinal: false, home: { franchiseId: 12, score: null }, away: null },
  ];

  it("applies a FINAL snapshot row's real score", () => {
    const next = mergeSnapshotCells(cells, [{ matchupId: 1, isFinal: true, home: { franchiseId: 10, score: 60 }, away: { franchiseId: 11, score: 50 } }]);
    expect(next[0]).toEqual({ matchupId: 1, isFinal: true, home: { franchiseId: 10, score: 60 }, away: { franchiseId: 11, score: 50 } });
  });

  it("skips a NOT-final snapshot row entirely — never regresses an already-live score to null/blank", () => {
    const next = mergeSnapshotCells(cells, [{ matchupId: 1, isFinal: false, home: { franchiseId: 10, score: null }, away: { franchiseId: 11, score: null } }]);
    expect(next).toBe(cells); // untouched
  });

  it("skips a final row whose score is somehow still null (defensive — never fabricates a number)", () => {
    const next = mergeSnapshotCells(cells, [{ matchupId: 2, isFinal: true, home: { franchiseId: 12, score: null }, away: null }]);
    expect(next).toBe(cells);
  });

  it("applies a bye's final home score even with no away side", () => {
    const next = mergeSnapshotCells(cells, [{ matchupId: 2, isFinal: true, home: { franchiseId: 12, score: 88.8 }, away: null }]);
    expect(next[1]).toEqual({ matchupId: 2, isFinal: true, home: { franchiseId: 12, score: 88.8 }, away: null });
  });
});

describe("extractBeltOutcome", () => {
  function beltFrame(eventType: string, matchupId: number | null = 9): LiveEventFrame {
    return { id: 1, eventType, season: 2026, week: 3, occurredAt: 1700000000000, franchiseId: 5, matchupId, playerId: null, payload: {} };
  }

  it("maps BeltDefended to the exact static-page wording", () => {
    expect(extractBeltOutcome(beltFrame("BeltDefended"))).toEqual({ matchupId: 9, beltLabel: "Belt Defended" });
  });

  it("maps BeltTransferred to the exact static-page wording", () => {
    expect(extractBeltOutcome(beltFrame("BeltTransferred"))).toEqual({ matchupId: 9, beltLabel: "Belt Changes Hands" });
  });

  it("returns null for any other event type", () => {
    expect(extractBeltOutcome(beltFrame("MatchupFinished"))).toBeNull();
  });

  it("returns null when matchupId is missing", () => {
    expect(extractBeltOutcome(beltFrame("BeltDefended", null))).toBeNull();
  });
});

describe("applyBeltLabelUpdate", () => {
  const cards = [
    { matchupId: 1, beltLabel: "Belt at stake" },
    { matchupId: 2, beltLabel: "Belt at stake · your game" },
  ];

  it("replaces the matching card's beltLabel", () => {
    const next = applyBeltLabelUpdate(cards, { matchupId: 1, beltLabel: "Belt Defended" });
    expect(next[0]).toEqual({ matchupId: 1, beltLabel: "Belt Defended" });
    expect(next[1]).toBe(cards[1]); // untouched card keeps referential identity
  });

  it("returns the SAME array reference when no card matches", () => {
    const next = applyBeltLabelUpdate(cards, { matchupId: 999, beltLabel: "Belt Defended" });
    expect(next).toBe(cards);
  });
});
