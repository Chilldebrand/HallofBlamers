import { describe, expect, it } from "vitest";
import { RECORD_KEYS } from "@/engines";
import { groupRecordSections, RECORD_GROUPS, RECORD_KEY_META, type RecordRow } from "../records";

function row(overrides: Partial<RecordRow>): RecordRow {
  return {
    recordKey: "highest_week_score",
    rank: 1,
    franchiseId: 1,
    franchiseName: "Team A",
    value: 100,
    season: 2020,
    week: 1,
    weekType: "regular",
    ...overrides,
  };
}

describe("RECORD_KEY_META", () => {
  it("has an entry for every RECORD_KEYS value, no more no less", () => {
    expect(Object.keys(RECORD_KEY_META).sort()).toEqual([...RECORD_KEYS].sort());
  });
});

describe("groupRecordSections", () => {
  it("produces the 5 groups in the documented order: single-week, season, streaks, belt, championship", () => {
    const sections = groupRecordSections([]);
    expect(sections.map((s) => s.group)).toEqual(["single-week", "season", "streaks", "belt", "championship"]);
    expect(sections.map((s) => s.groupLabel)).toEqual(RECORD_GROUPS.map((g) => g.label));
  });

  it("places every RECORD_KEY into exactly one group's section list", () => {
    const sections = groupRecordSections([]);
    const allKeys = sections.flatMap((g) => g.sections.map((s) => s.key));
    expect(allKeys.sort()).toEqual([...RECORD_KEYS].sort());
  });

  it("sorts each section's rows by rank ascending, independent of input order", () => {
    const rows = [
      row({ recordKey: "highest_week_score", rank: 3, franchiseId: 3 }),
      row({ recordKey: "highest_week_score", rank: 1, franchiseId: 1 }),
      row({ recordKey: "highest_week_score", rank: 2, franchiseId: 2 }),
    ];
    const sections = groupRecordSections(rows);
    const singleWeek = sections.find((s) => s.group === "single-week")!;
    const highestWeekSection = singleWeek.sections.find((s) => s.key === "highest_week_score")!;
    expect(highestWeekSection.rows.map((r) => r.franchiseId)).toEqual([1, 2, 3]);
  });

  it("honestly labels a consolation-week entry rather than dropping or relabeling it — real data case: 187.7", () => {
    const rows = [row({ recordKey: "highest_week_score", rank: 1, franchiseId: 4, value: 187.7, weekType: "consolation" })];
    const sections = groupRecordSections(rows);
    const entry = sections.flatMap((g) => g.sections).find((s) => s.key === "highest_week_score")!.rows[0]!;
    expect(entry.weekType).toBe("consolation");
    expect(entry.value).toBe(187.7);
  });

  it("leaves a key's rows empty (not omitted) when no record_entries exist for it yet", () => {
    const sections = groupRecordSections([row({ recordKey: "highest_week_score" })]);
    const belt = sections.find((s) => s.group === "belt")!;
    const beltSection = belt.sections.find((s) => s.key === "longest_belt_reign")!;
    expect(beltSection.rows).toEqual([]);
  });

  it("formats belt/championship groups distinctly from a plain points formatter", () => {
    expect(RECORD_KEY_META.longest_belt_reign.format(11)).toBe("11 weeks");
    expect(RECORD_KEY_META.highest_championship_score.format(150.4)).toBe("150.4 pts");
    expect(RECORD_KEY_META.best_season_record.format(0.75)).toBe("75.0%");
    expect(RECORD_KEY_META.longest_win_streak.format(8)).toBe("8 games");
    expect(RECORD_KEY_META.longest_win_streak.format(1)).toBe("1 game");
  });
});
