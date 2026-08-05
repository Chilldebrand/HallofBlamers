import { describe, expect, it } from "vitest";
import { formatWholeCommas, formatWinPctBaseball } from "./format";

describe("formatWinPctBaseball", () => {
  it("strips the leading zero and keeps 3 decimals", () => {
    expect(formatWinPctBaseball(0.625)).toBe(".625");
  });

  it("rounds to 3 decimals", () => {
    expect(formatWinPctBaseball(0.36666)).toBe(".367");
  });

  it("renders a winless record as .000, not a bare empty string", () => {
    expect(formatWinPctBaseball(0)).toBe(".000");
  });

  it("does not strip the leading digit for a perfect 1.000 record", () => {
    expect(formatWinPctBaseball(1)).toBe("1.000");
  });
});

describe("formatWholeCommas", () => {
  it("rounds to the nearest whole number and groups thousands", () => {
    expect(formatWholeCommas(12248.4)).toBe("12,248");
  });

  it("handles values under 1000 with no comma", () => {
    expect(formatWholeCommas(742.9)).toBe("743");
  });

  it("rounds 0 cleanly", () => {
    expect(formatWholeCommas(0)).toBe("0");
  });
});
