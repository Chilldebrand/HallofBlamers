import { describe, expect, it } from "vitest";
import { ELO_START } from "../replay";
import {
  computeAlgorithmPicks,
  computeCurrentPickemWeek,
  computeSeasonLeaderboard,
  computeWeeklyPoints,
  hasAnyGameBegun,
  type PickemLockMatchupSignal,
  type PickemMatchupResult,
  type PickemPickInput,
  type PickemWeekSignal,
  type WeeklyPointsRow,
} from "../pickem";

describe("computeCurrentPickemWeek", () => {
  it("returns null with no signals at all", () => {
    expect(computeCurrentPickemWeek([])).toBeNull();
  });

  it("real 2026 preseason case: a full 14-week schedule generated, zero final matchups -> week 1 is current", () => {
    const signals: PickemWeekSignal[] = Array.from({ length: 14 }, (_, i) => ({ season: 2026, week: i + 1, allFinal: false }));
    expect(computeCurrentPickemWeek(signals)).toEqual({ season: 2026, week: 1 });
  });

  it("once week 1 goes fully final, week 2 becomes current immediately — does not wait for week 2 to have started", () => {
    const signals: PickemWeekSignal[] = [
      { season: 2026, week: 1, allFinal: true },
      { season: 2026, week: 2, allFinal: false },
      { season: 2026, week: 3, allFinal: false },
    ];
    expect(computeCurrentPickemWeek(signals)).toEqual({ season: 2026, week: 2 });
  });

  it("only considers the newest season", () => {
    const signals: PickemWeekSignal[] = [
      { season: 2025, week: 17, allFinal: true },
      { season: 2026, week: 1, allFinal: false },
    ];
    expect(computeCurrentPickemWeek(signals)).toEqual({ season: 2026, week: 1 });
  });

  it("returns null once every generated week of the newest season is fully final (nothing open)", () => {
    const signals: PickemWeekSignal[] = [
      { season: 2026, week: 1, allFinal: true },
      { season: 2026, week: 2, allFinal: true },
    ];
    expect(computeCurrentPickemWeek(signals)).toBeNull();
  });

  it("a bye-only week (isFinal true by construction) never blocks itself from being 'current' if it's the earliest open week", () => {
    // A week can have `allFinal: true` purely because every real matchup already finished AND the
    // bye trivially counted as final too — this test just documents that a week signal here is a
    // pre-aggregated boolean; the bye-final behavior itself lives in normalize.ts, not this engine.
    const signals: PickemWeekSignal[] = [{ season: 2026, week: 1, allFinal: false }];
    expect(computeCurrentPickemWeek(signals)).toEqual({ season: 2026, week: 1 });
  });
});

describe("hasAnyGameBegun — fix round 1 (the data-driven lock floor)", () => {
  it("false for an untouched preseason schedule shell: every matchup 0-0, none final", () => {
    const matchups: PickemLockMatchupSignal[] = [
      { isFinal: false, homeScore: 0, awayScore: 0 },
      { isFinal: false, homeScore: 0, awayScore: 0 },
    ];
    expect(hasAnyGameBegun(matchups)).toBe(false);
  });

  it("true the instant ANY matchup's score moves off zero, even mid-live and not yet final", () => {
    const matchups: PickemLockMatchupSignal[] = [
      { isFinal: false, homeScore: 0, awayScore: 0 },
      { isFinal: false, homeScore: 14.2, awayScore: 0 },
    ];
    expect(hasAnyGameBegun(matchups)).toBe(true);
  });

  it("true when any matchup is already final, regardless of score", () => {
    const matchups: PickemLockMatchupSignal[] = [{ isFinal: true, homeScore: 0, awayScore: 0 }];
    expect(hasAnyGameBegun(matchups)).toBe(true);
  });

  it("false for an empty matchup list (nothing to have begun)", () => {
    expect(hasAnyGameBegun([])).toBe(false);
  });
});

describe("computeAlgorithmPicks — determinism", () => {
  it("picks the higher-Elo side", () => {
    const result = computeAlgorithmPicks(
      [{ matchupId: 1, homeFranchiseId: 10, awayFranchiseId: 20 }],
      new Map([
        [10, 1600],
        [20, 1400],
      ]),
    );
    expect(result).toEqual([{ matchupId: 1, pickedFranchiseId: 10 }]);
  });

  it("picks the away side when its Elo is higher", () => {
    const result = computeAlgorithmPicks(
      [{ matchupId: 1, homeFranchiseId: 10, awayFranchiseId: 20 }],
      new Map([
        [10, 1400],
        [20, 1600],
      ]),
    );
    expect(result).toEqual([{ matchupId: 1, pickedFranchiseId: 20 }]);
  });

  it("defaults an unrated franchise to ELO_START (1500) — never fabricated", () => {
    const result = computeAlgorithmPicks([{ matchupId: 1, homeFranchiseId: 10, awayFranchiseId: 20 }], new Map([[10, 1600]]));
    // homeElo 1600 > awayElo defaulted to ELO_START(1500) -> home favored.
    expect(result).toEqual([{ matchupId: 1, pickedFranchiseId: 10 }]);
    expect(ELO_START).toBe(1500);
  });

  it("an exact Elo tie deterministically favors the home side, never a coin flip", () => {
    const input = [{ matchupId: 1, homeFranchiseId: 10, awayFranchiseId: 20 }];
    const elo = new Map([
      [10, 1500],
      [20, 1500],
    ]);
    const first = computeAlgorithmPicks(input, elo);
    const second = computeAlgorithmPicks(input, elo);
    expect(first).toEqual(second);
    expect(first).toEqual([{ matchupId: 1, pickedFranchiseId: 10 }]);
  });

  it("same Elo state -> same picks across repeated calls and multiple matchups (the brief's determinism requirement)", () => {
    const matchups = [
      { matchupId: 1, homeFranchiseId: 10, awayFranchiseId: 20 },
      { matchupId: 2, homeFranchiseId: 30, awayFranchiseId: 40 },
      { matchupId: 3, homeFranchiseId: 50, awayFranchiseId: 60 },
    ];
    const elo = new Map([
      [10, 1550],
      [20, 1450],
      [30, 1480],
      [40, 1520],
      [50, 1500],
      [60, 1500],
    ]);
    const runs = Array.from({ length: 5 }, () => computeAlgorithmPicks(matchups, elo));
    for (const run of runs) expect(run).toEqual(runs[0]);
  });
});

describe("computeWeeklyPoints — only-final scoring, no partial credit", () => {
  it("awards 1 point per correct pick on a final matchup", () => {
    const picks: PickemPickInput[] = [
      { entrantId: "A", matchupId: 1, pickedFranchiseId: 10 },
      { entrantId: "A", matchupId: 2, pickedFranchiseId: 30 },
    ];
    const results: PickemMatchupResult[] = [
      { matchupId: 1, isFinal: true, winningFranchiseId: 10 },
      { matchupId: 2, isFinal: true, winningFranchiseId: 40 },
    ];
    const points = computeWeeklyPoints(picks, results);
    expect(points.get("A")).toBe(1);
  });

  it("a pick against a NOT-YET-FINAL matchup scores 0, never partial/pending credit", () => {
    const picks: PickemPickInput[] = [{ entrantId: "A", matchupId: 1, pickedFranchiseId: 10 }];
    const results: PickemMatchupResult[] = [{ matchupId: 1, isFinal: false, winningFranchiseId: null }];
    expect(computeWeeklyPoints(picks, results).get("A")).toBe(0);
  });

  it("a tie matchup (winningFranchiseId null even though final) awards 0 to everyone — nobody 'won' to have been called correctly", () => {
    const picks: PickemPickInput[] = [
      { entrantId: "A", matchupId: 1, pickedFranchiseId: 10 },
      { entrantId: "B", matchupId: 1, pickedFranchiseId: 20 },
    ];
    const results: PickemMatchupResult[] = [{ matchupId: 1, isFinal: true, winningFranchiseId: null }];
    const points = computeWeeklyPoints(picks, results);
    expect(points.get("A")).toBe(0);
    expect(points.get("B")).toBe(0);
  });

  it("an entrant with zero correct picks still appears in the output at 0", () => {
    const picks: PickemPickInput[] = [{ entrantId: "A", matchupId: 1, pickedFranchiseId: 20 }];
    const results: PickemMatchupResult[] = [{ matchupId: 1, isFinal: true, winningFranchiseId: 10 }];
    const points = computeWeeklyPoints(picks, results);
    expect(points.has("A")).toBe(true);
    expect(points.get("A")).toBe(0);
  });

  it("a pick referencing a matchup with no result row at all scores 0 (defensive, never throws)", () => {
    const picks: PickemPickInput[] = [{ entrantId: "A", matchupId: 999, pickedFranchiseId: 10 }];
    expect(computeWeeklyPoints(picks, []).get("A")).toBe(0);
  });
});

describe("computeSeasonLeaderboard — total points, weeks won, ties share rank", () => {
  it("sums points across weeks and ranks by total desc", () => {
    const rows: WeeklyPointsRow[] = [
      { entrantId: "A", week: 1, points: 5 },
      { entrantId: "A", week: 2, points: 3 },
      { entrantId: "B", week: 1, points: 4 },
      { entrantId: "B", week: 2, points: 4 },
    ];
    const board = computeSeasonLeaderboard(rows);
    expect(board).toEqual([
      { entrantId: "A", totalPoints: 8, weeksWon: 1, rank: 1 },
      { entrantId: "B", totalPoints: 8, weeksWon: 1, rank: 1 },
    ]);
  });

  it("a tied top score in a week credits BOTH entrants a week won (co-champions)", () => {
    const rows: WeeklyPointsRow[] = [
      { entrantId: "A", week: 1, points: 5 },
      { entrantId: "B", week: 1, points: 5 },
      { entrantId: "C", week: 1, points: 2 },
    ];
    const board = computeSeasonLeaderboard(rows);
    const won = new Map(board.map((r) => [r.entrantId, r.weeksWon]));
    expect(won.get("A")).toBe(1);
    expect(won.get("B")).toBe(1);
    expect(won.get("C")).toBe(0);
  });

  it("standard competition ranking: ties share the better rank, next rank skips (1, 1, 3)", () => {
    const rows: WeeklyPointsRow[] = [
      { entrantId: "A", week: 1, points: 10 },
      { entrantId: "B", week: 1, points: 10 },
      { entrantId: "C", week: 1, points: 5 },
    ];
    const board = computeSeasonLeaderboard(rows);
    const rankOf = (id: string) => board.find((r) => r.entrantId === id)!.rank;
    expect(rankOf("A")).toBe(1);
    expect(rankOf("B")).toBe(1);
    expect(rankOf("C")).toBe(3);
  });

  it("output order is deterministic (secondary sort by entrantId) regardless of input order", () => {
    const rowsA: WeeklyPointsRow[] = [
      { entrantId: "Z", week: 1, points: 3 },
      { entrantId: "A", week: 1, points: 3 },
    ];
    const rowsB: WeeklyPointsRow[] = [
      { entrantId: "A", week: 1, points: 3 },
      { entrantId: "Z", week: 1, points: 3 },
    ];
    expect(computeSeasonLeaderboard(rowsA)).toEqual(computeSeasonLeaderboard(rowsB));
  });
});
