import { describe, expect, it } from "vitest";
import {
  buildEloSeries,
  countActiveFranchisesWithoutBelt,
  findEloPeak,
  markSeasonEndDots,
  sortFranchiseIndex,
  type EloPoint,
  type FranchiseIndexRow,
} from "../franchises";

function row(overrides: Partial<FranchiseIndexRow>): FranchiseIndexRow {
  return {
    id: 1,
    name: "Team",
    manager: "Manager",
    active: true,
    wins: 0,
    losses: 0,
    ties: 0,
    winPct: 0,
    championships: 0,
    currentElo: 1500,
    beltReignCount: 0,
    ...overrides,
  };
}

describe("sortFranchiseIndex", () => {
  it("puts every active franchise before every departed one, regardless of Elo", () => {
    const rows = [
      row({ id: 1, active: false, currentElo: 2000 }),
      row({ id: 2, active: true, currentElo: 1000 }),
    ];
    const sorted = sortFranchiseIndex(rows);
    expect(sorted.map((r) => r.id)).toEqual([2, 1]);
  });

  it("orders active franchises by current Elo descending", () => {
    const rows = [
      row({ id: 1, active: true, currentElo: 1400 }),
      row({ id: 2, active: true, currentElo: 1700 }),
      row({ id: 3, active: true, currentElo: 1550 }),
    ];
    const sorted = sortFranchiseIndex(rows);
    expect(sorted.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("orders departed franchises by current Elo descending too, after all active ones", () => {
    const rows = [
      row({ id: 1, active: false, currentElo: 1300 }),
      row({ id: 2, active: false, currentElo: 1600 }),
      row({ id: 3, active: true, currentElo: 1000 }),
    ];
    const sorted = sortFranchiseIndex(rows);
    expect(sorted.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("does not mutate the input array", () => {
    const rows = [row({ id: 1, active: true, currentElo: 1000 }), row({ id: 2, active: true, currentElo: 2000 })];
    const original = [...rows];
    sortFranchiseIndex(rows);
    expect(rows).toEqual(original);
  });
});

describe("buildEloSeries", () => {
  it("assigns a sequential x index across a franchise's own rows, skipping no positions", () => {
    const series = buildEloSeries([
      { season: 2015, week: 1, eloPost: 1500 },
      { season: 2015, week: 2, eloPost: 1520 },
      { season: 2016, week: 1, eloPost: 1490 },
    ]);
    expect(series.points.map((p) => p.x)).toEqual([0, 1, 2]);
    expect(series.points.map((p) => p.elo)).toEqual([1500, 1520, 1490]);
  });

  it("sorts input defensively by season then week before assigning x", () => {
    const series = buildEloSeries([
      { season: 2016, week: 1, eloPost: 1490 },
      { season: 2015, week: 2, eloPost: 1520 },
      { season: 2015, week: 1, eloPost: 1500 },
    ]);
    expect(series.points.map((p) => `${p.season}:${p.week}`)).toEqual(["2015:1", "2015:2", "2016:1"]);
  });

  it("places a season boundary tick at the x of the FIRST point of every new season", () => {
    const series = buildEloSeries([
      { season: 2015, week: 1, eloPost: 1500 },
      { season: 2015, week: 2, eloPost: 1510 },
      { season: 2016, week: 1, eloPost: 1495 },
      { season: 2016, week: 2, eloPost: 1500 },
      { season: 2017, week: 1, eloPost: 1505 },
    ]);
    expect(series.seasonTicks).toEqual([
      { x: 0, season: 2015 },
      { x: 2, season: 2016 },
      { x: 4, season: 2017 },
    ]);
  });

  it("produces one tick per season even for a single-season franchise", () => {
    const series = buildEloSeries([{ season: 2021, week: 1, eloPost: 1500 }]);
    expect(series.seasonTicks).toEqual([{ x: 0, season: 2021 }]);
  });

  it("returns empty points/ticks for no history", () => {
    const series = buildEloSeries([]);
    expect(series.points).toEqual([]);
    expect(series.seasonTicks).toEqual([]);
  });

  it("downsamples when a franchise's history exceeds maxPoints, but always keeps the final point", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ season: 2015, week: i + 1, eloPost: 1500 + i }));
    const series = buildEloSeries(rows, 5);
    expect(series.points.length).toBeLessThanOrEqual(6);
    expect(series.points[series.points.length - 1]!.elo).toBe(1519); // last real point always kept
  });

  it("every point starts with both season-dot flags false", () => {
    const series = buildEloSeries([{ season: 2015, week: 1, eloPost: 1500 }]);
    expect(series.points[0]).toMatchObject({ isChampionSeason: false, isSackoSeason: false });
  });
});

function point(overrides: Partial<EloPoint>): EloPoint {
  return { x: 0, season: 2015, week: 1, elo: 1500, isChampionSeason: false, isSackoSeason: false, ...overrides };
}

describe("markSeasonEndDots", () => {
  it("marks only the LAST point of a championship season, not every point in that season", () => {
    const points = [point({ x: 0, season: 2015, week: 1, elo: 1500 }), point({ x: 1, season: 2015, week: 2, elo: 1510 }), point({ x: 2, season: 2016, week: 1, elo: 1490 })];
    const marked = markSeasonEndDots(points, new Set([2015]), new Set());
    expect(marked[0]!.isChampionSeason).toBe(false);
    expect(marked[1]!.isChampionSeason).toBe(true);
    expect(marked[2]!.isChampionSeason).toBe(false);
  });

  it("marks championship and sacko seasons independently, both false when neither set matches", () => {
    const points = [point({ x: 0, season: 2015 }), point({ x: 1, season: 2016 })];
    const marked = markSeasonEndDots(points, new Set([2015]), new Set([2016]));
    expect(marked[0]).toMatchObject({ isChampionSeason: true, isSackoSeason: false });
    expect(marked[1]).toMatchObject({ isChampionSeason: false, isSackoSeason: true });
  });

  it("does not mutate the input array or its objects", () => {
    const points = [point({ x: 0, season: 2015 })];
    const original = JSON.parse(JSON.stringify(points));
    markSeasonEndDots(points, new Set([2015]), new Set());
    expect(points).toEqual(original);
  });

  it("returns points unchanged for an empty series", () => {
    expect(markSeasonEndDots([], new Set([2015]), new Set())).toEqual([]);
  });
});

describe("findEloPeak", () => {
  it("returns the point with the highest elo", () => {
    const points = [point({ x: 0, elo: 1500 }), point({ x: 1, elo: 1650 }), point({ x: 2, elo: 1600 })];
    expect(findEloPeak(points)!.elo).toBe(1650);
  });

  it("keeps the FIRST occurrence on a tie", () => {
    const points = [point({ x: 0, elo: 1600, week: 3 }), point({ x: 1, elo: 1600, week: 9 })];
    expect(findEloPeak(points)!.week).toBe(3);
  });

  it("returns null for an empty series", () => {
    expect(findEloPeak([])).toBeNull();
  });
});

describe("countActiveFranchisesWithoutBelt", () => {
  it("counts only ACTIVE franchises with zero belt reigns", () => {
    const rows = [
      { active: true, beltReignCount: 0 },
      { active: true, beltReignCount: 3 },
      { active: false, beltReignCount: 0 }, // departed — doesn't count
    ];
    expect(countActiveFranchisesWithoutBelt(rows)).toBe(1);
  });

  it("returns 0 when every active franchise has held the belt", () => {
    expect(countActiveFranchisesWithoutBelt([{ active: true, beltReignCount: 1 }])).toBe(0);
  });
});
