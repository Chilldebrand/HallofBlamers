import { describe, expect, it } from "vitest";
import { computeDaysRemaining } from "../home";

describe("computeDaysRemaining", () => {
  it("returns 0 for the same UTC calendar day, regardless of time-of-day", () => {
    expect(computeDaysRemaining("2026-08-29", new Date("2026-08-29T23:59:00Z"))).toBe(0);
    expect(computeDaysRemaining("2026-08-29", new Date("2026-08-29T00:00:01Z"))).toBe(0);
  });

  it("counts whole days forward to a future date", () => {
    expect(computeDaysRemaining("2026-08-29", new Date("2026-08-04T12:00:00Z"))).toBe(25);
  });

  it("returns a negative number once the date has passed (never clamps here — display layer's job)", () => {
    expect(computeDaysRemaining("2026-08-01", new Date("2026-08-04T00:00:00Z"))).toBe(-3);
  });
});
