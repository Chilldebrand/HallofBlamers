import { describe, expect, it } from "vitest";
import { computeBeltRecords, findReignNoForGame, type ReignSpan } from "../belt";

describe("computeBeltRecords", () => {
  it("counts reigns per franchise and picks the max for mostReigns", () => {
    const result = computeBeltRecords([
      { franchiseId: 1, weeksHeld: 2, defenses: 0, startSeason: 2015, startWeek: 16 },
      { franchiseId: 1, weeksHeld: 3, defenses: 1, startSeason: 2016, startWeek: 5 },
      { franchiseId: 2, weeksHeld: 5, defenses: 2, startSeason: 2017, startWeek: 1 },
    ]);
    expect(result.mostReigns).toEqual({ franchiseId: 1, count: 2 });
  });

  it("sums defenses per franchise across every reign for mostDefenses", () => {
    const result = computeBeltRecords([
      { franchiseId: 1, weeksHeld: 2, defenses: 3, startSeason: 2015, startWeek: 16 },
      { franchiseId: 1, weeksHeld: 3, defenses: 4, startSeason: 2016, startWeek: 5 },
      { franchiseId: 2, weeksHeld: 5, defenses: 6, startSeason: 2017, startWeek: 1 },
    ]);
    expect(result.mostDefenses).toEqual({ franchiseId: 1, defenses: 7 });
  });

  it("picks the single longest reign by weeksHeld, not summed", () => {
    const result = computeBeltRecords([
      { franchiseId: 1, weeksHeld: 11, defenses: 6, startSeason: 2022, startWeek: 15 },
      { franchiseId: 2, weeksHeld: 4, defenses: 1, startSeason: 2025, startWeek: 11 },
    ]);
    expect(result.longestReign).toEqual({ franchiseId: 1, weeksHeld: 11, startSeason: 2022, startWeek: 15 });
  });

  it("returns all-null for no reigns (a brand new league)", () => {
    expect(computeBeltRecords([])).toEqual({ mostReigns: null, longestReign: null, mostDefenses: null });
  });
});

describe("findReignNoForGame", () => {
  const reigns: ReignSpan[] = [
    { reignNo: 1, franchiseId: 1, startSeason: 2015, startWeek: 16, endSeason: 2016, endWeek: 4 },
    { reignNo: 2, franchiseId: 2, startSeason: 2016, startWeek: 5, endSeason: 2019, endWeek: 8 },
    { reignNo: 3, franchiseId: 1, startSeason: 2019, startWeek: 9, endSeason: null, endWeek: null }, // current
  ];

  it("finds the reign whose span encloses the game's (season, week), for a historical defense", () => {
    expect(findReignNoForGame(reigns, 2, 2017, 3)).toBe(2);
  });

  it("matches the exact start of a reign (the title-winning game itself)", () => {
    expect(findReignNoForGame(reigns, 2, 2016, 5)).toBe(2);
  });

  it("matches the exact end of a reign (the title-losing game itself)", () => {
    expect(findReignNoForGame(reigns, 2, 2019, 8)).toBe(2);
  });

  it("an open-ended (still current) reign matches anything from its start onward", () => {
    expect(findReignNoForGame(reigns, 1, 2025, 17)).toBe(3);
  });

  it("returns null when the franchise never held the belt at that point", () => {
    expect(findReignNoForGame(reigns, 999, 2020, 1)).toBeNull();
  });

  it("returns null for a franchise's OWN game outside any of its own reigns (e.g. before it first won)", () => {
    expect(findReignNoForGame(reigns, 1, 2017, 1)).toBeNull();
  });
});
