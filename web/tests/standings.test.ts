import { expect, test } from "vitest";
import { buildStandings, type StandingsSource } from "../src/api/standings";

const source: StandingsSource = {
  seasonOptions: [{ season: 2026, status: "upcoming" }, { season: 2025, status: "complete" }],
  seasons: [{ season: 2025, status: "complete", teamCount: 2 }, { season: 2026, status: "upcoming", teamCount: 2 }],
  franchises: [{ id: 1, canonicalName: "First", active: true }, { id: 2, canonicalName: "Second", active: false }],
  teamSeasons: [{ season: 2025, franchiseId: 1, wins: 1, losses: 0, ties: 1, pointsFor: 210, pointsAgainst: 200, finalStanding: 1 }],
  seasonStats: [{ season: 2025, franchiseId: 1, champion: true, sacko: false, allplayW: 1, allplayL: 0, allplayT: 1, luckTotal: 0 }],
  careerStats: [],
  weeks: [{ season: 2025, week: 1 }, { season: 2025, week: 2 }],
  weekResults: [{ franchiseId: 1, season: 2025, week: 1, result: "W", margin: 10 }, { franchiseId: 1, season: 2025, week: 2, result: "T", margin: 0 }],
};
test("defaults to the latest played season and ties reset the current streak", () => {
  const result = buildStandings(source, {});
  expect(result.scope).toBe(2025);
  expect(result.real[0].streak).toEqual({ type: null, count: 0 });
  expect(result.real[0].last5Sequence).toEqual(["W", "T"]);
  expect(result.luck[0].realWinPct).toBe(0.75);
  expect(result.summary?.weekCount).toBe(2);
});
test("career retains departed franchises and honest zero records", () => {
  const result = buildStandings(source, { season: "career", tab: "allplay" });
  expect(result.tab).toBe("luck");
  expect(result.career.map(r => [r.franchiseId, r.active, r.winPct])).toEqual([[1,true,0],[2,false,0]]);
});
test("upcoming seasons stay empty and unknown years use the played default", () => {
  expect(buildStandings(source, { season: "2026" }).real).toEqual([]);
  expect(buildStandings(source, { season: "bogus" }).scope).toBe(2025);
});
