import { describe, expect, it } from "vitest";
import { computeSeasonPhase } from "../ticker";

describe("computeSeasonPhase (pure)", () => {
  it("defaults to offseason when there are no seasons at all", () => {
    expect(computeSeasonPhase([])).toBe("offseason");
  });

  it("is in-season when the newest season is active", () => {
    expect(
      computeSeasonPhase([
        { season: 2025, status: "complete" },
        { season: 2026, status: "active" },
      ]),
    ).toBe("in-season");
  });

  it("is offseason when the newest season is upcoming (draft not yet held)", () => {
    expect(
      computeSeasonPhase([
        { season: 2025, status: "complete" },
        { season: 2026, status: "upcoming" },
      ]),
    ).toBe("offseason");
  });

  it("is offseason when the newest season is already complete", () => {
    expect(computeSeasonPhase([{ season: 2025, status: "complete" }])).toBe("offseason");
  });

  it("looks only at the NEWEST season, regardless of input order", () => {
    expect(
      computeSeasonPhase([
        { season: 2026, status: "active" },
        { season: 2015, status: "complete" },
        { season: 2020, status: "complete" },
      ]),
    ).toBe("in-season");
  });
});
