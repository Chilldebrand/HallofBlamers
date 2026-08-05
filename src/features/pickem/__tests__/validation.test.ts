import { describe, expect, it } from "vitest";
import { validatePickSubmission, type PickableMatchupOption } from "../validation";

const MATCHUPS: PickableMatchupOption[] = [
  { matchupId: 1, homeFranchiseId: 10, awayFranchiseId: 20 },
  { matchupId: 2, homeFranchiseId: 30, awayFranchiseId: 40 },
];

describe("validatePickSubmission", () => {
  it("accepts a complete, valid submission", () => {
    const submitted = new Map([
      [1, 10],
      [2, 40],
    ]);
    const result = validatePickSubmission(submitted, MATCHUPS);
    expect(result).toEqual({
      ok: true,
      value: [
        { matchupId: 1, pickedFranchiseId: 10 },
        { matchupId: 2, pickedFranchiseId: 40 },
      ],
    });
  });

  it("rejects a submission missing a pick for one matchup", () => {
    const submitted = new Map([[1, 10]]);
    const result = validatePickSubmission(submitted, MATCHUPS);
    expect(result).toEqual({ ok: false, error: "Pick a winner for every game before submitting." });
  });

  it("rejects a pick naming neither side of its own matchup (tampered/stale form)", () => {
    const submitted = new Map([
      [1, 999],
      [2, 30],
    ]);
    const result = validatePickSubmission(submitted, MATCHUPS);
    expect(result).toEqual({ ok: false, error: "Pick a winner for every game before submitting." });
  });

  it("ignores an extra matchupId not in the current pickable set", () => {
    const submitted = new Map([
      [1, 10],
      [2, 30],
      [999, 10],
    ]);
    const result = validatePickSubmission(submitted, MATCHUPS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it("rejects when there are no pickable matchups at all", () => {
    const result = validatePickSubmission(new Map(), []);
    expect(result).toEqual({ ok: false, error: "There's nothing to pick right now." });
  });
});
