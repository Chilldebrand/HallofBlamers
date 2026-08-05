import { describe, expect, it } from "vitest";
import { computeDefensePips, computeEloDeltas, formatDraftDateFull, formatDraftDateShort, selectScoreboardRows } from "../homepage";

describe("selectScoreboardRows (pure)", () => {
  it("returns every row when there are 5 or fewer", () => {
    const rows = ["a", "b", "c"];
    expect(selectScoreboardRows(rows)).toEqual([
      { rank: 1, row: "a" },
      { rank: 2, row: "b" },
      { rank: 3, row: "c" },
    ]);
  });

  it("returns exactly 5 when there are exactly 5", () => {
    const rows = ["a", "b", "c", "d", "e"];
    const selected = selectScoreboardRows(rows);
    expect(selected).toHaveLength(5);
    expect(selected[4]).toEqual({ rank: 5, row: "e" });
  });

  it("appends a distinct last-place row (never a duplicate of the top 5) for a bigger league", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `team${i + 1}`);
    const selected = selectScoreboardRows(rows);
    expect(selected).toHaveLength(6);
    expect(selected.slice(0, 5)).toEqual([
      { rank: 1, row: "team1" },
      { rank: 2, row: "team2" },
      { rank: 3, row: "team3" },
      { rank: 4, row: "team4" },
      { rank: 5, row: "team5" },
    ]);
    expect(selected[5]).toEqual({ rank: 12, row: "team12" });
  });

  it("returns an empty array for an empty league", () => {
    expect(selectScoreboardRows([])).toEqual([]);
  });
});

describe("computeEloDeltas (pure)", () => {
  it("computes delta vs the immediately prior recorded week", () => {
    const deltas = computeEloDeltas([
      { franchiseId: 1, season: 2025, week: 1, eloPost: 1500 },
      { franchiseId: 1, season: 2025, week: 2, eloPost: 1531 },
    ]);
    expect(deltas.get(1)).toBe(31);
  });

  it("is null (never a fabricated 0) for a franchise with only one recorded week", () => {
    const deltas = computeEloDeltas([{ franchiseId: 2, season: 2025, week: 1, eloPost: 1500 }]);
    expect(deltas.get(2)).toBeNull();
  });

  it("sorts out-of-order rows before diffing (input order doesn't matter)", () => {
    const deltas = computeEloDeltas([
      { franchiseId: 3, season: 2025, week: 3, eloPost: 1490 },
      { franchiseId: 3, season: 2025, week: 1, eloPost: 1500 },
      { franchiseId: 3, season: 2025, week: 2, eloPost: 1520 },
    ]);
    // Latest (week 3, 1490) vs prior (week 2, 1520) = -30, not week 1 vs week 3.
    expect(deltas.get(3)).toBe(-30);
  });

  it("handles multiple franchises independently", () => {
    const deltas = computeEloDeltas([
      { franchiseId: 1, season: 2025, week: 1, eloPost: 1500 },
      { franchiseId: 1, season: 2025, week: 2, eloPost: 1520 },
      { franchiseId: 2, season: 2025, week: 1, eloPost: 1480 },
      { franchiseId: 2, season: 2025, week: 2, eloPost: 1460 },
    ]);
    expect(deltas.get(1)).toBe(20);
    expect(deltas.get(2)).toBe(-20);
  });
});

describe("computeDefensePips (pure)", () => {
  it("floors total at 4 for zero defenses", () => {
    expect(computeDefensePips(0)).toEqual({ total: 4, filled: 0 });
  });

  it("shows defenses+1 (room for the next one) for a mid-size reign", () => {
    expect(computeDefensePips(3)).toEqual({ total: 4, filled: 3 });
  });

  it("caps total at 8 for a very long reign, without ever exceeding it", () => {
    expect(computeDefensePips(20)).toEqual({ total: 8, filled: 8 });
  });

  it("never reports more filled than total", () => {
    for (let d = 0; d <= 30; d++) {
      const { total, filled } = computeDefensePips(d);
      expect(filled).toBeLessThanOrEqual(total);
    }
  });
});

describe("formatDraftDateShort (pure)", () => {
  it("formats an ISO date as 'Mon D'", () => {
    expect(formatDraftDateShort("2026-08-29")).toBe("Aug 29");
    expect(formatDraftDateShort("2026-01-05")).toBe("Jan 5");
  });

  it("falls back to the raw string for a malformed input", () => {
    expect(formatDraftDateShort("not-a-date")).toBe("not-a-date");
  });
});

describe("formatDraftDateFull (pure)", () => {
  it("formats an ISO date with a real (derived, not fabricated) weekday", () => {
    // 2026-08-29 is a real Saturday — verifies against Date's own UTC calendar, not a hand count.
    expect(formatDraftDateFull("2026-08-29")).toBe("Sat, Aug 29, 2026");
  });

  it("falls back to the raw string for a malformed input", () => {
    expect(formatDraftDateFull("not-a-date")).toBe("not-a-date");
  });
});
