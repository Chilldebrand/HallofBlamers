/**
 * Task 29 — "add a mouseover explanation of each column to its header." No @testing-library/react
 * in this repo (vitest environment is "node", not jsdom) — renderToStaticMarkup gives a real HTML
 * string to assert `data-tip=` attributes against, same pattern as FranchiseName.test.tsx.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HeaderRow,
  LUCK_HEADERS,
  LUCK_HEADERS_PHONE,
  REAL_CAREER_HEADERS,
  REAL_SEASON_HEADERS,
  REAL_SEASON_HEADERS_PHONE,
} from "./columns";

/** React's static-markup serializer HTML-entity-escapes apostrophes in attribute values (`'` ->
 * `&#x27;`) — this mirrors that so the raw copy in columns.tsx can be asserted against the
 * rendered HTML string without every title needing to dodge apostrophes. */
function escapeAttr(value: string): string {
  return value.replace(/'/g, "&#x27;");
}

describe("HeaderRow", () => {
  it("every Real season header gets a data-tip tooltip, matching its visible label", () => {
    const html = renderToStaticMarkup(<HeaderRow columns={REAL_SEASON_HEADERS} gridCols="grid-cols-7" leftAlignCount={2} />);
    for (const col of REAL_SEASON_HEADERS) {
      expect(html).toContain(`data-tip="${escapeAttr(col.title)}"`);
    }
    expect(REAL_SEASON_HEADERS.map((c) => c.label)).toEqual(["#", "Franchise", "W-L-T", "PF", "PA", "Last 5", "Streak"]);
  });

  it("every Real career header gets a tooltip, and the career-only columns (Win %, Seasons, Champs, Sackos) have their own distinct copy", () => {
    const html = renderToStaticMarkup(<HeaderRow columns={REAL_CAREER_HEADERS} gridCols="grid-cols-9" leftAlignCount={2} />);
    for (const col of REAL_CAREER_HEADERS) {
      expect(html).toContain(`data-tip="${escapeAttr(col.title)}"`);
    }
    expect(REAL_CAREER_HEADERS.map((c) => c.label)).toEqual(["#", "Franchise", "W-L-T", "Win %", "PF", "PA", "Seasons", "Champs", "Sackos"]);
    // Career's W-L-T/PF/PA tooltips must read differently from the season table's (all-time vs.
    // this-season) — proves the two header sets don't accidentally share copy that would mislead.
    const seasonWlt = REAL_SEASON_HEADERS.find((c) => c.label === "W-L-T")!;
    const careerWlt = REAL_CAREER_HEADERS.find((c) => c.label === "W-L-T")!;
    expect(careerWlt.title).not.toBe(seasonWlt.title);
  });

  it("every merged Luck/All-Play header gets a tooltip, including the newly-merged All-Play record column", () => {
    const html = renderToStaticMarkup(<HeaderRow columns={LUCK_HEADERS} gridCols="grid-cols-7" />);
    for (const col of LUCK_HEADERS) {
      expect(html).toContain(`data-tip="${escapeAttr(col.title)}"`);
    }
    expect(LUCK_HEADERS.map((c) => c.label)).toEqual(["Franchise", "Luck", "Close Games", "Real %", "All-Play", "All-Play %", "Gap"]);
  });

  it("the Gap tooltip's sign language matches scheduleHelp()'s pinned convention (positive = the schedule flattered you)", () => {
    const gap = LUCK_HEADERS.find((c) => c.label === "Gap")!;
    expect(gap.title).toContain("Positive = the schedule flattered you");
  });

  it("the All-Play tooltip matches the brief's required phrasing (your record if you played every team every week)", () => {
    const allPlay = LUCK_HEADERS.find((c) => c.label === "All-Play")!;
    expect(allPlay.title.toLowerCase()).toContain("your record if you played every team every week");
  });

  it("the Luck tooltip matches the fix-round-1 user-directed copy (result vs. all-play's deserved win, not score vs. expected score)", () => {
    const luck = LUCK_HEADERS.find((c) => c.label === "Luck")!;
    expect(luck.title).toContain("The wins you got versus the wins your scores deserved");
    expect(luck.title).toContain("Positive = the schedule's been gifting you");
  });

  it("the Luck tooltip names the ±0.25 close-game kicker (weeklyLuck's closeSwing term) so it can't silently vanish from the copy again", () => {
    const luck = LUCK_HEADERS.find((c) => c.label === "Luck")!;
    expect(luck.title).toContain("±0.25");
    expect(luck.title).toContain("5 or fewer");
  });

  it("phone header sets are a same-copy subset of their desktop counterparts (no tooltip drift between the two)", () => {
    for (const phoneCol of REAL_SEASON_HEADERS_PHONE) {
      const desktopCol = REAL_SEASON_HEADERS.find((c) => c.label === phoneCol.label);
      expect(desktopCol).toBeDefined();
      expect(phoneCol.title).toBe(desktopCol!.title);
    }
    for (const phoneCol of LUCK_HEADERS_PHONE) {
      const desktopCol = LUCK_HEADERS.find((c) => c.label === phoneCol.label);
      expect(desktopCol).toBeDefined();
      expect(phoneCol.title).toBe(desktopCol!.title);
    }
  });

  it("right-aligns every column at/after leftAlignCount, left-aligns the leading ones", () => {
    const html = renderToStaticMarkup(<HeaderRow columns={REAL_SEASON_HEADERS} gridCols="grid-cols-7" leftAlignCount={2} />);
    // "#" and "Franchise" (first two) should NOT carry text-right; "W-L-T" onward should.
    const cells = html.split('role="columnheader"').slice(1);
    expect(cells[0]).not.toContain("text-right");
    expect(cells[1]).not.toContain("text-right");
    expect(cells[2]).toContain("text-right");
  });
});
