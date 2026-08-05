import { describe, expect, it } from "vitest";
import {
  computeAchievements,
  type AchievementAward,
  type AchievementsBeltMatchInput,
  type AchievementsEloInput,
  type AchievementsInput,
  type AchievementsRecordEntryInput,
  type AchievementsTeamWeekInput,
} from "../achievements";
import { BASIC_WEEK_FINAL_WEEKS, BASIC_WEEK_TEAM_WEEKS, BENCH_DISASTER_TEAM_WEEKS } from "../__fixtures__/achievements";

function emptyInput(overrides: Partial<AchievementsInput> = {}): AchievementsInput {
  return {
    teamWeeks: [],
    beltMatches: [],
    elo: [],
    recordEntries: [],
    finalWeeks: new Set(),
    ...overrides,
  };
}

function awardsOf(key: string, awards: AchievementAward[]): AchievementAward[] {
  return awards.filter((a) => a.achievementKey === key);
}

describe("computeAchievements", () => {
  describe("perfect_lineup", () => {
    it("awards exactly the franchise whose efficiency is 1.0, never a franchise with null efficiency (uncomputable optimal)", () => {
      const awards = computeAchievements(
        emptyInput({ teamWeeks: BASIC_WEEK_TEAM_WEEKS, finalWeeks: BASIC_WEEK_FINAL_WEEKS }),
      );
      const perfect = awardsOf("perfect_lineup", awards);
      expect(perfect.map((a) => a.franchiseId)).toEqual([1]); // F1 only: efficiency === 1
      expect(perfect[0]!.payload).toEqual({ score: 120, optimalScore: 120 });
    });

    it("never fires for a null-efficiency team-week even on a huge loss (pre-2018 shape)", () => {
      const tw: AchievementsTeamWeekInput = {
        franchiseId: 42,
        season: 2016,
        week: 1,
        score: 40,
        result: "L",
        margin: -100,
        opponentFranchiseId: 43,
        optimalScore: null,
        efficiency: null,
      };
      const awards = computeAchievements(emptyInput({ teamWeeks: [tw], finalWeeks: new Set(["2016:1"]) }));
      expect(awardsOf("perfect_lineup", awards)).toEqual([]);
      expect(awardsOf("bench_disaster", awards)).toEqual([]);
    });
  });

  describe("bench_disaster", () => {
    it("awards the loser whose optimal lineup would have out-scored the opponent's actual score", () => {
      const awards = computeAchievements(
        emptyInput({ teamWeeks: BENCH_DISASTER_TEAM_WEEKS, finalWeeks: BASIC_WEEK_FINAL_WEEKS }),
      );
      const disasters = awardsOf("bench_disaster", awards);
      expect(disasters).toHaveLength(1);
      expect(disasters[0]).toMatchObject({ franchiseId: 5, season: 2024, week: 2 });
      expect(disasters[0]!.payload).toEqual({ score: 90, optimalScore: 110, opponentFranchiseId: 6, opponentScore: 95 });
    });

    it("does not fire when the optimal lineup would still have lost (or only tied)", () => {
      const stillLoses: AchievementsTeamWeekInput = {
        franchiseId: 7,
        season: 2024,
        week: 2,
        score: 90,
        result: "L",
        margin: -5,
        opponentFranchiseId: 8,
        optimalScore: 94, // opponent scored 95 — optimal still falls short
        efficiency: 90 / 94,
      };
      const wouldTie: AchievementsTeamWeekInput = {
        franchiseId: 9,
        season: 2024,
        week: 2,
        score: 90,
        result: "L",
        margin: -5,
        opponentFranchiseId: 10,
        optimalScore: 95, // exactly ties the opponent's score — "would have WON" requires strictly more
        efficiency: 90 / 95,
      };
      const awards = computeAchievements(emptyInput({ teamWeeks: [stillLoses, wouldTie], finalWeeks: new Set(["2024:2"]) }));
      expect(awardsOf("bench_disaster", awards)).toEqual([]);
    });

    it("never fires for a win (only a LOSS is eligible)", () => {
      const win: AchievementsTeamWeekInput = {
        franchiseId: 11,
        season: 2024,
        week: 2,
        score: 100,
        result: "W",
        margin: 5,
        opponentFranchiseId: 12,
        optimalScore: 150, // huge bench upside, but it's a WIN — bench_disaster is loss-only
        efficiency: 100 / 150,
      };
      const awards = computeAchievements(emptyInput({ teamWeeks: [win], finalWeeks: new Set(["2024:2"]) }));
      expect(awardsOf("bench_disaster", awards)).toEqual([]);
    });
  });

  describe("weekly_high", () => {
    it("awards every franchise tied at the week's top score, and only that score", () => {
      const awards = computeAchievements(
        emptyInput({ teamWeeks: BASIC_WEEK_TEAM_WEEKS, finalWeeks: BASIC_WEEK_FINAL_WEEKS }),
      );
      const high = awardsOf("weekly_high", awards);
      expect(high.map((a) => a.franchiseId).sort((a, b) => a - b)).toEqual([1, 4]); // F1 and F4 tied at 120
      expect(high.every((a) => a.payload?.score === 120)).toBe(true);
    });
  });

  describe("narrow_escape / heartbreaker", () => {
    function marginCase(result: "W" | "L", margin: number): AchievementsTeamWeekInput {
      return {
        franchiseId: 1,
        season: 2024,
        week: 5,
        score: 100,
        result,
        margin,
        opponentFranchiseId: 2,
        optimalScore: null,
        efficiency: null,
      };
    }

    it("awards a win margin strictly under 2.0, excludes exactly 2.0", () => {
      const under = computeAchievements(emptyInput({ teamWeeks: [marginCase("W", 1.99)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("narrow_escape", under)).toHaveLength(1);

      const exact = computeAchievements(emptyInput({ teamWeeks: [marginCase("W", 2.0)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("narrow_escape", exact)).toEqual([]);
    });

    it("awards a loss margin strictly under 2.0, excludes exactly 2.0", () => {
      const under = computeAchievements(emptyInput({ teamWeeks: [marginCase("L", -1.99)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("heartbreaker", under)).toHaveLength(1);

      const exact = computeAchievements(emptyInput({ teamWeeks: [marginCase("L", -2.0)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("heartbreaker", exact)).toEqual([]);
    });

    it("FIX ROUND 1: excludes a decimal-exact 2.00 margin even when raw float subtraction doesn't land on the bit-exact double 2.0 — pinned on both achievements", () => {
      // Real 2-decimal fantasy scores whose true margin is exactly 2.00, but IEEE 754 float
      // subtraction of the two doesn't produce the bit-exact double `2.0`: 128.01 - 126.01 ===
      // 1.9999999999999858 (confirmed via direct computation, not asserted from imagination) — a
      // bare `margin < 2.0` would have incorrectly awarded narrow_escape here. `team_week.margin`
      // is genuinely computed this way (raw `score - opponentScore`, build.ts's
      // `buildTeamWeekCandidates` — never pre-rounded), so this is a realistic score pair, not a
      // contrived float edge case.
      const win = 128.01 - 126.01; // 1.9999999999999858, NOT === 2.0
      expect(win).not.toBe(2.0); // guards the test itself against this someday no longer reproducing
      expect(win).toBeLessThan(2.0); // ...specifically noise that lands on the "include" side of a bare `< 2.0`

      const winAward = computeAchievements(emptyInput({ teamWeeks: [marginCase("W", win)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("narrow_escape", winAward)).toEqual([]);

      const loss = 126.01 - 128.01; // -1.9999999999999858, same noise, mirrored
      expect(loss).not.toBe(-2.0);
      expect(-loss).toBeLessThan(2.0);

      const lossAward = computeAchievements(emptyInput({ teamWeeks: [marginCase("L", loss)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("heartbreaker", lossAward)).toEqual([]);
    });

    it("still awards a margin that's genuinely, non-noisily just under 2.0 (1.98) — the epsilon doesn't swallow real narrow margins", () => {
      const winAward = computeAchievements(emptyInput({ teamWeeks: [marginCase("W", 1.98)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("narrow_escape", winAward)).toHaveLength(1);

      const lossAward = computeAchievements(emptyInput({ teamWeeks: [marginCase("L", -1.98)], finalWeeks: new Set(["2024:5"]) }));
      expect(awardsOf("heartbreaker", lossAward)).toHaveLength(1);
    });
  });

  describe("lucky_winner", () => {
    it("awards a win scored below the week's median, not a win scored above it", () => {
      // A beats B by a hair (50-45); C blows out D (200-190) — the blowout drags the week's
      // median (of [45,50,190,200] -> (50+190)/2 = 120) well above A's winning score.
      const teamWeeks: AchievementsTeamWeekInput[] = [
        { franchiseId: 1, season: 2024, week: 3, score: 50, result: "W", margin: 5, opponentFranchiseId: 2, optimalScore: null, efficiency: null },
        { franchiseId: 2, season: 2024, week: 3, score: 45, result: "L", margin: -5, opponentFranchiseId: 1, optimalScore: null, efficiency: null },
        { franchiseId: 3, season: 2024, week: 3, score: 200, result: "W", margin: 10, opponentFranchiseId: 4, optimalScore: null, efficiency: null },
        { franchiseId: 4, season: 2024, week: 3, score: 190, result: "L", margin: -10, opponentFranchiseId: 3, optimalScore: null, efficiency: null },
      ];
      const awards = computeAchievements(emptyInput({ teamWeeks, finalWeeks: new Set(["2024:3"]) }));
      const lucky = awardsOf("lucky_winner", awards);
      expect(lucky.map((a) => a.franchiseId)).toEqual([1]);
      expect(lucky[0]!.payload).toEqual({ score: 50, median: 120 });
    });

    it("never fires for a loss, even one scored far below the median", () => {
      const teamWeeks: AchievementsTeamWeekInput[] = [
        { franchiseId: 1, season: 2024, week: 3, score: 10, result: "L", margin: -200, opponentFranchiseId: 2, optimalScore: null, efficiency: null },
        { franchiseId: 2, season: 2024, week: 3, score: 210, result: "W", margin: 200, opponentFranchiseId: 1, optimalScore: null, efficiency: null },
      ];
      const awards = computeAchievements(emptyInput({ teamWeeks, finalWeeks: new Set(["2024:3"]) }));
      expect(awardsOf("lucky_winner", awards)).toEqual([]);
    });
  });

  describe("belt_thief / belt_defender", () => {
    it("awards belt_thief to the challenger on a transfer, belt_defender to the holder on a defense", () => {
      const beltMatches: AchievementsBeltMatchInput[] = [
        { matchupId: 1, season: 2024, week: 6, holderFranchiseId: 1, challengerFranchiseId: 2, result: "transfer", holderScore: 90, challengerScore: 100 },
        { matchupId: 2, season: 2024, week: 7, holderFranchiseId: 2, challengerFranchiseId: 3, result: "defense", holderScore: 110, challengerScore: 95 },
      ];
      const finalWeeks = new Set(["2024:6", "2024:7"]);
      const awards = computeAchievements(emptyInput({ beltMatches, finalWeeks }));

      const thief = awardsOf("belt_thief", awards);
      expect(thief).toHaveLength(1);
      expect(thief[0]).toMatchObject({ franchiseId: 2, season: 2024, week: 6 });

      const defender = awardsOf("belt_defender", awards);
      expect(defender).toHaveLength(1);
      expect(defender[0]).toMatchObject({ franchiseId: 2, season: 2024, week: 7 });
    });

    it("withholds belt awards for a week not yet fully final", () => {
      const beltMatches: AchievementsBeltMatchInput[] = [
        { matchupId: 1, season: 2024, week: 6, holderFranchiseId: 1, challengerFranchiseId: 2, result: "transfer", holderScore: 90, challengerScore: 100 },
      ];
      const awards = computeAchievements(emptyInput({ beltMatches, finalWeeks: new Set() }));
      expect(awards).toEqual([]);
    });
  });

  describe("giant_killer", () => {
    function eloWin(gap: number): AchievementsInput {
      const teamWeeks: AchievementsTeamWeekInput[] = [
        { franchiseId: 1, season: 2024, week: 8, score: 100, result: "W", margin: 5, opponentFranchiseId: 2, optimalScore: null, efficiency: null },
      ];
      const elo: AchievementsEloInput[] = [
        { franchiseId: 1, season: 2024, week: 8, eloPre: 1500 },
        { franchiseId: 2, season: 2024, week: 8, eloPre: 1500 + gap },
      ];
      return emptyInput({ teamWeeks, elo, finalWeeks: new Set(["2024:8"]) });
    }

    it("awards a win over an opponent >=150 Elo above you, not one 149 above", () => {
      const at150 = computeAchievements(eloWin(150));
      expect(awardsOf("giant_killer", at150)).toHaveLength(1);
      expect(awardsOf("giant_killer", at150)[0]!.payload).toMatchObject({ gap: 150 });

      const at149 = computeAchievements(eloWin(149));
      expect(awardsOf("giant_killer", at149)).toEqual([]);
    });

    it("never fires when Elo data is missing for either side", () => {
      const teamWeeks: AchievementsTeamWeekInput[] = [
        { franchiseId: 1, season: 2024, week: 8, score: 100, result: "W", margin: 5, opponentFranchiseId: 2, optimalScore: null, efficiency: null },
      ];
      const awards = computeAchievements(emptyInput({ teamWeeks, elo: [], finalWeeks: new Set(["2024:8"]) }));
      expect(awardsOf("giant_killer", awards)).toEqual([]);
    });
  });

  describe("record_breaker", () => {
    it("awards every rank-1, week-scope record_entries row; ignores season-scope (week null) and non-rank-1 rows", () => {
      const recordEntries: AchievementsRecordEntryInput[] = [
        { recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2019, week: 15, value: 187.7 },
        { recordKey: "closest_game", rank: 2, franchiseId: 2, season: 2020, week: 3, value: 0.4 }, // not rank 1
        { recordKey: "highest_season_total", rank: 1, franchiseId: 3, season: 2021, week: null, value: 1800 }, // season-scope, week null
      ];
      const finalWeeks = new Set(["2019:15", "2020:3"]);
      const awards = computeAchievements(emptyInput({ recordEntries, finalWeeks }));
      const breakers = awardsOf("record_breaker", awards);
      expect(breakers).toHaveLength(1);
      expect(breakers[0]).toMatchObject({ franchiseId: 1, season: 2019, week: 15 });
      expect(breakers[0]!.payload).toEqual({ recordKey: "highest_week_score", value: 187.7 });
    });

    it("withholds a record_breaker award for a week not yet fully final, even though it's a real rank-1 record_entries row", () => {
      // record_entries rows are only ever produced by the build for DECIDED team-weeks in
      // practice, but the engine gates on `finalWeeks` here too (not just piggy-backing on the
      // teamWeeks settlement filter) — this proves that independently, mirroring the equivalent
      // belt_thief/belt_defender settlement-gate test above.
      const recordEntries: AchievementsRecordEntryInput[] = [
        { recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2019, week: 15, value: 187.7 },
      ];
      const awards = computeAchievements(emptyInput({ recordEntries, finalWeeks: new Set() }));
      expect(awardsOf("record_breaker", awards)).toEqual([]);
    });

    it("emits one distinctly-keyed award per record key when the same franchise/week holds rank 1 in more than one key", () => {
      const recordEntries: AchievementsRecordEntryInput[] = [
        { recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2019, week: 15, value: 187.7 },
        { recordKey: "highest_bench_points_left", rank: 1, franchiseId: 1, season: 2019, week: 15, value: 40 },
      ];
      const awards = computeAchievements(emptyInput({ recordEntries, finalWeeks: new Set(["2019:15"]) }));
      const breakers = awardsOf("record_breaker", awards);
      expect(breakers).toHaveLength(2);
      const dedupeKeys = new Set(breakers.map((a) => a.dedupeKey));
      expect(dedupeKeys.size).toBe(2); // distinct — recordKey disambiguates the dedupeKey
    });

    it("a tie for rank 1 awards both franchises", () => {
      const recordEntries: AchievementsRecordEntryInput[] = [
        { recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2019, week: 15, value: 150 },
        { recordKey: "highest_week_score", rank: 1, franchiseId: 2, season: 2018, week: 10, value: 150 },
      ];
      const awards = computeAchievements(emptyInput({ recordEntries, finalWeeks: new Set(["2019:15", "2018:10"]) }));
      expect(awardsOf("record_breaker", awards).map((a) => a.franchiseId).sort((a, b) => a - b)).toEqual([1, 2]);
    });
  });

  describe("settlement gate", () => {
    it("produces NO awards for a week that isn't in finalWeeks, even with fully-decided-looking rows", () => {
      const awards = computeAchievements(emptyInput({ teamWeeks: BASIC_WEEK_TEAM_WEEKS, finalWeeks: new Set() }));
      expect(awards).toEqual([]);
    });

    it("produces NO awards for a team-week with a null result (bye/unplayed), even if it's in finalWeeks", () => {
      const bye: AchievementsTeamWeekInput = {
        franchiseId: 1,
        season: 2024,
        week: 9,
        score: 0,
        result: null,
        margin: null,
        opponentFranchiseId: null,
        optimalScore: null,
        efficiency: null,
      };
      const awards = computeAchievements(emptyInput({ teamWeeks: [bye], finalWeeks: new Set(["2024:9"]) }));
      expect(awards).toEqual([]);
    });
  });

  describe("determinism", () => {
    it("is order-independent: shuffled inputs produce the identical output", () => {
      const input: AchievementsInput = {
        teamWeeks: [...BASIC_WEEK_TEAM_WEEKS, ...BENCH_DISASTER_TEAM_WEEKS],
        beltMatches: [
          { matchupId: 1, season: 2024, week: 6, holderFranchiseId: 1, challengerFranchiseId: 2, result: "transfer", holderScore: 90, challengerScore: 100 },
        ],
        elo: [
          { franchiseId: 1, season: 2024, week: 1, eloPre: 1500 },
          { franchiseId: 2, season: 2024, week: 1, eloPre: 1650 },
        ],
        recordEntries: [{ recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2024, week: 1, value: 120 }],
        finalWeeks: new Set(["2024:1", "2024:2", "2024:6"]),
      };

      const forward = computeAchievements(input);
      const shuffled = computeAchievements({
        ...input,
        teamWeeks: [...input.teamWeeks].reverse(),
        beltMatches: [...input.beltMatches].reverse(),
        elo: [...input.elo].reverse(),
        recordEntries: [...input.recordEntries].reverse(),
      });

      expect(shuffled).toEqual(forward);
    });

    it("every award's dedupeKey is unique within one call's output", () => {
      const input: AchievementsInput = {
        teamWeeks: [...BASIC_WEEK_TEAM_WEEKS, ...BENCH_DISASTER_TEAM_WEEKS],
        beltMatches: [
          { matchupId: 1, season: 2024, week: 6, holderFranchiseId: 1, challengerFranchiseId: 2, result: "transfer", holderScore: 90, challengerScore: 100 },
        ],
        elo: [
          { franchiseId: 1, season: 2024, week: 1, eloPre: 1500 },
          { franchiseId: 2, season: 2024, week: 1, eloPre: 1650 },
        ],
        recordEntries: [
          { recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2024, week: 1, value: 120 },
          { recordKey: "highest_bench_points_left", rank: 1, franchiseId: 1, season: 2024, week: 1, value: 5 },
        ],
        finalWeeks: new Set(["2024:1", "2024:2", "2024:6"]),
      };
      const awards = computeAchievements(input);
      const keys = awards.map((a) => a.dedupeKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });
});
