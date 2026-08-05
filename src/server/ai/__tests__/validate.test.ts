import { describe, expect, it } from "vitest";
import type { WeekFacts } from "../facts";
import { renderFallbackRecap } from "../recap";
import { isCompleteWeekFacts, validateRecap } from "../validate";

const FACTS: WeekFacts = {
  meta: { season: 2024, week: 5, weekType: "regular", scoringPeriodId: 5, bracket: null },
  standings: [
    { franchiseId: 1, franchiseName: "Gridiron Gladiators", wins: 4, losses: 1, ties: 0, pointsFor: 512.4, rank: 1, rankMovement: 1 },
    { franchiseId: 2, franchiseName: "Blue Thunder", wins: 3, losses: 2, ties: 0, pointsFor: 498.1, rank: 2, rankMovement: -1 },
  ],
  matchups: [
    {
      matchupId: 1,
      home: { franchiseId: 1, franchiseName: "Gridiron Gladiators", score: 130.4, projected: 120.0, benchPointsLeft: 4.2 },
      away: { franchiseId: 2, franchiseName: "Blue Thunder", score: 100.1, projected: 110.5, benchPointsLeft: 25.6 },
      isFinal: true,
      margin: 30.3,
      topPerformers: [{ playerName: "Marcus Vance", franchiseName: "Gridiron Gladiators", points: 35.2 }],
      h2hAfter: "Gridiron Gladiators leads the all-time series 5-3.",
      contextNotes: ["Their fourth straight meeting decided by single digits."],
      belt: { atStake: true, result: "defense", holderName: "Gridiron Gladiators", challengerName: "Blue Thunder" },
    },
  ],
  superlatives: {
    topScore: { franchiseName: "Gridiron Gladiators", value: 130.4 },
    lowScore: { franchiseName: "Blue Thunder", value: 100.1 },
    closest: null,
    blowout: { winnerName: "Gridiron Gladiators", loserName: "Blue Thunder", margin: 30.3 },
    beatdown: { franchiseName: "Blue Thunder", opponentName: "Gridiron Gladiators", margin: -30.3 },
    benchDisaster: { franchiseName: "Blue Thunder", value: 25.6 },
    luckiestWin: { franchiseName: "Gridiron Gladiators", luckScore: 0.42 },
    bestEfficiency: { franchiseName: "Gridiron Gladiators", value: 0.91 },
  },
  records: {
    broken: [{ franchiseName: "Gridiron Gladiators", text: "Gridiron Gladiators set a new all-time high week score." }],
    approached: [{ recordKey: "closest_game", rank: 2, franchiseName: "Blue Thunder", value: 3.1 }],
  },
  transactions: {
    trades: [{ franchises: [{ franchiseName: "Gridiron Gladiators", sent: ["Deion Fields"], received: ["Casey Waiver"] }] }],
    notableAdds: [{ franchiseName: "Blue Thunder", playerName: "Sam Bench", points: 18.3 }],
  },
  playoffPicture: ["Blue Thunder holds the No. 2 seed at 3-2, right on the cutline."],
  commissionerNotes: "Trade deadline is next week.",
};

describe("validateRecap — clean draft", () => {
  it("the deterministic fallback renderer produces zero warnings against its own facts", () => {
    const markdown = renderFallbackRecap(FACTS);
    const warnings = validateRecap(markdown, FACTS);
    expect(warnings).toEqual([]);
  });

  it("a hand-written clean draft using only facts-sourced numbers and names produces zero warnings", () => {
    const markdown = `# Week 5 Recap

Gridiron Gladiators improved to 4-1 after a 130.4-100.1 win over Blue Thunder, a margin of 30.3.
Marcus Vance led all scorers with 35.2 points. Blue Thunder left 25.6 points on the bench.`;
    expect(validateRecap(markdown, FACTS)).toEqual([]);
  });
});

describe("validateRecap — doctored draft", () => {
  it("flags a fabricated score AND a fabricated player name", () => {
    const markdown = `# Week 5 Recap

Gridiron Gladiators crushed Blue Thunder 999.9-100.1, a margin of 899.8.
Rookie sensation Zeke Fakename put up video-game numbers for the winners.`;
    const warnings = validateRecap(markdown, FACTS);

    const numberWarnings = warnings.filter((w) => w.type === "number");
    const nameWarnings = warnings.filter((w) => w.type === "name");
    expect(numberWarnings.some((w) => w.text === "999.9")).toBe(true);
    expect(numberWarnings.some((w) => w.text === "899.8")).toBe(true);
    expect(nameWarnings.some((w) => w.text === "Zeke Fakename")).toBe(true);
  });

  it("never rejects — always returns an array, even for a wildly fabricated draft", () => {
    const markdown = "# Totally Made Up\n\nThe Imaginary Team beat the Fictional Squad 12345.6 to 0.";
    expect(() => validateRecap(markdown, FACTS)).not.toThrow();
    expect(Array.isArray(validateRecap(markdown, FACTS))).toBe(true);
  });

  it("does not flag whitelisted small integers (week numbers/rankings) or years", () => {
    const markdown = "# Week 5 Recap\n\nGridiron Gladiators are your No. 1 seed heading into 2024.";
    const warnings = validateRecap(markdown, FACTS);
    expect(warnings.filter((w) => w.type === "number")).toEqual([]);
  });

  it("tolerates rounding within ±0.1 of the facts value", () => {
    const markdown = "Gridiron Gladiators scored 130.35 points, right at their projection.";
    const warnings = validateRecap(markdown, FACTS);
    expect(warnings.filter((w) => w.type === "number")).toEqual([]);
  });

  it("flags a number that drifts more than ±0.1 from anything in the facts", () => {
    const markdown = "Gridiron Gladiators scored 130.9 points.";
    const warnings = validateRecap(markdown, FACTS);
    expect(warnings.some((w) => w.type === "number" && w.text === "130.9")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, I1: digit-bearing names + numbers quoted inside string facts fields
// ---------------------------------------------------------------------------

const DIGIT_NAME_FACTS: WeekFacts = {
  meta: { season: 2025, week: 17, weekType: "playoff", scoringPeriodId: 17, bracket: "playoff bracket" },
  standings: [{ franchiseId: 1, franchiseName: "Bonnie Blue 42", wins: 10, losses: 4, ties: 0, pointsFor: 1500.5, rank: 1, rankMovement: null }],
  matchups: [
    {
      matchupId: 1,
      home: { franchiseId: 1, franchiseName: "Bonnie Blue 42", score: 145.0, projected: 130.0, benchPointsLeft: 5.5 },
      away: null,
      isFinal: true,
      margin: null,
      topPerformers: [],
      h2hAfter: null,
      // "138.9" and "63" appear ONLY inside these strings — nowhere as a raw numeric field — so
      // this specifically exercises fix (b) (numbers quoted inside string-valued facts fields).
      contextNotes: [
        "Breaks the league record for highest score in a championship game (previously 138.9, 2020).",
        "The belt changes hands — 63rd reign for Bonnie Blue 42.",
      ],
      belt: null,
    },
  ],
  superlatives: { topScore: null, lowScore: null, closest: null, blowout: null, beatdown: null, benchDisaster: null, luckiestWin: null, bestEfficiency: null },
  records: { broken: [], approached: [] },
  transactions: { trades: [], notableAdds: [] },
  playoffPicture: null,
  commissionerNotes: null,
};

describe("validateRecap — digit-bearing names and quoted numbers (fix round 1, I1)", () => {
  it("a digit-bearing team name never false-positives on its own embedded number (I1a: masking)", () => {
    const markdown = "# Week 17 Recap\n\nBonnie Blue 42 exploded for 145.0 points this week.";
    expect(validateRecap(markdown, DIGIT_NAME_FACTS)).toEqual([]);
  });

  it("a number quoted verbatim inside a context note's string is treated as supported (I1b)", () => {
    const markdown =
      "# Week 17 Recap\n\nBreaks the league record for highest score in a championship game (previously 138.9, 2020). The belt changes hands — 63rd reign for Bonnie Blue 42.";
    expect(validateRecap(markdown, DIGIT_NAME_FACTS)).toEqual([]);
  });

  it("the deterministic fallback recap of a real digit-name + quoted-number fixture is zero warnings end to end", () => {
    const markdown = renderFallbackRecap(DIGIT_NAME_FACTS);
    expect(validateRecap(markdown, DIGIT_NAME_FACTS)).toEqual([]);
  });

  it("masking never hides a GENUINE fabrication that happens to sit near a digit-bearing name", () => {
    const markdown = "# Week 17 Recap\n\nBonnie Blue 42 exploded for 999.9 points, per Rookie Sensation Fakename.";
    const warnings = validateRecap(markdown, DIGIT_NAME_FACTS);
    expect(warnings.some((w) => w.type === "number" && w.text === "999.9")).toBe(true);
    expect(warnings.some((w) => w.type === "name" && w.text === "Rookie Sensation Fakename")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix round 1, I2: partial/malformed factsJson must never throw
// ---------------------------------------------------------------------------

describe("validateRecap — partial or missing facts never throws (fix round 1, I2)", () => {
  it("a facts object with only `meta` set (the exact shape actions.test.ts's own fixture uses) never throws", () => {
    const partialFacts = { meta: { season: 2024, week: 1, weekType: "regular" as const, scoringPeriodId: 1, bracket: null } };
    expect(() => validateRecap("# Week 1 Recap\n\nSomething happened.", partialFacts)).not.toThrow();
    expect(Array.isArray(validateRecap("# Week 1 Recap", partialFacts))).toBe(true);
  });

  it("an empty object never throws", () => {
    expect(() => validateRecap("# Week 1 Recap", {})).not.toThrow();
  });

  it("null and undefined facts never throw", () => {
    expect(() => validateRecap("# Week 1 Recap", null)).not.toThrow();
    expect(() => validateRecap("# Week 1 Recap", undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix round 2, I2: a {meta}-only row must never be read as "validated clean"
// ---------------------------------------------------------------------------

describe("isCompleteWeekFacts — structural completeness gate (fix round 2, I2)", () => {
  const META_ONLY_FACTS = { meta: { season: 2024, week: 1, weekType: "regular" as const, scoringPeriodId: 1, bracket: null } };

  it("false for a {meta}-only row — the exact shape that previously produced a silent false all-clear", () => {
    expect(isCompleteWeekFacts(META_ONLY_FACTS)).toBe(false);
  });

  it("false for an empty object, null, and undefined", () => {
    expect(isCompleteWeekFacts({})).toBe(false);
    expect(isCompleteWeekFacts(null)).toBe(false);
    expect(isCompleteWeekFacts(undefined)).toBe(false);
  });

  it("false when only standings/matchups are present but superlatives is missing", () => {
    expect(isCompleteWeekFacts({ standings: [], matchups: [] })).toBe(false);
  });

  it("true for a fully-shaped facts object (the real FACTS fixture used throughout this file)", () => {
    expect(isCompleteWeekFacts(FACTS)).toBe(true);
  });

  it(
    "page-logic level: the admin detail page's own decision order — a {meta}-only row must route to " +
      "'warnings unavailable', NEVER fall through to validateRecap and be read as a zero-warning all-clear",
    () => {
      // Mirrors admin/recaps/[id]/page.tsx's exact branching: check isCompleteWeekFacts FIRST.
      function decide(facts: unknown): { warnings: ReturnType<typeof validateRecap>; warningsUnavailable: boolean } {
        if (!isCompleteWeekFacts(facts as Parameters<typeof isCompleteWeekFacts>[0])) {
          return { warnings: [], warningsUnavailable: true };
        }
        return { warnings: validateRecap("# Week 1 Recap\n\nSomething happened.", facts as Parameters<typeof validateRecap>[1]), warningsUnavailable: false };
      }

      const partialResult = decide(META_ONLY_FACTS);
      expect(partialResult.warningsUnavailable).toBe(true);
      expect(partialResult.warnings).toEqual([]);

      const completeResult = decide(FACTS);
      expect(completeResult.warningsUnavailable).toBe(false);
    },
  );
});
