import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginPage from "./page";

describe("LoginPage", () => {
  it("directs a member who lost their invite link to the commissioner", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Lost your link, or need one for the first time? Ask the commissioner.");
    expect(html).not.toContain("Richey");
  });
});
