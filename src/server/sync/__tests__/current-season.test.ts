import { describe, expect, it } from "vitest";
import { determineCurrentSeasonYear } from "../current-season";

describe("determineCurrentSeasonYear", () => {
  it("treats January as still belonging to the previous calendar year's season", () => {
    expect(determineCurrentSeasonYear(new Date("2026-01-15T12:00:00Z"))).toBe(2025);
  });

  it("treats February as still belonging to the previous calendar year's season", () => {
    expect(determineCurrentSeasonYear(new Date("2026-02-28T23:59:00Z"))).toBe(2025);
  });

  it("treats March onward as the current calendar year's season", () => {
    expect(determineCurrentSeasonYear(new Date("2026-03-01T00:00:00Z"))).toBe(2026);
  });

  it("treats August (mid-season prep) as the current calendar year's season", () => {
    expect(determineCurrentSeasonYear(new Date("2026-08-04T12:00:00Z"))).toBe(2026);
  });

  it("treats December as the current calendar year's season", () => {
    expect(determineCurrentSeasonYear(new Date("2026-12-25T12:00:00Z"))).toBe(2026);
  });

  it("uses UTC month boundaries consistently regardless of local timezone", () => {
    // 2026-02-28T23:59Z is still February in UTC even though it might be March 1 in some
    // local timezone — determineCurrentSeasonYear must read the UTC month, not local.
    expect(determineCurrentSeasonYear(new Date("2026-02-28T23:59:59Z")).toString()).toBe("2025");
  });
});
