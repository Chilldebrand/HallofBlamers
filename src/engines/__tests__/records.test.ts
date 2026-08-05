import { describe, expect, it } from "vitest";
import { buildRecordEntries, computeWeeklyBeatdowns, topRecords, type BeatdownTeamWeekInput, type RecordCandidate, type RecordsInput } from "../records";

function cand(franchiseId: number, value: number, season = 2024, week: number | null = 1): RecordCandidate {
  return { franchiseId, season, week, value, weekType: "regular" };
}

describe("topRecords", () => {
  it("ranks descending, best value first", () => {
    const result = topRecords([cand(1, 100), cand(2, 130), cand(3, 90)], "desc");
    expect(result.map((r) => [r.franchiseId, r.rank])).toEqual([
      [2, 1],
      [1, 2],
      [3, 3],
    ]);
  });

  it("ranks ascending when direction is 'asc'", () => {
    const result = topRecords([cand(1, 100), cand(2, 130), cand(3, 90)], "asc");
    expect(result.map((r) => [r.franchiseId, r.rank])).toEqual([
      [3, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("ties share the better rank (standard competition ranking: 1,2,2,4)", () => {
    const result = topRecords([cand(1, 100), cand(2, 100), cand(3, 90), cand(4, 80)], "desc");
    expect(result.map((r) => r.rank)).toEqual([1, 1, 3, 4]);
  });

  it("tie-handling exactly at the rank-10 boundary: a multi-way tie for the last spot still shares one rank, and the list never exceeds the row cap", () => {
    // 9 distinct values ranked 1-9, then a 4-way tie all sharing rank 10 — 13 rows would
    // logically qualify, but the row cap keeps the OUTPUT at 10 rows total.
    const distinct = Array.from({ length: 9 }, (_, i) => cand(i + 1, 100 - i)); // values 100..92, franchises 1..9
    const tied = [cand(10, 91), cand(11, 91), cand(12, 91), cand(13, 91)];
    const result = topRecords([...distinct, ...tied], "desc", 10);

    expect(result).toHaveLength(10);
    expect(result.slice(0, 9).map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // Only ONE of the four rank-10-tied entries fits within the 10-row cap.
    const rank10Rows = result.filter((r) => r.rank === 10);
    expect(rank10Rows).toHaveLength(1);
    expect([10, 11, 12, 13]).toContain(rank10Rows[0]!.franchiseId);
  });

  it("caps the list at `limit` rows when there are no ties at the boundary", () => {
    const many = Array.from({ length: 15 }, (_, i) => cand(i + 1, 100 - i));
    expect(topRecords(many, "desc", 10)).toHaveLength(10);
  });

  it("returns an empty list for no candidates", () => {
    expect(topRecords([], "desc")).toEqual([]);
  });
});

describe("buildRecordEntries", () => {
  const baseInput: RecordsInput = {
    teamWeeks: [
      // franchise 1: a blowout win, high score
      { franchiseId: 1, season: 2024, week: 1, weekType: "regular", score: 150, result: "W", margin: 60, benchPointsLeft: 5, opponentFranchiseId: 2, isChampionshipGame: false },
      // franchise 2: the loss side of that blowout
      { franchiseId: 2, season: 2024, week: 1, weekType: "regular", score: 90, result: "L", margin: -60, benchPointsLeft: 0, opponentFranchiseId: 1, isChampionshipGame: false },
      // franchise 3: a close win
      { franchiseId: 3, season: 2024, week: 2, weekType: "regular", score: 101, result: "W", margin: 1, benchPointsLeft: null, opponentFranchiseId: 4, isChampionshipGame: false },
      { franchiseId: 4, season: 2024, week: 2, weekType: "regular", score: 100, result: "L", margin: -1, benchPointsLeft: 2, opponentFranchiseId: 3, isChampionshipGame: false },
      // a consolation-bracket game — must be excluded entirely from every key
      { franchiseId: 1, season: 2024, week: 15, weekType: "consolation", score: 999, result: "W", margin: 900, benchPointsLeft: 999, opponentFranchiseId: 5, isChampionshipGame: false },
      { franchiseId: 5, season: 2024, week: 15, weekType: "consolation", score: 99, result: "L", margin: -900, benchPointsLeft: 0, opponentFranchiseId: 1, isChampionshipGame: false },
      // the actual championship game
      { franchiseId: 1, season: 2024, week: 17, weekType: "playoff", score: 140, result: "W", margin: 20, benchPointsLeft: 3, opponentFranchiseId: 3, isChampionshipGame: true },
      { franchiseId: 3, season: 2024, week: 17, weekType: "playoff", score: 120, result: "L", margin: -20, benchPointsLeft: 1, opponentFranchiseId: 1, isChampionshipGame: true },
    ],
    seasonStats: [
      { franchiseId: 1, season: 2024, pointsFor: 1800, pointsAgainst: 1500, wins: 12, losses: 2, ties: 0, seasonComplete: true },
      { franchiseId: 2, season: 2024, pointsFor: 1400, pointsAgainst: 1700, wins: 3, losses: 11, ties: 0, seasonComplete: true },
    ],
    beltReigns: [
      { franchiseId: 1, startSeason: 2024, startWeek: 17, weeksHeld: 30 },
      { franchiseId: 2, startSeason: 2018, startWeek: 16, weeksHeld: 5 },
    ],
    streaks: [
      { franchiseId: 1, longestWinStreak: { count: 8, startSeason: 2023, startWeek: 10, endSeason: 2024, endWeek: 3 }, longestLossStreak: null },
      { franchiseId: 2, longestWinStreak: null, longestLossStreak: { count: 6, startSeason: 2024, startWeek: 1, endSeason: 2024, endWeek: 6 } },
    ],
  };

  it("excludes consolation-bracket team-weeks from every team-week-sourced key", () => {
    const entries = buildRecordEntries(baseInput);
    for (const key of [
      "highest_week_score",
      "lowest_week_score",
      "largest_blowout",
      "closest_game",
      "most_points_in_loss",
      "fewest_points_in_win",
      "highest_bench_points_left",
      "worst_beatdown",
    ] as const) {
      expect(entries[key].some((e) => e.week === 15)).toBe(false);
    }
    // the 999-point consolation "win" must never appear as the highest score
    expect(entries.highest_week_score[0]!.value).not.toBe(999);
    // the -900 consolation "beatdown" must never appear as the worst beatdown either
    expect(entries.worst_beatdown.some((e) => e.value === -900)).toBe(false);
  });

  it("worst_beatdown ranks by margin ascending (most negative first), attributed to the LOSER, detail carries winner + both scores", () => {
    const entries = buildRecordEntries(baseInput);
    // franchise 2 lost 90-150 (margin -60) in week 1 — the worst of the 3 eligible losses.
    expect(entries.worst_beatdown[0]).toMatchObject({ franchiseId: 2, season: 2024, week: 1, value: -60, rank: 1 });
    expect(entries.worst_beatdown[0]!.detail).toMatchObject({ winnerFranchiseId: 1, winnerScore: 150, loserScore: 90 });
    // franchise 4 lost 100-101 (margin -1) — the mildest loss, ranks last of the 3.
    expect(entries.worst_beatdown[entries.worst_beatdown.length - 1]).toMatchObject({ franchiseId: 4, value: -1 });
  });

  it("highest_week_score / lowest_week_score rank by score across regular+playoff", () => {
    const entries = buildRecordEntries(baseInput);
    expect(entries.highest_week_score[0]).toMatchObject({ franchiseId: 1, week: 1, value: 150, rank: 1 });
    expect(entries.lowest_week_score[0]).toMatchObject({ value: 90, rank: 1 });
  });

  it("largest_blowout / closest_game use the WINNER's margin only, avoiding double-counting the same game", () => {
    const entries = buildRecordEntries(baseInput);
    expect(entries.largest_blowout[0]).toMatchObject({ franchiseId: 1, value: 60 });
    expect(entries.closest_game[0]).toMatchObject({ franchiseId: 3, value: 1 });
    // exactly one entry per matchup (winner's side), not two
    expect(entries.largest_blowout.filter((e) => e.season === 2024 && e.week === 1)).toHaveLength(1);
  });

  it("highest_championship_score only draws from team-weeks flagged isChampionshipGame", () => {
    const entries = buildRecordEntries(baseInput);
    expect(entries.highest_championship_score.every((e) => e.week === 17)).toBe(true);
    expect(entries.highest_championship_score[0]).toMatchObject({ franchiseId: 1, value: 140 });
  });

  it("best_season_record ranks by win percentage (ties count as half a win)", () => {
    const entries = buildRecordEntries(baseInput);
    expect(entries.best_season_record[0]).toMatchObject({ franchiseId: 1, value: 12 / 14 });
  });

  it("SEASON-scope keys (season totals, win%, points against) exclude an incomplete season even though it has real games played — NOT the same guard as 'has played >=1 game'", () => {
    const withInProgressSeason: RecordsInput = {
      ...baseInput,
      seasonStats: [
        ...baseInput.seasonStats,
        // franchise 6, mid-season: real games played (7-1), a huge single-week-inflated points
        // total that would otherwise crush the season aggregate rankings — but seasonComplete is
        // false, so none of it may rank.
        { franchiseId: 6, season: 2025, pointsFor: 999999, pointsAgainst: 0, wins: 7, losses: 1, ties: 0, seasonComplete: false },
      ],
    };
    const entries = buildRecordEntries(withInProgressSeason);
    for (const key of ["highest_season_total", "lowest_season_total", "best_season_record", "worst_season_record", "most_season_points_against"] as const) {
      expect(entries[key].some((e) => e.franchiseId === 6)).toBe(false);
    }
  });

  it("longest_win_streak / longest_loss_streak surface the streak span in detail", () => {
    const entries = buildRecordEntries(baseInput);
    expect(entries.longest_win_streak[0]).toMatchObject({ franchiseId: 1, value: 8 });
    expect(entries.longest_win_streak[0]!.detail).toMatchObject({ startSeason: 2023, startWeek: 10 });
    expect(entries.longest_loss_streak[0]).toMatchObject({ franchiseId: 2, value: 6 });
  });

  it("longest_belt_reign ranks by weeks_held", () => {
    const entries = buildRecordEntries(baseInput);
    expect(entries.longest_belt_reign[0]).toMatchObject({ franchiseId: 1, value: 30 });
  });

  it("returns every declared record key, even when its source data is empty", () => {
    const empty: RecordsInput = { teamWeeks: [], seasonStats: [], beltReigns: [], streaks: [] };
    const entries = buildRecordEntries(empty);
    for (const key of Object.keys(entries)) {
      expect(entries[key as keyof typeof entries]).toEqual([]);
    }
  });
});

describe("computeWeeklyBeatdowns", () => {
  function btw(over: Partial<BeatdownTeamWeekInput> & { franchiseId: number; season: number; week: number }): BeatdownTeamWeekInput {
    return { result: "L", margin: -10, ...over };
  }

  it("picks the single largest losing margin in a week", () => {
    const awards = computeWeeklyBeatdowns([
      btw({ franchiseId: 1, season: 2024, week: 1, result: "L", margin: -10 }),
      btw({ franchiseId: 2, season: 2024, week: 1, result: "L", margin: -38.4 }),
      btw({ franchiseId: 3, season: 2024, week: 1, result: "W", margin: 10 }),
    ]);
    expect(awards).toEqual([{ franchiseId: 2, season: 2024, week: 1, margin: -38.4 }]);
  });

  it("ties within a week award ALL tied losers, sorted by franchiseId", () => {
    const awards = computeWeeklyBeatdowns([
      btw({ franchiseId: 5, season: 2024, week: 1, margin: -20 }),
      btw({ franchiseId: 2, season: 2024, week: 1, margin: -20 }),
      btw({ franchiseId: 9, season: 2024, week: 1, margin: -5 }), // not tied for worst — excluded
    ]);
    expect(awards).toEqual([
      { franchiseId: 2, season: 2024, week: 1, margin: -20 },
      { franchiseId: 5, season: 2024, week: 1, margin: -20 },
    ]);
  });

  it("a week with no completed losses (e.g. no games, or every decided game was a tie) gets no award", () => {
    expect(computeWeeklyBeatdowns([])).toEqual([]);
    expect(computeWeeklyBeatdowns([btw({ franchiseId: 1, season: 2024, week: 1, result: "T", margin: 0 })])).toEqual([]);
  });

  it("bye/unplayed team-weeks (result null) are never eligible", () => {
    const awards = computeWeeklyBeatdowns([
      btw({ franchiseId: 1, season: 2024, week: 1, result: null, margin: null }),
      btw({ franchiseId: 2, season: 2024, week: 1, result: "L", margin: -15 }),
    ]);
    expect(awards).toEqual([{ franchiseId: 2, season: 2024, week: 1, margin: -15 }]);
  });

  it("playoff AND consolation weeks are fully eligible — a playoff beatdown is still a beatdown", () => {
    const awards = computeWeeklyBeatdowns([
      btw({ franchiseId: 1, season: 2024, week: 17, result: "L", margin: -55 }), // playoff/consolation week
    ]);
    expect(awards).toEqual([{ franchiseId: 1, season: 2024, week: 17, margin: -55 }]);
  });

  it("computes independently per week — different weeks never cross-contaminate each other's award", () => {
    const awards = computeWeeklyBeatdowns([
      btw({ franchiseId: 1, season: 2024, week: 1, margin: -5 }),
      btw({ franchiseId: 2, season: 2024, week: 2, margin: -50 }),
    ]);
    expect(awards).toEqual([
      { franchiseId: 1, season: 2024, week: 1, margin: -5 },
      { franchiseId: 2, season: 2024, week: 2, margin: -50 },
    ]);
  });
});
