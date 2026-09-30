import { expect, test } from "vitest";
import { parseRoute, internalHref } from "../src/routing";

test("matchup deep links retain params and filters on a Pages reload", () => {
  expect(parseRoute("https://example.github.io/HallofBlamers/#/matchups/2026/1/42?tab=roster")).toEqual({
    route: "/matchups/:year/:week/:matchupId", params: { year: "2026", week: "1", matchupId: "42" }, query: { tab: "roster" },
  });
  expect(internalHref("/standings?season=2025")).toBe("#/standings?season=2025");
});

test("links cannot redirect to another origin or execute script", () => {
  expect(() => internalHref("//evil.example")).toThrow();
  expect(() => internalHref("javascript:alert(1)")).toThrow();
  expect(() => internalHref("/\\evil.example")).toThrow();
});

test("unknown and malformed routes resolve to not found", () => {
  expect(parseRoute("https://example.github.io/HallofBlamers/#/not-a-page").route).toBe("/404");
  expect(parseRoute("https://example.github.io/HallofBlamers/#/franchises/%ZZ").route).toBe("/404");
});
