import { describe, expect, it } from "vitest";
import {
  evaluateContextRules,
  possessive,
  type ContextBeltMatchInput,
  type ContextEngineInputs,
  type ContextH2HMatchupInput,
  type ContextRecordEntryInput,
  type ContextTeamWeekInput,
} from "../context";

describe("possessive", () => {
  it("appends the usual \"'s\" for a name that doesn't already end in 's'", () => {
    expect(possessive("Brotherly Shove")).toBe("Brotherly Shove's");
    expect(possessive("Two Time Timmy")).toBe("Two Time Timmy's");
  });

  it("appends a bare apostrophe for a name that already ends in 's', including a lowercase 's' buried in an abbreviation like 'TDs'", () => {
    expect(possessive("Pat's Moms All-Stars")).toBe("Pat's Moms All-Stars'");
    expect(possessive("Gridiron Gladiators")).toBe("Gridiron Gladiators'");
    expect(possessive("Bijan Mustard on My TDs")).toBe("Bijan Mustard on My TDs'"); // real league name
  });

  it("is case-INsensitive on the trailing letter — an all-caps name ending in 'S' still takes the bare apostrophe", () => {
    expect(possessive("The Boss")).toBe("The Boss'");
    expect(possessive("MEGA CORPS")).toBe("MEGA CORPS'");
  });
});

function emptyInputs(): ContextEngineInputs {
  return { teamWeeks: [], recordEntries: [], h2hMatchups: [], beltMatches: [], beltReigns: [], franchiseNames: {} };
}

function tw(over: Partial<ContextTeamWeekInput> & { franchiseId: number; season: number; week: number }): ContextTeamWeekInput {
  return {
    matchupId: over.season * 1000 + over.week * 10 + over.franchiseId,
    score: 100,
    result: "W",
    weekType: "regular",
    refinedWeekType: "regular",
    streakAsOf: null,
    franchiseLongestWinStreak: null,
    franchiseLongestLossStreak: null,
    eloPost: null,
    seasonComplete: true,
    margin: null,
    ...over,
  };
}

function rec(over: Partial<ContextRecordEntryInput> & Pick<ContextRecordEntryInput, "recordKey" | "rank" | "franchiseId" | "season">): ContextRecordEntryInput {
  return { week: 1, value: 100, ...over };
}

describe("evaluateContextRules — rule 1: all_time_score_rank", () => {
  // NOTE: these fixtures deliberately hold a single team-week, which trivially ALSO ranks #1
  // within its own (single-week) season — every assertion below filters to `ruleId ===
  // "all_time_score_rank"` so that harmless, expected `season_score_rank` co-firing (rule 2)
  // never leaks into this rule's own assertions.

  it("fires top-3 all-time high with 'in league history' phrasing", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, score: 187.7 })];
    inputs.recordEntries = [rec({ recordKey: "highest_week_score", rank: 3, franchiseId: 1, season: 2024, week: 1, value: 187.7 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "all_time_score_rank");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ ruleId: "all_time_score_rank", salience: 90, renderedText: "3rd-highest score in league history" });
  });

  it("rank 1 uses the singular phrasing, no ordinal", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "all_time_score_rank");
    expect(notes[0]!.renderedText).toBe("Highest score in league history");
  });

  it("ranks 4-10 downgrade to the top-10 salience tier", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "highest_week_score", rank: 7, franchiseId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "all_time_score_rank");
    expect(notes[0]).toMatchObject({ salience: 70, renderedText: "7th-highest score in league history" });
  });

  it("lowest_week_score uses 'ever' phrasing", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "lowest_week_score", rank: 2, franchiseId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "all_time_score_rank");
    expect(notes[0]!.renderedText).toBe("2nd-lowest score ever");
  });

  it("negative: rank 11 (outside the all-time top-10) never fires", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "highest_week_score", rank: 11, franchiseId: 1, season: 2024, week: 1 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "all_time_score_rank")).toBe(false);
  });

  it("negative: an unrelated record key never leaks into this rule's notes", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "highest_bench_points_left", rank: 1, franchiseId: 1, season: 2024, week: 1 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "all_time_score_rank")).toBe(false);
  });
});

describe("evaluateContextRules — rule 2: season_score_rank", () => {
  it("fires season top-3 highest, with '(so far)' only when the season is incomplete", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2024, week: 1, score: 150, seasonComplete: false }),
      tw({ franchiseId: 2, season: 2024, week: 1, score: 140, seasonComplete: false }),
      tw({ franchiseId: 3, season: 2024, week: 1, score: 130, seasonComplete: false }),
      tw({ franchiseId: 4, season: 2024, week: 1, score: 120, seasonComplete: false }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "season_score_rank");
    expect(notes).toHaveLength(3);
    const byFranchise = new Map(notes.map((n) => [n.franchiseId, n]));
    expect(byFranchise.get(1)!.renderedText).toBe("Highest score of the 2024 season (so far)");
    expect(byFranchise.get(2)!.renderedText).toBe("2nd-highest score of the 2024 season (so far)");
    expect(byFranchise.get(3)!.renderedText).toBe("3rd-highest score of the 2024 season (so far)");
    expect(byFranchise.get(4)).toBeUndefined(); // negative: 4th place never fires
  });

  it("omits '(so far)' once the season is complete", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, score: 150, seasonComplete: true })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "season_score_rank");
    expect(notes[0]!.renderedText).toBe("Highest score of the 2024 season");
  });

  it("negative: a coarsely-'consolation' team-week never enters the season ranking", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 15, score: 999, weekType: "consolation" })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "season_score_rank")).toBe(false);
  });
});

describe("evaluateContextRules — rule 3: franchise_best_since", () => {
  it("fires 'since {year}' when a prior equal-or-higher week is >=2 seasons back", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2022, week: 1, score: 150 }), // the peak being matched/returned to
      tw({ franchiseId: 1, season: 2023, week: 1, score: 100 }),
      tw({ franchiseId: 1, season: 2024, week: 1, score: 145 }), // strong, but doesn't exceed 2022 -> "since" framing
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "franchise_best_since" && n.week === 1 && n.season === 2024);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.renderedText).toBe("Their best week since 2022");
  });

  it("negative: a prior peak only 1 season back does not fire (too recent to be 'since')", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2023, week: 1, score: 150 }),
      tw({ franchiseId: 1, season: 2024, week: 1, score: 145 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "franchise_best_since" && n.season === 2024);
    expect(notes).toEqual([]);
  });

  it("fires 'best week ever' when no prior peak exists and the franchise has >=2 seasons of history", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2022, week: 1, score: 90 }),
      tw({ franchiseId: 1, season: 2023, week: 1, score: 95 }),
      tw({ franchiseId: 1, season: 2024, week: 1, score: 150 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "franchise_best_since" && n.season === 2024);
    expect(notes[0]!.renderedText).toBe("Their best week ever");
  });

  it("negative: a rookie franchise's debut week (no 2-season-old history) never fires 'ever'", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, score: 150 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "franchise_best_since");
    expect(notes).toEqual([]);
  });
});

describe("evaluateContextRules — rule 4: margin_rank", () => {
  it("largest_blowout top-3 fires matchup-scoped, rank form only", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, matchupId: 555 })];
    inputs.recordEntries = [rec({ recordKey: "largest_blowout", rank: 4, franchiseId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "margin_rank");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ subjectType: "matchup", matchupId: 555, franchiseId: null, salience: 70, renderedText: "4th-largest blowout ever" });
  });

  it("closest_game rank 1 uses 'in league history'", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, matchupId: 555 })];
    inputs.recordEntries = [rec({ recordKey: "closest_game", rank: 1, franchiseId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "margin_rank");
    expect(notes[0]!.renderedText).toBe("Closest game in league history");
  });

  it("negative: rank 11 never fires", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, matchupId: 555 })];
    inputs.recordEntries = [rec({ recordKey: "largest_blowout", rank: 11, franchiseId: 1, season: 2024, week: 1 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "margin_rank")).toBe(false);
  });
});

describe("evaluateContextRules — rule 5: streak_context", () => {
  it("fires for an active streak >=4, comparing to the franchise's own record", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2024, week: 6, streakAsOf: { type: "W", count: 6 }, franchiseLongestWinStreak: 8 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "streak_context");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ salience: 45, renderedText: "Extends the win streak to 6 — franchise record is 8" });
  });

  it("ties phrasing when the active streak equals the franchise record", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 8, streakAsOf: { type: "L", count: 5 }, franchiseLongestLossStreak: 5 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "streak_context");
    expect(notes[0]!.renderedText).toBe("Extends the losing streak to 5 — ties the franchise record");
  });

  it("negative: a streak of exactly 3 never fires", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 3, streakAsOf: { type: "W", count: 3 }, franchiseLongestWinStreak: 8 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "streak_context")).toBe(false);
  });

  it("negative: a null streak (excluded consolation week) never fires", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 15, streakAsOf: null })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "streak_context")).toBe(false);
  });
});

describe("evaluateContextRules — rule 6: h2h_milestone", () => {
  function hm(over: Partial<ContextH2HMatchupInput> & { matchupId: number; season: number; week: number }): ContextH2HMatchupInput {
    return { weekType: "regular", homeFranchiseId: 1, awayFranchiseId: 2, winner: "home", ...over };
  }

  it("fires a series lead flip with the opponent's name and the new tally", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Team A", 2: "Team B" };
    inputs.h2hMatchups = [
      hm({ matchupId: 1, season: 2020, week: 1, winner: "away" }), // B leads 1-0
      hm({ matchupId: 2, season: 2021, week: 1, winner: "home" }), // tied 1-1
      hm({ matchupId: 3, season: 2022, week: 1, winner: "home" }), // A takes the lead 2-1
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "h2h_milestone" && (n.facts as { kind: string }).kind === "lead_flip");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ subjectType: "matchup", matchupId: 3, salience: 50, renderedText: "Takes the all-time series lead over Team B, 2-1" });
  });

  it("negative: extending an existing lead (not a flip) never fires lead_flip", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Team A", 2: "Team B" };
    inputs.h2hMatchups = [
      hm({ matchupId: 1, season: 2020, week: 1, winner: "home" }),
      hm({ matchupId: 2, season: 2021, week: 1, winner: "home" }), // A still leads, no flip
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "h2h_milestone" && (n.facts as { kind: string }).kind === "lead_flip");
    expect(notes).toEqual([]);
  });

  it("fires drought broken (>=4 straight series losses) with 'since {year}'", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Team A", 2: "Team B" };
    inputs.h2hMatchups = [
      hm({ matchupId: 1, season: 2019, week: 1, winner: "away" }), // B's last win before the drought
      hm({ matchupId: 2, season: 2020, week: 1, winner: "home" }),
      hm({ matchupId: 3, season: 2021, week: 1, winner: "home" }),
      hm({ matchupId: 4, season: 2022, week: 1, winner: "home" }),
      hm({ matchupId: 5, season: 2023, week: 1, winner: "home" }), // A's 4th straight win over B
      hm({ matchupId: 6, season: 2024, week: 1, winner: "away" }), // B finally wins again
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "h2h_milestone" && (n.facts as { kind: string }).kind === "drought_broken");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ matchupId: 6, renderedText: "First win over Team A since 2019" });
  });

  it("fires 'first-ever win' when the winner has never beaten this opponent before", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Team A", 2: "Team B" };
    inputs.h2hMatchups = [
      hm({ matchupId: 1, season: 2020, week: 1, winner: "home" }),
      hm({ matchupId: 2, season: 2021, week: 1, winner: "home" }),
      hm({ matchupId: 3, season: 2022, week: 1, winner: "home" }),
      hm({ matchupId: 4, season: 2023, week: 1, winner: "home" }),
      hm({ matchupId: 5, season: 2024, week: 1, winner: "away" }), // B's first-ever win over A
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "h2h_milestone" && (n.facts as { kind: string }).kind === "drought_broken");
    expect(notes[0]!.renderedText).toBe("First-ever win over Team A");
  });

  it("negative: a drought of exactly 3 never fires drought_broken", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Team A", 2: "Team B" };
    inputs.h2hMatchups = [
      hm({ matchupId: 1, season: 2021, week: 1, winner: "home" }),
      hm({ matchupId: 2, season: 2022, week: 1, winner: "home" }),
      hm({ matchupId: 3, season: 2023, week: 1, winner: "home" }),
      hm({ matchupId: 4, season: 2024, week: 1, winner: "away" }), // only a 3-game drought broken
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "h2h_milestone" && (n.facts as { kind: string }).kind === "drought_broken");
    expect(notes).toEqual([]);
  });

  it("negative: consolation-bracket meetings are excluded from the series entirely", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Team A", 2: "Team B" };
    inputs.h2hMatchups = [hm({ matchupId: 1, season: 2024, week: 15, weekType: "consolation", winner: "home" })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "h2h_milestone")).toBe(false);
  });

  it("regression (fix round 1, minor a): the FIRST decisive result after one or more ties never fires a trivial lead_flip, but a genuine later flip (with real decisive history behind it) still does", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Team A", 2: "Team B" };
    inputs.h2hMatchups = [
      hm({ matchupId: 1, season: 2020, week: 1, winner: "tie" }), // 0 decisive meetings so far
      hm({ matchupId: 2, season: 2021, week: 1, winner: "home" }), // A's first-ever decisive win — trivial, must NOT flip
      hm({ matchupId: 3, season: 2022, week: 1, winner: "away" }), // B ties it 1-1 — leaderAfter null, can't flip either
      hm({ matchupId: 4, season: 2023, week: 1, winner: "away" }), // B takes the lead 1-2 — a GENUINE flip, real decisive history exists
    ];
    const flips = evaluateContextRules(inputs).filter((n) => n.ruleId === "h2h_milestone" && (n.facts as { kind: string }).kind === "lead_flip");
    expect(flips).toHaveLength(1);
    expect(flips[0]).toMatchObject({ matchupId: 4, renderedText: "Takes the all-time series lead over Team A, 2-1" });
  });
});

describe("evaluateContextRules — rule 7: belt_stakes", () => {
  function bm(over: Partial<ContextBeltMatchInput> & { matchupId: number; season: number; week: number }): ContextBeltMatchInput {
    return { holderFranchiseId: 1, challengerFranchiseId: 2, result: "defense", ...over };
  }

  it("counts consecutive defenses and reports the gap to the league record", () => {
    const inputs = emptyInputs();
    inputs.beltReigns = [{ reignNo: 1, franchiseId: 1, startSeason: 2020, startWeek: 1, defenses: 8 }];
    inputs.beltMatches = Array.from({ length: 5 }, (_, i) => bm({ matchupId: i + 1, season: 2024, week: i + 1 }));
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "belt_stakes");
    expect(notes).toHaveLength(5);
    // brief's own example phrasing: "5th straight defense — three shy of the league record"
    expect(notes[4]).toMatchObject({ salience: 45, renderedText: "5th straight defense — three shy of the league record" });
  });

  it("reports a new league record once consecutive defenses reach the current max uniquely", () => {
    const inputs = emptyInputs();
    inputs.beltReigns = [{ reignNo: 1, franchiseId: 1, startSeason: 2020, startWeek: 1, defenses: 3 }];
    inputs.beltMatches = Array.from({ length: 3 }, (_, i) => bm({ matchupId: i + 1, season: 2024, week: i + 1 }));
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "belt_stakes");
    expect(notes[2]!.renderedText).toBe("3rd straight defense — a new league record for consecutive defenses");
  });

  it("regression (Task 14): transfer note uses the FRANCHISE's own reign count, not the league-wide reign number — 'claims it for the Nth time'", () => {
    // Real user-reported bug: reignNo (LEAGUE-WIDE, e.g. 63) was shown where the FRANCHISE's own
    // count (e.g. 7) belongs — league-wide reignNo must never appear in this text (it lives on
    // /belt). Franchise 2 here holds its SECOND own reign (reignNo 1 long ago, reignNo 3 now),
    // interleaved with franchise 1's own reign (reignNo 2) — proves the count is franchise-scoped,
    // not simply "how many reigns have happened in the league by this point" (which would be 3).
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Holder", 2: "Challenger" };
    inputs.beltReigns = [
      { reignNo: 1, franchiseId: 2, startSeason: 2018, startWeek: 1, defenses: 1 }, // Challenger's 1st-ever reign
      { reignNo: 2, franchiseId: 1, startSeason: 2020, startWeek: 1, defenses: 2 }, // Holder's reign
      { reignNo: 3, franchiseId: 2, startSeason: 2024, startWeek: 3, defenses: 0 }, // Challenger's 2nd own reign
    ];
    inputs.beltMatches = [
      bm({ matchupId: 1, season: 2024, week: 1, result: "defense" }),
      bm({ matchupId: 2, season: 2024, week: 2, result: "defense" }),
      bm({ matchupId: 3, season: 2024, week: 3, result: "transfer" }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "belt_stakes");
    const transferNote = notes.find((n) => n.matchupId === 3)!;
    expect(transferNote).toMatchObject({ salience: 60, renderedText: "The belt changes hands — Challenger claims it for the 2nd time" });
    expect(transferNote.renderedText).not.toContain("3rd reign"); // never the league-wide reignNo (3)
    expect((transferNote.facts as { reignNo: number; franchiseReignCount: number }).reignNo).toBe(3); // kept in facts, just not in the text
    expect((transferNote.facts as { franchiseReignCount: number }).franchiseReignCount).toBe(2);
  });

  it("regression (Task 14): a franchise's FIRST-EVER reign reads 'claims it for the first time', not '1st time'", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Holder", 2: "Challenger" };
    inputs.beltReigns = [
      { reignNo: 1, franchiseId: 1, startSeason: 2020, startWeek: 1, defenses: 2 },
      { reignNo: 2, franchiseId: 2, startSeason: 2024, startWeek: 3, defenses: 0 },
    ];
    inputs.beltMatches = [bm({ matchupId: 1, season: 2024, week: 3, result: "transfer" })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "belt_stakes");
    expect(notes[0]!.renderedText).toBe("The belt changes hands — Challenger claims it for the first time");
  });

  it("regression (fix round 1, minor c): the FIRST defense of a reign reads 'First defense of the reign', not '1st straight defense'", () => {
    const inputs = emptyInputs();
    inputs.beltReigns = [{ reignNo: 1, franchiseId: 1, startSeason: 2020, startWeek: 1, defenses: 5 }];
    inputs.beltMatches = [bm({ matchupId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "belt_stakes");
    expect(notes[0]!.renderedText).toBe("First defense of the reign — four shy of the league record");
  });

  it("reachability (fix round 1, minor b): a transfer with no matching beltReigns entry (inconsistent/incomplete input — never happens via real replay() output, but the engine accepts these as two independently-provided inputs) degrades gracefully instead of citing an undefined reign", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Holder", 2: "Challenger" };
    inputs.beltReigns = []; // deliberately empty — no reign starting at (2, 2024, 1) exists
    inputs.beltMatches = [bm({ matchupId: 1, season: 2024, week: 1, result: "transfer" })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "belt_stakes");
    expect(notes[0]!.renderedText).toBe("The belt changes hands — Challenger takes it from Holder");
  });
});

describe("evaluateContextRules — rule 8: record_broken", () => {
  it("'breaks' phrasing when the new rank-1 value differs from the displaced entry", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 10, matchupId: 999 })];
    inputs.recordEntries = [
      rec({ recordKey: "most_points_in_loss", rank: 1, franchiseId: 1, season: 2024, week: 10, value: 160 }),
      rec({ recordKey: "most_points_in_loss", rank: 2, franchiseId: 5, season: 2021, week: 4, value: 152.3 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "record_broken");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      subjectType: "team_week",
      franchiseId: 1,
      matchupId: 999,
      salience: 100,
      renderedText: "Breaks the league record for most points in a loss (previously 152.3, 2021)",
    });
  });

  it("'ties' phrasing fires for the chronologically LATER of two same-value rank-1 entries; the earlier one still 'Sets' (never 'Ties' something that hadn't happened yet)", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 10 }), tw({ franchiseId: 2, season: 2019, week: 3 })];
    inputs.recordEntries = [
      rec({ recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2024, week: 10, value: 150 }),
      rec({ recordKey: "highest_week_score", rank: 1, franchiseId: 2, season: 2019, week: 3, value: 150 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "record_broken");
    expect(notes).toHaveLength(2);
    const later = notes.find((n) => n.season === 2024)!;
    const earlier = notes.find((n) => n.season === 2019)!;
    expect(later.renderedText).toBe("Ties the league record for highest score in a week (150.0, also 2019)");
    expect(earlier.renderedText).toBe("Sets the league record for highest score in a week (150.0)");
  });

  it("'sets' phrasing when there is no displaced (lower) entry to compare against", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 10 })];
    inputs.recordEntries = [rec({ recordKey: "highest_championship_score", rank: 1, franchiseId: 1, season: 2024, week: 10, value: 140 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "record_broken");
    expect(notes[0]!.renderedText).toBe("Sets the league record for highest score in a championship game (140.0)");
  });

  it("negative: a season-scope record (week == null) is never attributable, no note fires", () => {
    const inputs = emptyInputs();
    inputs.recordEntries = [rec({ recordKey: "highest_season_total", rank: 1, franchiseId: 1, season: 2024, week: null, value: 1800 })];
    expect(evaluateContextRules(emptyInputs()).length).toBe(0);
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "record_broken")).toBe(false);
  });

  it("negative: rank 2 alone (not rank 1) never fires", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2021, week: 4 })];
    inputs.recordEntries = [rec({ recordKey: "most_points_in_loss", rank: 2, franchiseId: 1, season: 2021, week: 4, value: 152.3 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "record_broken")).toBe(false);
  });

  it("regression (fix round 1, C1): 'previously' cites the best CHRONOLOGICALLY-EARLIER entry, never a later-dated one — the real 187.7-game bug shape", () => {
    // Real production bug: rank 2 overall (by VALUE) was dated 2021, LATER than the rank-1 entry
    // (2019) — rendering "previously 186.8, 2021" on a 2019 game. Rank 2 by value is not
    // necessarily rank 2 chronologically; "previously" must mean "the standing record at the
    // time," found by chronology, not by the value-only rank ordering record_entries stores.
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2019, week: 15, matchupId: 2409 })];
    inputs.recordEntries = [
      rec({ recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2019, week: 15, value: 187.7 }),
      // rank 2 by value, but chronologically LATER than the rank-1 entry — must NOT be cited.
      rec({ recordKey: "highest_week_score", rank: 2, franchiseId: 9, season: 2021, week: 4, value: 186.8 }),
      // rank 3 by value, but chronologically EARLIER — this is the genuine "previously" record.
      rec({ recordKey: "highest_week_score", rank: 3, franchiseId: 5, season: 2018, week: 12, value: 180.0 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "record_broken");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.renderedText).toBe("Breaks the league record for highest score in a week (previously 180.0, 2018)");
    expect(notes[0]!.renderedText).not.toContain("2021");
  });

  it("regression (fix round 1, C1): a genuine first-ever record still 'Sets' even when a later-dated lower entry exists (nothing chronologically before it)", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2015, week: 1 })];
    inputs.recordEntries = [
      rec({ recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2015, week: 1, value: 200 }),
      // The only other entry is LATER (2020) — nothing chronologically before the rank-1 entry.
      rec({ recordKey: "highest_week_score", rank: 2, franchiseId: 9, season: 2020, week: 4, value: 190 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "record_broken");
    expect(notes[0]!.renderedText).toBe("Sets the league record for highest score in a week (200.0)");
  });
});

describe("evaluateContextRules — rule 9: futility_valor", () => {
  it("most_points_in_loss top-5 fires", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "most_points_in_loss", rank: 2, franchiseId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "futility_valor");
    expect(notes[0]).toMatchObject({ salience: 90, renderedText: "2nd-most points ever scored in a loss" });
  });

  it("fewest_points_in_win rank 1 uses the singular phrasing", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "fewest_points_in_win", rank: 1, franchiseId: 1, season: 2024, week: 1 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "futility_valor");
    expect(notes[0]!.renderedText).toBe("Fewest points ever in a win");
  });

  it("negative: rank 6 (outside the futility top-5) never fires", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1 })];
    inputs.recordEntries = [rec({ recordKey: "most_points_in_loss", rank: 6, franchiseId: 1, season: 2024, week: 1 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "futility_valor")).toBe(false);
  });
});

describe("evaluateContextRules — rule 10: elo_landmark", () => {
  it("fires a new franchise peak (not on the franchise's very first recorded elo)", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2024, week: 1, eloPost: 1500 }),
      tw({ franchiseId: 2, season: 2024, week: 1, eloPost: 1400 }),
      tw({ franchiseId: 1, season: 2024, week: 2, eloPost: 1580 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "elo_landmark" && (n.facts as { kind: string }).kind === "peak");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ franchiseId: 1, week: 2, salience: 45, renderedText: "New franchise peak Elo (1580)" });
  });

  it("negative: the very first elo entry for a franchise never fires 'peak' (nothing to exceed yet)", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, eloPost: 1500 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "elo_landmark" && (n.facts as { kind: string }).kind === "peak")).toBe(false);
  });

  it("fires reaching #1 the first time, then suppresses a same-season repeat, then fires again a season later", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2024, week: 1, eloPost: 1600 }),
      tw({ franchiseId: 2, season: 2024, week: 1, eloPost: 1400 }),
      tw({ franchiseId: 1, season: 2024, week: 2, eloPost: 1620 }), // still #1, same season -> suppressed
      tw({ franchiseId: 2, season: 2025, week: 1, eloPost: 1700 }), // franchise 2 overtakes
      tw({ franchiseId: 1, season: 2025, week: 1, eloPost: 1500 }),
      tw({ franchiseId: 1, season: 2026, week: 1, eloPost: 1750 }), // franchise 1 reclaims #1, >=1 season later
      tw({ franchiseId: 2, season: 2026, week: 1, eloPost: 1600 }),
    ];
    const no1Notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "elo_landmark" && (n.facts as { kind: string }).kind === "no1");
    expect(no1Notes.map((n) => [n.franchiseId, n.season])).toEqual([
      [1, 2024],
      [2, 2025],
      [1, 2026],
    ]);
  });
});

describe("evaluateContextRules — rule 11: career_milestone", () => {
  it("fires at exactly the 25th career win, attributed to the FRANCHISE (not 'Manager's' — fix round 1, I3)", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Gridiron Gladiators" };
    inputs.teamWeeks = Array.from({ length: 25 }, (_, i) =>
      tw({ franchiseId: 1, season: 2020 + Math.floor(i / 14), week: (i % 14) + 1, result: "W" }),
    );
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "career_milestone");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.renderedText).toBe("Gridiron Gladiators' 25th all-time win");
  });

  it("regression (Task 14): a name already ending in 's' takes a bare apostrophe, not \"'s\" — 'Pat's Moms All-Stars' 75th all-time win'", () => {
    const inputs = emptyInputs();
    inputs.franchiseNames = { 1: "Pat's Moms All-Stars" };
    inputs.teamWeeks = Array.from({ length: 75 }, (_, i) =>
      tw({ franchiseId: 1, season: 2015 + Math.floor(i / 14), week: (i % 14) + 1, result: "W" }),
    );
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "career_milestone" && (n.facts as { wins: number }).wins === 75);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.renderedText).toBe("Pat's Moms All-Stars' 75th all-time win");
  });

  it("negative: the 24th win never fires (not a milestone number)", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = Array.from({ length: 24 }, (_, i) =>
      tw({ franchiseId: 1, season: 2020 + Math.floor(i / 14), week: (i % 14) + 1, result: "W" }),
    );
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "career_milestone")).toBe(false);
  });

  it("losses never advance the win counter", () => {
    const inputs = emptyInputs();
    const wins = Array.from({ length: 25 }, (_, i) => tw({ franchiseId: 1, season: 2020 + Math.floor(i / 14), week: (i % 14) + 1, result: "W" }));
    const losses = [tw({ franchiseId: 1, season: 2019, week: 1, result: "L" }), tw({ franchiseId: 1, season: 2019, week: 2, result: "T" })];
    const inputsWithNoise: ContextEngineInputs = { ...inputs, teamWeeks: [...losses, ...wins] };
    const notes = evaluateContextRules(inputsWithNoise).filter((n) => n.ruleId === "career_milestone");
    expect(notes).toHaveLength(1); // still exactly the 25th real win, losses/ties don't count
  });
});

describe("evaluateContextRules — rule: beatdown_of_week (Task 17)", () => {
  it("fires for the week's single worst loss, default phrasing when it isn't an all-time top-3 beatdown", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2024, week: 1, result: "L", margin: -10 }),
      tw({ franchiseId: 2, season: 2024, week: 1, result: "L", margin: -38.4 }),
      tw({ franchiseId: 3, season: 2024, week: 1, result: "W", margin: 38.4 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      subjectType: "team_week",
      franchiseId: 2,
      season: 2024,
      week: 1,
      salience: 45,
      renderedText: "Beatdown of the Week — the week's worst loss (-38.4)",
    });
  });

  it("escalates to 'the worst beatdown in league history' when it's ALSO the all-time #1 worst_beatdown", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 2, season: 2024, week: 1, result: "L", margin: -38.4 })];
    inputs.recordEntries = [rec({ recordKey: "worst_beatdown", rank: 1, franchiseId: 2, season: 2024, week: 1, value: -38.4 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes[0]!.renderedText).toBe("Beatdown of the Week — the worst beatdown in league history (-38.4)");
  });

  it("escalates to 'the 2nd-worst beatdown in league history' for all-time rank 2 (and rank 3 uses the same ordinal form)", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 2, season: 2024, week: 1, result: "L", margin: -30 })];
    inputs.recordEntries = [rec({ recordKey: "worst_beatdown", rank: 2, franchiseId: 2, season: 2024, week: 1, value: -30 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes[0]!.renderedText).toBe("Beatdown of the Week — the 2nd-worst beatdown in league history (-30.0)");
  });

  it("negative: all-time rank 4 (outside the top-3 escalation) stays on the default 'week's worst loss' phrasing", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 2, season: 2024, week: 1, result: "L", margin: -30 })];
    inputs.recordEntries = [rec({ recordKey: "worst_beatdown", rank: 4, franchiseId: 2, season: 2024, week: 1, value: -30 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes[0]!.renderedText).toBe("Beatdown of the Week — the week's worst loss (-30.0)");
  });

  it("a tie of margins within a week awards ALL tied losers", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 5, season: 2024, week: 1, result: "L", margin: -20 }),
      tw({ franchiseId: 2, season: 2024, week: 1, result: "L", margin: -20 }),
      tw({ franchiseId: 9, season: 2024, week: 1, result: "L", margin: -5 }), // not tied for worst
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes.map((n) => n.franchiseId).sort()).toEqual([2, 5]);
    expect(notes.every((n) => n.renderedText === "Beatdown of the Week — the week's worst loss (-20.0)")).toBe(true);
  });

  it("negative: a week with no completed losses (e.g. every game still a tie or unplayed) gets no award", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, result: "T", margin: 0 })];
    expect(evaluateContextRules(inputs).some((n) => n.ruleId === "beatdown_of_week")).toBe(false);
  });

  it("negative: a tie-game team-week is never itself eligible, even as a runner-up", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2024, week: 1, result: "L", margin: -10 }),
      tw({ franchiseId: 2, season: 2024, week: 1, result: "T", margin: 0 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes.map((n) => n.franchiseId)).toEqual([1]);
  });

  it("playoff/consolation weeks are fully eligible — a playoff beatdown still fires (no weekType filter at all)", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 17, result: "L", margin: -12, weekType: "consolation" })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes).toHaveLength(1);
  });

  it("matchupId is carried through from the team-week for matchup-page surfacing", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [tw({ franchiseId: 1, season: 2024, week: 1, result: "L", margin: -10, matchupId: 777 })];
    const notes = evaluateContextRules(inputs).filter((n) => n.ruleId === "beatdown_of_week");
    expect(notes[0]!.matchupId).toBe(777);
  });
});

describe("evaluateContextRules — multi-note cap and determinism", () => {
  it("caps a single subject at its top 3 notes by salience", () => {
    const inputs = emptyInputs();
    inputs.teamWeeks = [
      tw({ franchiseId: 1, season: 2024, week: 10, score: 200, streakAsOf: { type: "W", count: 5 }, franchiseLongestWinStreak: 10, eloPost: 1500 }),
    ];
    inputs.recordEntries = [
      rec({ recordKey: "highest_week_score", rank: 1, franchiseId: 1, season: 2024, week: 10, value: 200 }),
      rec({ recordKey: "highest_week_score", rank: 2, franchiseId: 3, season: 2019, week: 5, value: 190 }),
      rec({ recordKey: "most_points_in_loss", rank: 1, franchiseId: 1, season: 2024, week: 10, value: 200 }),
    ];
    const notes = evaluateContextRules(inputs).filter((n) => n.subjectType === "team_week" && n.franchiseId === 1 && n.season === 2024 && n.week === 10);
    // Candidates here: all_time_score_rank (90), record_broken x1 (100), futility_valor (90),
    // streak_context (45) -> at least 4 distinct candidates competing for a 3-slot cap.
    expect(notes.length).toBeLessThanOrEqual(3);
    expect(notes[0]!.ruleId).toBe("record_broken"); // salience 100 always wins the top slot
  });

  it("determinism: two identical calls produce byte-identical (deep-equal) output, regardless of input array order", () => {
    const inputs: ContextEngineInputs = {
      teamWeeks: [
        tw({ franchiseId: 2, season: 2024, week: 2, score: 90 }),
        tw({ franchiseId: 1, season: 2024, week: 1, score: 150, streakAsOf: { type: "W", count: 4 }, franchiseLongestWinStreak: 6 }),
      ],
      recordEntries: [
        rec({ recordKey: "highest_week_score", rank: 2, franchiseId: 1, season: 2024, week: 1, value: 150 }),
        rec({ recordKey: "highest_week_score", rank: 1, franchiseId: 9, season: 2018, week: 3, value: 200 }),
      ],
      h2hMatchups: [{ matchupId: 1, season: 2024, week: 1, weekType: "regular", homeFranchiseId: 1, awayFranchiseId: 2, winner: "home" }],
      beltMatches: [{ matchupId: 1, season: 2024, week: 1, holderFranchiseId: 1, challengerFranchiseId: 2, result: "defense" }],
      beltReigns: [{ reignNo: 1, franchiseId: 1, startSeason: 2023, startWeek: 1, defenses: 5 }],
      franchiseNames: { 1: "Team A", 2: "Team B" },
    };

    const reversedInputs: ContextEngineInputs = {
      ...inputs,
      teamWeeks: [...inputs.teamWeeks].reverse(),
      recordEntries: [...inputs.recordEntries].reverse(),
    };

    const a = evaluateContextRules(inputs);
    const b = evaluateContextRules(inputs);
    const c = evaluateContextRules(reversedInputs);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.length).toBeGreaterThan(0);
  });
});
