import { describe, expect, it } from "vitest";
import { weeklyLuck } from "../luck";

describe("weeklyLuck", () => {
  it("close win, strong all-play record: positive luck from the win, dampened by an already-high pAllPlay, plus the close-win swing", () => {
    // pAllPlay = 9/11 = 0.818181...; (1 - 0.818181...) + 0.25 = 0.431818...
    const luck = weeklyLuck({ result: 1, allPlayWins: 9, opponents: 11, margin: 3 });
    expect(luck).toBeCloseTo(0.4318181818, 9);
  });

  it("close loss, weak all-play record: negative luck plus the close-loss penalty", () => {
    // pAllPlay = 2/11 = 0.181818...; (0 - 0.181818...) - 0.25 = -0.431818...
    const luck = weeklyLuck({ result: 0, allPlayWins: 2, opponents: 11, margin: 4.5 });
    expect(luck).toBeCloseTo(-0.4318181818, 9);
  });

  it("blowout win beyond the close threshold: no swing bonus", () => {
    // pAllPlay = 10/11 = 0.909090...; (1 - 0.909090...) + 0 = 0.090909...
    const luck = weeklyLuck({ result: 1, allPlayWins: 10, opponents: 11, margin: 20 });
    expect(luck).toBeCloseTo(0.0909090909, 9);
  });

  it("tie never gets a close-swing adjustment, even with a 0 margin", () => {
    // pAllPlay = 5.5/11 = 0.5; (0.5 - 0.5) + 0 = 0
    const luck = weeklyLuck({ result: 0.5, allPlayWins: 5.5, opponents: 11, margin: 0 });
    expect(luck).toBeCloseTo(0, 9);
  });

  it("exactly at the 5.0 threshold still counts as close", () => {
    // pAllPlay = 6/11 = 0.545454...; (1 - 0.545454...) + 0.25 = 0.704545...
    const luck = weeklyLuck({ result: 1, allPlayWins: 6, opponents: 11, margin: 5.0 });
    expect(luck).toBeCloseTo(0.7045454545, 9);
  });

  it("just past the threshold (5.01) loses the close-swing bonus", () => {
    // pAllPlay = 6/11 = 0.545454...; (1 - 0.545454...) + 0 = 0.454545...
    const luck = weeklyLuck({ result: 1, allPlayWins: 6, opponents: 11, margin: 5.01 });
    expect(luck).toBeCloseTo(0.4545454545, 9);
  });

  it("no opponents to compare against: pAllPlay treated as 0, close-swing still applies", () => {
    // pAllPlay = 0 (guarded); (1 - 0) + 0.25 = 1.25
    const luck = weeklyLuck({ result: 1, allPlayWins: 0, opponents: 0, margin: 2 });
    expect(luck).toBeCloseTo(1.25, 9);
  });

  it("a loss just past the close threshold gets no penalty", () => {
    // pAllPlay = 3/11 = 0.272727...; (0 - 0.272727...) + 0 = -0.272727...
    const luck = weeklyLuck({ result: 0, allPlayWins: 3, opponents: 11, margin: 5.5 });
    expect(luck).toBeCloseTo(-0.2727272727, 9);
  });
});
