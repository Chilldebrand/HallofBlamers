import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChampionBadge } from "./ChampionBadge";

describe("ChampionBadge", () => {
  it("renders the filled gold CHAMPION badge with a cream label", () => {
    const html = renderToStaticMarkup(<ChampionBadge />);
    expect(html).toContain("CHAMPION");
    expect(html).toContain("bg-gold-fill");
    expect(html).toContain("text-sheet");
  });

  it("merges an extra className", () => {
    const html = renderToStaticMarkup(<ChampionBadge className="ml-2" />);
    expect(html).toContain("ml-2");
  });
});
