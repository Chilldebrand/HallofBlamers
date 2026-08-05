import { describe, expect, it } from "vitest";
import { isWithinLiveWindow, LIVE_WINDOWS } from "../live-window";

// Reference week, confirmed against real weekday names: 2026-09-02 Wed, 09-03 Thu, 09-04 Fri,
// 09-05 Sat, 09-06 Sun, 09-07 Mon, 09-08 Tue. All America/New_York is EDT (UTC-4) in September.

describe("isWithinLiveWindow", () => {
  it("is true at the Thursday window's opening boundary (20:00 ET) and false one minute before", () => {
    expect(isWithinLiveWindow(new Date("2026-09-03T20:00:00-04:00"))).toBe(true);
    expect(isWithinLiveWindow(new Date("2026-09-03T19:59:00-04:00"))).toBe(false);
  });

  it("is true through the Thursday window's closing boundary (23:59:59 ET) and false into Friday", () => {
    expect(isWithinLiveWindow(new Date("2026-09-03T23:59:59-04:00"))).toBe(true);
    expect(isWithinLiveWindow(new Date("2026-09-04T00:00:00-04:00"))).toBe(false);
  });

  it("Sunday window opens at 12:55 ET (5 minutes early), not 13:00", () => {
    expect(isWithinLiveWindow(new Date("2026-09-06T12:54:00-04:00"))).toBe(false);
    expect(isWithinLiveWindow(new Date("2026-09-06T12:55:00-04:00"))).toBe(true);
  });

  it("Sunday window stays open all afternoon/evening through 23:59 ET, closed by Monday midnight", () => {
    expect(isWithinLiveWindow(new Date("2026-09-06T16:00:00-04:00"))).toBe(true);
    expect(isWithinLiveWindow(new Date("2026-09-06T23:59:59-04:00"))).toBe(true);
    expect(isWithinLiveWindow(new Date("2026-09-07T00:00:00-04:00"))).toBe(false);
  });

  it("Monday window opens at 20:00 ET, not earlier in the day (Sunday's window doesn't bleed into Monday)", () => {
    expect(isWithinLiveWindow(new Date("2026-09-07T12:00:00-04:00"))).toBe(false);
    expect(isWithinLiveWindow(new Date("2026-09-07T19:59:00-04:00"))).toBe(false);
    expect(isWithinLiveWindow(new Date("2026-09-07T20:00:00-04:00"))).toBe(true);
    expect(isWithinLiveWindow(new Date("2026-09-07T23:59:59-04:00"))).toBe(true);
  });

  it("is false on non-window days entirely, any time of day", () => {
    expect(isWithinLiveWindow(new Date("2026-09-02T21:00:00-04:00"))).toBe(false); // Wednesday night
    expect(isWithinLiveWindow(new Date("2026-09-05T21:00:00-04:00"))).toBe(false); // Saturday night
    expect(isWithinLiveWindow(new Date("2026-09-08T21:00:00-04:00"))).toBe(false); // Tuesday night
  });

  it("respects the DST-adjusted America/New_York offset in winter (EST, UTC-5)", () => {
    // 2026-12-03 is a Thursday, EST in effect (confirmed: no DST in December).
    expect(isWithinLiveWindow(new Date("2026-12-03T20:00:00-05:00"))).toBe(true);
    expect(isWithinLiveWindow(new Date("2026-12-03T19:59:00-05:00"))).toBe(false);
    // The same absolute instant expressed in UTC still resolves correctly.
    expect(isWithinLiveWindow(new Date("2026-12-04T01:00:00Z"))).toBe(true); // == 2026-12-03T20:00:00-05:00
  });

  it("is unaffected by the machine's own local timezone (uses Intl against a fixed IANA zone, not local offset math)", () => {
    // A UTC instant that is Thursday 20:00 ET regardless of where this test runs.
    const instant = new Date("2026-09-04T00:00:00Z");
    expect(isWithinLiveWindow(instant)).toBe(true);
  });

  it("declares exactly the three named windows from the brief", () => {
    expect(LIVE_WINDOWS.map((w) => w.label)).toEqual(["Thursday Night Football", "Sunday", "Monday Night Football"]);
  });
});
