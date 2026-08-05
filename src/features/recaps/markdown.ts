/**
 * A deliberately MINIMAL markdown parser for recap drafts — covers exactly what the guardrail
 * prompt and `renderFallbackRecap` actually produce (headings, paragraphs, unordered lists, and
 * `**bold**`/`_italic_` inline emphasis). No raw HTML pass-through: this only ever returns
 * structured block/inline data — the actual DOM text nodes are written by React in
 * `RecapMarkdownView`, which never uses `dangerouslySetInnerHTML`, so anything that looks like an
 * HTML tag in a draft (adversarial or not) renders as literal, escaped text rather than markup.
 */

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

/** Splits markdown into block-level elements. Pure — unit-tested directly. */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraphBuffer: string[] = [];
  let listBuffer: string[] = [];

  const flushParagraph = () => {
    if (paragraphBuffer.length > 0) {
      blocks.push({ type: "paragraph", text: paragraphBuffer.join(" ").trim() });
      paragraphBuffer = [];
    }
  };
  const flushList = () => {
    if (listBuffer.length > 0) {
      blocks.push({ type: "list", items: listBuffer });
      listBuffer = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: headingMatch[1]!.length as 1 | 2 | 3, text: headingMatch[2]!.trim() });
      continue;
    }

    const listMatch = /^[-*]\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      listBuffer.push(listMatch[1]!.trim());
      continue;
    }

    flushList();
    paragraphBuffer.push(line);
  }
  flushParagraph();
  flushList();

  return blocks;
}

export type InlineSegment = { text: string; bold: boolean; italic: boolean };

/** Splits a single line of text into styled runs on `**bold**` and `_italic_`/`*italic*` — no
 * nesting support (not needed for recap prose). Pure — unit-tested directly. */
export function parseInlineMarkdown(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const pattern = /\*\*(.+?)\*\*|_(.+?)_|\*(.+?)\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index), bold: false, italic: false });
    if (match[1] !== undefined) segments.push({ text: match[1], bold: true, italic: false });
    else if (match[2] !== undefined) segments.push({ text: match[2], bold: false, italic: true });
    else if (match[3] !== undefined) segments.push({ text: match[3], bold: false, italic: true });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex), bold: false, italic: false });
  return segments;
}
