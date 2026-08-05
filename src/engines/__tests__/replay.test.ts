import { describe, expect, it } from "vitest";
import {
  ELO_START,
  eloExpected,
  eloKFactor,
  eloMarginMultiplier,
  replay,
  type ReplayMatchupInput,
} from "../replay";

function m(over: Partial<ReplayMatchupInput> & { matchupId: number; season: number; week: number }): ReplayMatchupInput {
  return {
    weekType: "regular",
    homeFranchiseId: 1,
    awayFranchiseId: 2,
    homeScore: 100,
    awayScore: 90,
    winner: "home",
    ...over,
  };
}

describe("eloExpected", () => {
  it("is 0.5 for equal ratings", () => {
    expect(eloExpected(1500, 1500)).toBeCloseTo(0.5, 10);
  });

  it("favors the higher-rated side", () => {
    // Standard Elo: 400 points -> ~0.909 expected for the favorite.
    expect(eloExpected(1600, 1200)).toBeCloseTo(1 / (1 + Math.pow(10, -400 / 400)), 10);
    expect(eloExpected(1600, 1200)).toBeGreaterThan(0.9);
  });
});

describe("eloKFactor", () => {
  it("32 regular, 40 playoff/championship, 16 consolation", () => {
    expect(eloKFactor("regular")).toBe(32);
    expect(eloKFactor("playoff")).toBe(40);
    expect(eloKFactor("championship")).toBe(40);
    expect(eloKFactor("consolation")).toBe(16);
  });
});

describe("eloMarginMultiplier", () => {
  it("hand-computed: margin 10, evenly matched (deltaWinner=0)", () => {
    // ln(11) * 2.2 / 2.2 = ln(11)
    expect(eloMarginMultiplier(10, 0)).toBeCloseTo(Math.log(11), 10);
  });

  it("is 0 for a 0 margin (tie)", () => {
    expect(eloMarginMultiplier(0, 0)).toBe(0);
  });

  it("margin damping: a favorite winning 'as expected' gets a SMALLER multiplier than an even matchup with the same margin", () => {
    const evenMatch = eloMarginMultiplier(20, 0);
    const bigFavorite = eloMarginMultiplier(20, 400); // winner was already +400 Elo pre-game
    expect(bigFavorite).toBeLessThan(evenMatch);
    // hand-computed: ln(21) * 2.2 / (0.001*400 + 2.2) = ln(21) * 2.2 / 2.6
    expect(bigFavorite).toBeCloseTo((Math.log(21) * 2.2) / 2.6, 10);
  });
});

describe("replay — Elo sequencing", () => {
  it("two brand-new franchises' first game: both start at 1500, symmetric update", () => {
    const result = replay(
      [m({ matchupId: 1, season: 2015, week: 1, homeScore: 110, awayScore: 100, winner: "home" })],
      { champions: [], activeFranchisesBySeason: {} },
    );

    const homeEntry = result.eloHistory.find((e) => e.franchiseId === 1)!;
    const awayEntry = result.eloHistory.find((e) => e.franchiseId === 2)!;
    expect(homeEntry.eloPre).toBe(ELO_START);
    expect(awayEntry.eloPre).toBe(ELO_START);

    // E=0.5 both sides, margin=10, deltaWinner=0 -> mult=ln(11); K=32 (regular).
    const mult = Math.log(11);
    const expectedDelta = 32 * mult * (1 - 0.5);
    expect(homeEntry.eloPost).toBeCloseTo(ELO_START + expectedDelta, 6);
    expect(awayEntry.eloPost).toBeCloseTo(ELO_START - expectedDelta, 6);
  });

  it("a tie leaves Elo COMPLETELY unchanged for both sides, even with unequal pre-game ratings", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 130, awayScore: 100, winner: "home" }),
        m({ matchupId: 2, season: 2015, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 100, awayScore: 100, winner: "tie" }),
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );

    const week2Home = result.eloHistory.find((e) => e.franchiseId === 1 && e.week === 2)!;
    const week2Away = result.eloHistory.find((e) => e.franchiseId === 2 && e.week === 2)!;
    // Pre-game ratings genuinely differ after week 1's result, but margin=0 zeroes the multiplier.
    expect(week2Home.eloPre).not.toBe(week2Away.eloPre);
    expect(week2Home.eloPost).toBe(week2Home.eloPre);
    expect(week2Away.eloPost).toBe(week2Away.eloPre);
  });

  it("K scales the same margin/matchup by week_type (playoff > regular > consolation)", () => {
    function runWithWeekType(weekType: ReplayMatchupInput["weekType"]): number {
      const result = replay([m({ matchupId: 1, season: 2015, week: 1, weekType, homeScore: 110, awayScore: 100, winner: "home" })], {
        champions: [],
        activeFranchisesBySeason: {},
      });
      return result.eloHistory.find((e) => e.franchiseId === 1)!.eloPost;
    }

    const regularDelta = runWithWeekType("regular") - ELO_START;
    const playoffDelta = runWithWeekType("playoff") - ELO_START;
    const consolationDelta = runWithWeekType("consolation") - ELO_START;

    expect(playoffDelta).toBeCloseTo(regularDelta * (40 / 32), 6);
    expect(consolationDelta).toBeCloseTo(regularDelta * (16 / 32), 6);
  });

  it("season boundary: elo regresses 2/3 of the way back to 1500 at a franchise's first game of a new season", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 150, awayScore: 90, winner: "home" }),
        m({ matchupId: 2, season: 2016, week: 1, homeFranchiseId: 1, awayFranchiseId: 3, homeScore: 100, awayScore: 100, winner: "tie" }),
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );

    const endOf2015 = result.eloHistory.find((e) => e.franchiseId === 1 && e.season === 2015)!.eloPost;
    const startOf2016 = result.eloHistory.find((e) => e.franchiseId === 1 && e.season === 2016)!.eloPre;
    expect(startOf2016).toBeCloseTo(ELO_START + (endOf2015 - ELO_START) * (2 / 3), 6);
    // franchise 3 is brand new in 2016 — no regression, starts flat at 1500.
    const franchise3Pre = result.eloHistory.find((e) => e.franchiseId === 3)!.eloPre;
    expect(franchise3Pre).toBe(ELO_START);
  });

  it("weeks_at_no1 is awarded to whoever has the single highest Elo after each real week", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 150, awayScore: 90, winner: "home" }),
        m({ matchupId: 2, season: 2015, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 90, awayScore: 150, winner: "away" }),
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );
    const f1 = result.franchiseElo.find((f) => f.franchiseId === 1)!;
    const f2 = result.franchiseElo.find((f) => f.franchiseId === 2)!;
    // week 1: franchise 1 pulls ahead (weeksAtNo1 += 1). week 2: franchise 2's big win could flip
    // the lead depending on magnitude — just assert the totals are consistent (exactly 2 weeks processed).
    expect(f1.weeksAtNo1 + f2.weeksAtNo1).toBe(2);
    expect(f1.peak).toBeGreaterThan(ELO_START);
    expect(f2.trough).toBeLessThan(ELO_START);
  });
});

describe("replay — belt lineage on a crafted mini-league", () => {
  // Franchises: A=1, B=2, C=3, D=4 (D departs after 2016).
  // 2015: A crowned champion (week 3). Belt doesn't exist until then — none of 2015's own games
  // are at stake for A.
  // 2016: A defends vs B (win), ties C (defense-by-tie), has a "bye" week where B/C play without
  // A (reign continues untouched), then loses to D (transfer) at week 4. D is 2016's champion
  // too (irrelevant to the belt — D holds it by TRANSFER, not by winning the season).
  // 2017: D's franchise has departed (not in activeFranchisesBySeason[2017]) -> belt vacated
  // entering 2017, awarded to 2017's champion (C) once their championship completes (week 3).
  // 2018: a manual override hands the belt to B at week 1.
  const champions = [
    { season: 2015, franchiseId: 1, week: 3 },
    { season: 2016, franchiseId: 4, week: 4 },
    { season: 2017, franchiseId: 3, week: 3 },
  ];
  const activeFranchisesBySeason: Record<number, number[]> = {
    2015: [1, 2, 3, 4],
    2016: [1, 2, 3, 4],
    2017: [1, 2, 3], // D (4) has departed
    2018: [1, 2, 3],
  };

  const matchups: ReplayMatchupInput[] = [
    // 2015 (belt not established until the week-3 championship — none of these are "at stake")
    m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 120, awayScore: 90, winner: "home" }),
    m({ matchupId: 2, season: 2015, week: 2, homeFranchiseId: 1, awayFranchiseId: 3, homeScore: 100, awayScore: 95, winner: "home" }),
    m({ matchupId: 3, season: 2015, week: 3, weekType: "playoff", homeFranchiseId: 1, awayFranchiseId: 4, homeScore: 130, awayScore: 100, winner: "home" }), // A crowned champion

    // 2016: defense (A beats B), defense-by-tie (A ties C), A's bye week (B vs C, A not involved),
    // then A loses to D -> transfer.
    m({ matchupId: 4, season: 2016, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 110, awayScore: 90, winner: "home" }), // defense
    m({ matchupId: 5, season: 2016, week: 2, homeFranchiseId: 1, awayFranchiseId: 3, homeScore: 100, awayScore: 100, winner: "tie" }), // defense-by-tie
    m({ matchupId: 6, season: 2016, week: 3, homeFranchiseId: 2, awayFranchiseId: 3, homeScore: 80, awayScore: 85, winner: "away" }), // A's bye — not involved
    m({ matchupId: 7, season: 2016, week: 4, weekType: "playoff", homeFranchiseId: 4, awayFranchiseId: 1, homeScore: 140, awayScore: 120, winner: "home" }), // transfer to D, D also crowned champion this same week

    // 2017: D departed -> vacated entering 2017; C crowned champion at week 3 -> vacancy award.
    m({ matchupId: 8, season: 2017, week: 1, homeFranchiseId: 2, awayFranchiseId: 3, homeScore: 90, awayScore: 95, winner: "away" }),
    m({ matchupId: 9, season: 2017, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 100, awayScore: 80, winner: "home" }),
    m({ matchupId: 10, season: 2017, week: 3, weekType: "playoff", homeFranchiseId: 3, awayFranchiseId: 1, homeScore: 111, awayScore: 90, winner: "home" }), // C crowned

    // 2018: override hands the belt to B at week 1, before any matchup that week — B then plays
    // C that same week, which should count as a real defense of the just-overridden belt.
    m({ matchupId: 11, season: 2018, week: 1, homeFranchiseId: 2, awayFranchiseId: 3, homeScore: 100, awayScore: 90, winner: "home" }),
  ];

  it("reign 1: A crowned at the 2015 championship, none of 2015's own games are belt matches", () => {
    const result = replay(matchups, { champions, activeFranchisesBySeason });
    const reign1 = result.beltReigns.find((r) => r.reignNo === 1)!;
    expect(reign1.franchiseId).toBe(1);
    expect(reign1.wonFromFranchiseId).toBeNull();
    expect(reign1.startSeason).toBe(2015);
    expect(reign1.startWeek).toBe(3);
    expect(result.beltMatches.some((bm) => bm.season === 2015)).toBe(false);
  });

  it("defends against B (win) and C (tie), 'bye' week leaves the reign untouched, then transfers to D", () => {
    const result = replay(matchups, { champions, activeFranchisesBySeason });

    const week1_2016 = result.beltMatches.find((bm) => bm.season === 2016 && bm.week === 1)!;
    expect(week1_2016).toMatchObject({ holderFranchiseId: 1, challengerFranchiseId: 2, result: "defense" });

    const week2_2016 = result.beltMatches.find((bm) => bm.season === 2016 && bm.week === 2)!;
    expect(week2_2016).toMatchObject({ holderFranchiseId: 1, challengerFranchiseId: 3, result: "defense" }); // tie counts as a defense

    // A's bye week (matchup 6, B vs C) produces no belt match at all.
    expect(result.beltMatches.some((bm) => bm.season === 2016 && bm.week === 3)).toBe(false);

    const week4_2016 = result.beltMatches.find((bm) => bm.season === 2016 && bm.week === 4)!;
    expect(week4_2016).toMatchObject({ holderFranchiseId: 1, challengerFranchiseId: 4, result: "transfer" });

    const reign1 = result.beltReigns.find((r) => r.reignNo === 1)!;
    expect(reign1.defenses).toBe(2); // week1 win + week2 tie
    expect(reign1.endReason).toBe("lost");
    expect(reign1.endSeason).toBe(2016);
    expect(reign1.endWeek).toBe(4);

    const reign2 = result.beltReigns.find((r) => r.reignNo === 2)!;
    expect(reign2.franchiseId).toBe(4);
    expect(reign2.wonFromFranchiseId).toBe(1);
    expect(reign2.startSeason).toBe(2016);
    expect(reign2.startWeek).toBe(4);
  });

  it("vacates when D's franchise departs, and re-awards to 2017's champion (C) at their championship — not a transfer", () => {
    const result = replay(matchups, { champions, activeFranchisesBySeason });

    const reign2 = result.beltReigns.find((r) => r.reignNo === 2)!;
    expect(reign2.endReason).toBe("vacated");
    expect(reign2.endSeason).toBe(2016); // last season D was confirmed active

    const reign3 = result.beltReigns.find((r) => r.reignNo === 3)!;
    expect(reign3.franchiseId).toBe(3);
    expect(reign3.wonFromFranchiseId).toBeNull(); // vacancy award, not a transfer
    expect(reign3.startSeason).toBe(2017);
    expect(reign3.startWeek).toBe(3);

    // The coronation game itself (matchup 10) is NOT logged as a belt match.
    expect(result.beltMatches.some((bm) => bm.matchupId === 10)).toBe(false);
    // matchup 9 (week 2, before C's coronation) is also not a belt match — the title was vacant then.
    expect(result.beltMatches.some((bm) => bm.matchupId === 9)).toBe(false);
  });

  it("a manual override transfers the belt outside of gameplay, ending the prior reign with end_reason 'override'", () => {
    const result = replay(matchups, {
      champions,
      activeFranchisesBySeason,
      beltOverrides: [{ season: 2018, week: 1, franchiseId: 2, reason: "commissioner ruling" }],
    });

    const reign3 = result.beltReigns.find((r) => r.reignNo === 3)!;
    expect(reign3.endReason).toBe("override");
    expect(reign3.endSeason).toBe(2018);
    expect(reign3.endWeek).toBe(1);

    const reign4 = result.beltReigns.find((r) => r.reignNo === 4)!;
    expect(reign4.franchiseId).toBe(2);
    expect(reign4.wonFromFranchiseId).toBe(3); // the override records who it came from
    expect(reign4.isCurrent).toBe(true);
    expect(reign4.endSeason).toBeNull();

    // matchup 11 (2018 wk1, B vs C) happens AFTER the override already made B the holder, and B
    // is a participant playing C — that's a real defense, not a coronation game.
    const week1_2018 = result.beltMatches.find((bm) => bm.season === 2018 && bm.week === 1)!;
    expect(week1_2018).toMatchObject({ holderFranchiseId: 2, challengerFranchiseId: 3, result: "defense" });
  });

  it("cross-consistency: every belt_match's matchupId exists in the input, and reign defenses match counted defense-matches", () => {
    const result = replay(matchups, { champions, activeFranchisesBySeason });
    const inputIds = new Set(matchups.map((mm) => mm.matchupId));
    expect(result.beltMatches.every((bm) => inputIds.has(bm.matchupId))).toBe(true);

    // Match by reign SPAN (not just franchiseId) — the same franchise could in principle hold the
    // belt across more than one non-contiguous reign, so franchiseId alone isn't a safe key.
    const ordinal = (season: number, week: number) => season * 100 + week;
    for (const reign of result.beltReigns) {
      const startOrd = ordinal(reign.startSeason, reign.startWeek);
      const endOrd = reign.endSeason !== null ? ordinal(reign.endSeason, reign.endWeek!) : Infinity;
      const matchesInReign = result.beltMatches.filter((bm) => {
        const ord = ordinal(bm.season, bm.week);
        return bm.holderFranchiseId === reign.franchiseId && ord >= startOrd && ord <= endOrd;
      });
      const defenseCount = matchesInReign.filter((bm) => bm.result === "defense").length;
      expect(reign.defenses).toBe(defenseCount);
    }
  });
});

describe("replay — streaks", () => {
  it("consolation games are fully invisible to streaks (don't break OR extend them)", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 110, awayScore: 90, winner: "home" }), // W
        m({ matchupId: 2, season: 2015, week: 2, weekType: "consolation", homeFranchiseId: 1, awayFranchiseId: 3, homeScore: 80, awayScore: 100, winner: "away" }), // L, but consolation — excluded
        m({ matchupId: 3, season: 2015, week: 3, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 105, awayScore: 95, winner: "home" }), // W
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );

    const f1 = result.streaks.find((s) => s.franchiseId === 1)!;
    expect(f1.currentStreakType).toBe("W");
    expect(f1.currentStreakCount).toBe(2); // the consolation loss in between never happened, as far as streaks are concerned
    expect(f1.longestWinStreak?.count).toBe(2);
  });

  it("a tie breaks the current streak without starting a new one", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 110, awayScore: 90, winner: "home" }),
        m({ matchupId: 2, season: 2015, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, homeScore: 100, awayScore: 100, winner: "tie" }),
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );
    const f1 = result.streaks.find((s) => s.franchiseId === 1)!;
    expect(f1.currentStreakType).toBeNull();
    expect(f1.currentStreakCount).toBe(0);
    expect(f1.longestWinStreak?.count).toBe(1); // the pre-tie win is still recorded as the longest so far
  });

  it("tracks longest win and loss streaks independently, with their spans", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, winner: "away", homeScore: 80, awayScore: 100 }), // L
        m({ matchupId: 2, season: 2015, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, winner: "away", homeScore: 80, awayScore: 100 }), // L
        m({ matchupId: 3, season: 2015, week: 3, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home", homeScore: 100, awayScore: 80 }), // W
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );
    const f1 = result.streaks.find((s) => s.franchiseId === 1)!;
    expect(f1.longestLossStreak).toEqual({ count: 2, startSeason: 2015, startWeek: 1, endSeason: 2015, endWeek: 2 });
    expect(f1.longestWinStreak).toEqual({ count: 1, startSeason: 2015, startWeek: 3, endSeason: 2015, endWeek: 3 });
    expect(f1.currentStreakType).toBe("W");
    expect(f1.currentStreakCount).toBe(1);
  });
});

describe("replay — streakHistory (Task 12: per-week streak snapshots)", () => {
  it("records the active streak AS OF each eligible week — a running trajectory, not just the final summary", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }), // W (streak 1)
        m({ matchupId: 2, season: 2015, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }), // W (streak 2)
        m({ matchupId: 3, season: 2015, week: 3, homeFranchiseId: 1, awayFranchiseId: 2, winner: "away" }), // L (streak resets to L,1)
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );

    const f1History = result.streakHistory.filter((e) => e.franchiseId === 1).sort((a, b) => a.week - b.week);
    expect(f1History).toEqual([
      { franchiseId: 1, season: 2015, week: 1, streakType: "W", streakCount: 1 },
      { franchiseId: 1, season: 2015, week: 2, streakType: "W", streakCount: 2 },
      { franchiseId: 1, season: 2015, week: 3, streakType: "L", streakCount: 1 },
    ]);
  });

  it("negative: a consolation game emits no streakHistory entry at all for either side", () => {
    const result = replay(
      [m({ matchupId: 1, season: 2015, week: 1, weekType: "consolation", homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" })],
      { champions: [], activeFranchisesBySeason: {} },
    );
    expect(result.streakHistory).toEqual([]);
  });

  it("a tie's snapshot shows a null streak type and zero count", () => {
    const result = replay(
      [
        m({ matchupId: 1, season: 2015, week: 1, homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }),
        m({ matchupId: 2, season: 2015, week: 2, homeFranchiseId: 1, awayFranchiseId: 2, winner: "tie" }),
      ],
      { champions: [], activeFranchisesBySeason: {} },
    );
    const week2 = result.streakHistory.find((e) => e.franchiseId === 1 && e.week === 2)!;
    expect(week2).toMatchObject({ streakType: null, streakCount: 0 });
  });
});
