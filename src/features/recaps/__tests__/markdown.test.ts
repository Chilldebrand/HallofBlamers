import { describe, expect, it } from "vitest";
import { parseInlineMarkdown, parseMarkdownBlocks } from "../markdown";

describe("parseMarkdownBlocks", () => {
  it("parses headings at each level", () => {
    const blocks = parseMarkdownBlocks("# Title\n\n## Section\n\n### Subsection");
    expect(blocks).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "heading", level: 2, text: "Section" },
      { type: "heading", level: 3, text: "Subsection" },
    ]);
  });

  it("groups consecutive list items into one list block", () => {
    const blocks = parseMarkdownBlocks("- Alpha\n- Bravo\n- Charlie");
    expect(blocks).toEqual([{ type: "list", items: ["Alpha", "Bravo", "Charlie"] }]);
  });

  it("joins wrapped lines within a paragraph, blank line ends it", () => {
    const blocks = parseMarkdownBlocks("This is line one\nand this continues it.\n\nA new paragraph.");
    expect(blocks).toEqual([
      { type: "paragraph", text: "This is line one and this continues it." },
      { type: "paragraph", text: "A new paragraph." },
    ]);
  });

  it("never interprets raw HTML tags as anything but literal text", () => {
    const blocks = parseMarkdownBlocks("<script>alert(1)</script>");
    expect(blocks).toEqual([{ type: "paragraph", text: "<script>alert(1)</script>" }]);
  });

  it("a heading immediately followed by a paragraph on the next line stays two separate blocks", () => {
    const blocks = parseMarkdownBlocks("## Commissioner Notes\nTrade deadline is next week.");
    expect(blocks).toEqual([
      { type: "heading", level: 2, text: "Commissioner Notes" },
      { type: "paragraph", text: "Trade deadline is next week." },
    ]);
  });

  it("handles the fallback renderer's real shape end to end", () => {
    const markdown = "# Week 1 Recap\n\n## Standings\n1. Team A — 1-0, 130.0 pts\n\n## Matchups\n### Team A vs. Team B\nFinal: Team A 130.0 — Team B 100.0.";
    const blocks = parseMarkdownBlocks(markdown);
    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "Week 1 Recap" });
    expect(blocks.some((b) => b.type === "heading" && b.text === "Standings")).toBe(true);
    expect(blocks.some((b) => b.type === "heading" && b.level === 3 && b.text === "Team A vs. Team B")).toBe(true);
  });
});

describe("parseInlineMarkdown", () => {
  it("returns a single plain segment for text with no emphasis", () => {
    expect(parseInlineMarkdown("plain text")).toEqual([{ text: "plain text", bold: false, italic: false }]);
  });

  it("marks **bold** spans", () => {
    expect(parseInlineMarkdown("a **bold** word")).toEqual([
      { text: "a ", bold: false, italic: false },
      { text: "bold", bold: true, italic: false },
      { text: " word", bold: false, italic: false },
    ]);
  });

  it("marks _italic_ and *italic* spans", () => {
    expect(parseInlineMarkdown("_one_ and *two*")).toEqual([
      { text: "one", bold: false, italic: true },
      { text: " and ", bold: false, italic: false },
      { text: "two", bold: false, italic: true },
    ]);
  });
});
