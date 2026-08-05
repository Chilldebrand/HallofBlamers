import { describe, expect, it } from "vitest";
import {
  computeTimelineSortKey,
  filterTimelineEntries,
  getAvailableFranchises,
  getAvailableSeasons,
  sortTimelineEntries,
  type TimelineEntry,
} from "../queries";

function entry(overrides: Partial<TimelineEntry>): TimelineEntry {
  return {
    type: "championship",
    season: 2020,
    week: null,
    franchiseId: 1,
    franchiseName: "Team A",
    eyebrow: "Champion",
    statement: "Team A won.",
    href: "/seasons/2020",
    gold: true,
    ...overrides,
  };
}

describe("computeTimelineSortKey", () => {
  it("orders arrival before a week-specific event before championship/sacko before departure, within the same season", () => {
    const arrival = computeTimelineSortKey("arrival", 2020, null);
    const belt = computeTimelineSortKey("belt_transfer", 2020, 5);
    const record = computeTimelineSortKey("record", 2020, null);
    const championship = computeTimelineSortKey("championship", 2020, null);
    const departure = computeTimelineSortKey("departure", 2020, null);
    expect(arrival).toBeLessThan(record);
    expect(record).toBeLessThan(belt);
    expect(belt).toBeLessThan(championship);
    expect(championship).toBeLessThan(departure);
  });

  it("always ranks a later season above every event in an earlier season", () => {
    const earlySeasonDeparture = computeTimelineSortKey("departure", 2019, null);
    const lateSeasonArrival = computeTimelineSortKey("arrival", 2020, null);
    expect(lateSeasonArrival).toBeGreaterThan(earlySeasonDeparture);
  });

  it("orders week-specific events by week within the same season", () => {
    const wk1 = computeTimelineSortKey("belt_transfer", 2020, 1);
    const wk10 = computeTimelineSortKey("belt_transfer", 2020, 10);
    expect(wk10).toBeGreaterThan(wk1);
  });
});

describe("sortTimelineEntries", () => {
  it("sorts newest first", () => {
    const entries = [entry({ season: 2018 }), entry({ season: 2022 }), entry({ season: 2020 })];
    const sorted = sortTimelineEntries(entries);
    expect(sorted.map((e) => e.season)).toEqual([2022, 2020, 2018]);
  });

  it("does not mutate the input array", () => {
    const entries = [entry({ season: 2018 }), entry({ season: 2022 })];
    const copy = [...entries];
    sortTimelineEntries(entries);
    expect(entries).toEqual(copy);
  });

  it("breaks ties deterministically by type name", () => {
    const a = entry({ season: 2020, type: "sacko", week: null });
    const b = entry({ season: 2020, type: "championship", week: null });
    const sorted = sortTimelineEntries([a, b]);
    expect(sorted.map((e) => e.type)).toEqual(["championship", "sacko"]); // alphabetical tiebreak
  });
});

describe("filterTimelineEntries", () => {
  const entries = [
    entry({ season: 2020, franchiseId: 1, type: "championship" }),
    entry({ season: 2020, franchiseId: 2, type: "sacko" }),
    entry({ season: 2021, franchiseId: 1, type: "belt_transfer" }),
  ];

  it("returns everything with no filters", () => {
    expect(filterTimelineEntries(entries, {})).toHaveLength(3);
  });

  it("filters by season", () => {
    expect(filterTimelineEntries(entries, { season: 2020 })).toHaveLength(2);
  });

  it("filters by franchiseId", () => {
    expect(filterTimelineEntries(entries, { franchiseId: 1 })).toHaveLength(2);
  });

  it("filters by type", () => {
    expect(filterTimelineEntries(entries, { type: "sacko" })).toHaveLength(1);
  });

  it("combines filters with AND semantics", () => {
    expect(filterTimelineEntries(entries, { season: 2020, franchiseId: 1 })).toHaveLength(1);
  });
});

describe("getAvailableSeasons / getAvailableFranchises", () => {
  it("returns distinct seasons, newest first", () => {
    const entries = [entry({ season: 2019 }), entry({ season: 2021 }), entry({ season: 2019 })];
    expect(getAvailableSeasons(entries)).toEqual([2021, 2019]);
  });

  it("returns distinct franchises, alphabetical, excluding null franchiseId", () => {
    const entries = [
      entry({ franchiseId: 2, franchiseName: "Beta" }),
      entry({ franchiseId: 1, franchiseName: "Alpha" }),
      entry({ franchiseId: null, franchiseName: "N/A" }),
      entry({ franchiseId: 1, franchiseName: "Alpha" }),
    ];
    expect(getAvailableFranchises(entries)).toEqual([
      { id: 1, name: "Alpha" },
      { id: 2, name: "Beta" },
    ]);
  });
});
