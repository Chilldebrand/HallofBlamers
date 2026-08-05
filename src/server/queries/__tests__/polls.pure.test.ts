import { describe, expect, it } from "vitest";
import { computePollResults, findMatchingOption, normalizeLabelForDedupe } from "../polls";

describe("normalizeLabelForDedupe", () => {
  it("trims and lowercases", () => {
    expect(normalizeLabelForDedupe("  Saturday  ")).toBe("saturday");
    expect(normalizeLabelForDedupe("SATURDAY")).toBe("saturday");
  });
});

describe("findMatchingOption", () => {
  const options = [
    { id: 1, label: "Saturday" },
    { id: 2, label: "Sunday" },
  ];

  it("matches case-insensitively against ANY option, not just write-ins", () => {
    expect(findMatchingOption(options, "saturday")).toEqual({ id: 1, label: "Saturday" });
    expect(findMatchingOption(options, "  SUNDAY  ")).toEqual({ id: 2, label: "Sunday" });
  });

  it("returns undefined when nothing matches", () => {
    expect(findMatchingOption(options, "Monday")).toBeUndefined();
  });
});

describe("computePollResults", () => {
  const options = [
    { id: 1, label: "Saturday", sort: 0, isWriteIn: false },
    { id: 2, label: "Sunday", sort: 1, isWriteIn: false },
  ];

  it("counts votes and computes percentages of distinct voters", () => {
    const voteRows = [
      { optionId: 1, managerId: 10 },
      { optionId: 1, managerId: 11 },
      { optionId: 2, managerId: 12 },
    ];
    const results = computePollResults(options, voteRows, [10, 11, 12, 13], false);
    expect(results.totalVoters).toBe(3);
    expect(results.options).toEqual([
      { optionId: 1, label: "Saturday", isWriteIn: false, sort: 0, voteCount: 2, pct: (2 / 3) * 100 },
      { optionId: 2, label: "Sunday", isWriteIn: false, sort: 1, voteCount: 1, pct: (1 / 3) * 100 },
    ]);
  });

  it("lists non-voters as every manager id not present in voteRows", () => {
    const voteRows = [{ optionId: 1, managerId: 10 }];
    const results = computePollResults(options, voteRows, [10, 11, 12], false);
    expect(results.nonVoterManagerIds).toEqual([11, 12]);
  });

  it("percentages are 0, never NaN, when nobody has voted", () => {
    const results = computePollResults(options, [], [10, 11], false);
    expect(results.options.every((o) => o.pct === 0)).toBe(true);
    expect(results.totalVoters).toBe(0);
  });

  it("multi-choice: a manager voting for 2 options is one voter counted twice in option tallies", () => {
    const voteRows = [
      { optionId: 1, managerId: 10 },
      { optionId: 2, managerId: 10 },
    ];
    const results = computePollResults(options, voteRows, [10, 11], false);
    expect(results.totalVoters).toBe(1);
    expect(results.options.find((o) => o.optionId === 1)!.voteCount).toBe(1);
    expect(results.options.find((o) => o.optionId === 2)!.voteCount).toBe(1);
    // Percentages need not sum to 100 for a multi-choice poll.
    expect(results.options.find((o) => o.optionId === 1)!.pct).toBe(100);
    expect(results.options.find((o) => o.optionId === 2)!.pct).toBe(100);
  });

  it("perVoterBreakdown is null when anonymous is true — never computed, not just hidden", () => {
    const voteRows = [{ optionId: 1, managerId: 10 }];
    const results = computePollResults(options, voteRows, [10], true);
    expect(results.perVoterBreakdown).toBeNull();
  });

  it("perVoterBreakdown groups option ids per manager when not anonymous", () => {
    const voteRows = [
      { optionId: 1, managerId: 10 },
      { optionId: 2, managerId: 10 },
      { optionId: 1, managerId: 11 },
    ];
    const results = computePollResults(options, voteRows, [10, 11], false);
    expect(results.perVoterBreakdown).toEqual(
      expect.arrayContaining([
        { managerId: 10, optionIds: [1, 2] },
        { managerId: 11, optionIds: [1] },
      ]),
    );
  });

  it("options are sorted by `sort`, regardless of input order", () => {
    const unsorted = [
      { id: 2, label: "Sunday", sort: 1, isWriteIn: false },
      { id: 1, label: "Saturday", sort: 0, isWriteIn: false },
    ];
    const results = computePollResults(unsorted, [], [], false);
    expect(results.options.map((o) => o.optionId)).toEqual([1, 2]);
  });
});
