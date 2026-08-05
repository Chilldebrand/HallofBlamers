/**
 * Task 21 — FranchiseName's variant rendering. No @testing-library/react in this repo (and the
 * vitest environment is "node", not jsdom) — renderToStaticMarkup gives a real HTML string to
 * assert against without adding either dependency, which is enough for "does this state render
 * this mark/color/text" checks (targeted snapshot style, per the task brief).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FranchiseName, type FranchiseNameFranchise, type FranchiseNameSize } from "./FranchiseName";

const base: FranchiseNameFranchise = {
  id: 1,
  name: "Gridiron Gladiators",
  isChampion: false,
  holdsBelt: false,
  isSacko: false,
  isViewer: false,
};

describe("FranchiseName", () => {
  it("renders a plain name with no marks when every flag is false", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={base} />);
    expect(html).toContain("Gridiron Gladiators");
    expect(html).not.toContain("text-gold-ink");
    expect(html).not.toContain("text-tarnish-ink");
    expect(html).not.toContain("SACKO");
    expect(html).not.toContain("YOU");
    expect(html).not.toContain("bg-gold-fill"); // no belt mark
  });

  it("champion: gold name, no badge", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, isChampion: true }} />);
    expect(html).toContain("text-gold-ink");
    expect(html).not.toContain("SACKO");
  });

  it("belt holder: renders the two-element belt mark (gold-fill bar + rotated cut-out diamond) before the name", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, holdsBelt: true }} surfaceBehind="var(--color-chrome-deep)" />);
    expect(html).toContain("bg-gold-fill");
    expect(html).toContain("rotate-45");
    expect(html).toContain("var(--color-chrome-deep)");
    // Mark comes before the name in document order.
    expect(html.indexOf("bg-gold-fill")).toBeLessThan(html.indexOf("Gridiron Gladiators"));
  });

  it("sacko: tarnish name + filled SACKO badge", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, isSacko: true }} />);
    expect(html).toContain("text-tarnish-ink");
    expect(html).toContain("bg-tarnish-fill");
    expect(html).toContain("SACKO");
  });

  it("viewer: kelly YOU tag", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, isViewer: true }} />);
    expect(html).toContain("text-kelly");
    expect(html).toContain("YOU");
  });

  it("champion + belt + viewer can co-occur without colliding (README: distinct signals)", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, isChampion: true, holdsBelt: true, isViewer: true }} />);
    expect(html).toContain("bg-gold-fill"); // belt mark
    expect(html).toContain("text-gold-ink"); // champion name color
    expect(html).toContain("YOU"); // viewer tag
    expect(html).not.toContain("SACKO");
  });

  it("champion never collides with sacko's tarnish treatment even if both flags were somehow true (champion wins the name color)", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, isChampion: true, isSacko: true }} />);
    expect(html).toContain("text-gold-ink");
    expect(html).not.toContain("text-tarnish-ink");
    expect(html).toContain("SACKO"); // badge is independent of name color
  });

  it("all six belt-mark sizes render their own distinct width/height", () => {
    const expected: Record<FranchiseNameSize, string> = {
      beltCard: "h-[20px] w-[44px]",
      matchupHeader: "h-[14px] w-[30px]",
      heading: "h-[12px] w-[26px]",
      default: "h-[11px] w-[24px]",
      inline: "h-[10px] w-[22px]",
      row: "h-[9px] w-[20px]",
    };
    for (const size of Object.keys(expected) as FranchiseNameSize[]) {
      const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, holdsBelt: true }} size={size} />);
      expect(html).toContain(expected[size]);
    }
  });

  it("truncates long names via a `truncate` class so it never breaks a fixed-width row", () => {
    const html = renderToStaticMarkup(<FranchiseName franchise={{ ...base, name: "A Very Long Franchise Name That Could Overflow" }} />);
    expect(html).toContain("truncate");
  });
});
