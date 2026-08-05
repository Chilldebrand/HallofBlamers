import { describe, expect, it } from "vitest";
import {
  computeLatestMatchupWeek,
  computeMostRecentCompletedWeek,
  countUnplayedStarters,
  sortRosterRows,
  sortWeekHubCards,
  summarizeRosterProgress,
  type RosterProgressRow,
  type RosterRow,
  type WeekHubCardRankInput,
  type WeekSignal,
} from "../matchups";

describe("computeLatestMatchupWeek", () => {
  it("picks the latest COMPLETED week of the newest season when any exist", () => {
    const signals: WeekSignal[] = [
      { season: 2025, week: 1, hasFinal: true },
      { season: 2025, week: 17, hasFinal: true },
      { season: 2025, week: 5, hasFinal: true },
    ];
    expect(computeLatestMatchupWeek(signals)).toEqual({ season: 2025, week: 17 });
  });

  it("falls back to the EARLIEST scheduled week when the newest season has no completed games yet — real 2026 case", () => {
    const signals: WeekSignal[] = [
      { season: 2025, week: 17, hasFinal: true },
      { season: 2026, week: 1, hasFinal: false },
      { season: 2026, week: 14, hasFinal: false },
    ];
    expect(computeLatestMatchupWeek(signals)).toEqual({ season: 2026, week: 1 });
  });

  it("only considers the newest season, ignoring older completed weeks", () => {
    const signals: WeekSignal[] = [
      { season: 2024, week: 17, hasFinal: true },
      { season: 2025, week: 1, hasFinal: true },
    ];
    expect(computeLatestMatchupWeek(signals)).toEqual({ season: 2025, week: 1 });
  });

  it("returns null for no signals at all", () => {
    expect(computeLatestMatchupWeek([])).toBeNull();
  });
});

describe("computeMostRecentCompletedWeek", () => {
  it("picks the latest COMPLETED week across ALL seasons — unlike computeLatestMatchupWeek, never falls back to an upcoming week", () => {
    const signals: WeekSignal[] = [
      { season: 2025, week: 17, hasFinal: true },
      { season: 2026, week: 1, hasFinal: false },
      { season: 2026, week: 14, hasFinal: false },
    ];
    expect(computeMostRecentCompletedWeek(signals)).toEqual({ season: 2025, week: 17 });
  });

  it("picks the latest completed week within the latest season that has any completed games", () => {
    const signals: WeekSignal[] = [
      { season: 2024, week: 17, hasFinal: true },
      { season: 2025, week: 3, hasFinal: true },
      { season: 2025, week: 5, hasFinal: true },
      { season: 2025, week: 6, hasFinal: false },
    ];
    expect(computeMostRecentCompletedWeek(signals)).toEqual({ season: 2025, week: 5 });
  });

  it("returns null when no week has ever been completed (a brand new, unplayed league)", () => {
    expect(computeMostRecentCompletedWeek([{ season: 2026, week: 1, hasFinal: false }])).toBeNull();
  });

  it("returns null for no signals at all", () => {
    expect(computeMostRecentCompletedWeek([])).toBeNull();
  });
});

describe("sortRosterRows", () => {
  function slot(lineupSlot: string, points: number | null, isStarter = true): RosterRow {
    return { playerName: `Player ${lineupSlot}-${points}`, position: "RB", proTeam: null, lineupSlot, isStarter, points };
  }

  it("orders starters by the canonical slot order: QB, RB, WR, TE, FLEX, D/ST, K, then bench/IR", () => {
    const rows = [slot("K", 8), slot("QB", 20), slot("BE", 5, false), slot("FLEX", 12), slot("WR", 15), slot("IR", 0, false), slot("RB", 18)];
    const sorted = sortRosterRows(rows);
    expect(sorted.map((r) => r.lineupSlot)).toEqual(["QB", "RB", "WR", "FLEX", "K", "BE", "IR"]);
  });

  it("breaks ties within the same slot by points descending", () => {
    const rows = [slot("RB", 5), slot("RB", 20), slot("RB", 12)];
    const sorted = sortRosterRows(rows);
    expect(sorted.map((r) => r.points)).toEqual([20, 12, 5]);
  });

  it("treats a null points value as the lowest for tiebreak purposes, without crashing", () => {
    const rows = [slot("RB", null), slot("RB", 10)];
    const sorted = sortRosterRows(rows);
    expect(sorted.map((r) => r.points)).toEqual([10, null]);
  });

  it("does not mutate the input array", () => {
    const rows = [slot("RB", 5), slot("QB", 20)];
    const copy = [...rows];
    sortRosterRows(rows);
    expect(rows).toEqual(copy);
  });
});

describe("countUnplayedStarters", () => {
  function slot(lineupSlot: string, points: number | null, isStarter = true): RosterRow {
    return { playerName: `Player ${lineupSlot}`, position: "RB", proTeam: null, lineupSlot, isStarter, points };
  }

  it("counts only STARTERS with null points, never a real 0 (honest-data: 0 is a real score)", () => {
    const rows = [slot("QB", 24.8), slot("K", null), slot("BE", null, false), slot("RB", 0)];
    expect(countUnplayedStarters(rows)).toBe(1);
  });

  it("returns 0 when every starter already has a score", () => {
    expect(countUnplayedStarters([slot("QB", 10), slot("RB", 5)])).toBe(0);
  });

  it("returns 0 for an empty roster", () => {
    expect(countUnplayedStarters([])).toBe(0);
  });
});

describe("sortWeekHubCards", () => {
  interface Card extends WeekHubCardRankInput {
    id: string;
  }
  function card(id: string, beltAtStake: boolean, isViewerGame: boolean): Card {
    return { id, beltAtStake, isViewerGame };
  }

  it("the belt game leads, everything else keeps its original order", () => {
    const rows = [card("a", false, false), card("b", true, false), card("c", false, false)];
    expect(sortWeekHubCards(rows).map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("when the belt game is not the viewer's, the viewer's own game takes second position", () => {
    const rows = [card("a", false, false), card("b", true, false), card("c", false, true), card("d", false, false)];
    expect(sortWeekHubCards(rows).map((c) => c.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("a belt game that IS the viewer's own game just ranks first once — nothing to promote past it", () => {
    const rows = [card("a", false, false), card("b", true, true), card("c", false, false)];
    expect(sortWeekHubCards(rows).map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("with no belt game at all this week, the viewer's own game still leads", () => {
    const rows = [card("a", false, false), card("b", false, true), card("c", false, false)];
    expect(sortWeekHubCards(rows).map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("with neither a belt game nor a viewer game, original order is preserved untouched", () => {
    const rows = [card("a", false, false), card("b", false, false)];
    expect(sortWeekHubCards(rows).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const rows = [card("a", false, false), card("b", true, false)];
    const copy = [...rows];
    sortWeekHubCards(rows);
    expect(rows).toEqual(copy);
  });
});

describe("summarizeRosterProgress", () => {
  function row(teamSeasonId: number, isStarter: boolean, points: number | null): RosterProgressRow {
    return { teamSeasonId, isStarter, points };
  }

  it("counts remaining (null-points) starters and total starters, per team_season_id", () => {
    const rows = [row(1, true, 10), row(1, true, null), row(1, false, null), row(2, true, null)];
    const result = summarizeRosterProgress(rows);
    expect(result.get(1)).toEqual({ remaining: 1, total: 2 }); // bench row excluded from both counts
    expect(result.get(2)).toEqual({ remaining: 1, total: 1 });
  });

  it("a real 0 is NOT counted as remaining — honest-data, 0 is a played score", () => {
    const result = summarizeRosterProgress([row(1, true, 0)]);
    expect(result.get(1)).toEqual({ remaining: 0, total: 1 });
  });

  it("returns an empty map for no rows (no roster synced yet)", () => {
    expect(summarizeRosterProgress([]).size).toBe(0);
  });
});
